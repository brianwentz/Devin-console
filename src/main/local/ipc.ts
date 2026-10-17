import { resolve } from 'node:path';
import { app, dialog } from 'electron';
import { guardedHandle, guardedOn, handleResult } from '../ipcGuard';
import {
  IpcChannels,
  LocalActiveSessionArg,
  LocalCancelArg,
  LocalOpenLinkArg,
  LocalPermissionArg,
  LocalPromptArg,
  LocalSessionDeleteAllArg,
  LocalSessionDeleteArg,
  LocalSessionListArg,
  LocalSessionLoadArg,
  LocalSessionNewArg,
  LocalWorkspaceArg,
  type LocalResult,
} from '../../shared/ipc';
import { log } from '../log';
import { handleLink } from '../routing';
import { fixtureOrigins, state, testMode } from '../state';
import { applyLayout } from '../window';
import { localScope } from '../../core/tabModel';
import { DevinLocalHost } from './acpHost';
import { autoOpenLocalPr } from './prAutoOpen';
import { getLocalState, publicLocalState } from './localState';
import { setupTerminalIpc } from './terminalIpc';
import { terminalHost } from './terminalHost';

let host: DevinLocalHost | null = null;

export function localHost(): DevinLocalHost | null {
  return host;
}

function requireHost(): DevinLocalHost {
  if (!host) throw new Error('local host not started');
  return host;
}

export function setupLocal(): void {
  const settings = state.settings;
  host = new DevinLocalHost({
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    testMode,
    devinPathOverride: settings?.current.local.devinPath ?? null,
    workspaces: settings?.current.workspaces ?? [],
    onWorkspacesChanged: (workspaces) => {
      state.settings?.merge({ workspaces });
    },
    onPullRequestUrl: (url, sessionId) => {
      autoOpenLocalPr(url, sessionId, 'local-chat');
    },
    prLinkContext: { githubOrigins: fixtureOrigins },
  });
  setupTerminalIpc();
  app.on('before-quit', () => host?.dispose());

  guardedHandle(IpcChannels.localState, () => publicLocalState());

  guardedHandle(IpcChannels.localWorkspacePick, async (): Promise<LocalResult<string | null>> => {
    try {
      const options: Electron.OpenDialogOptions = {
        title: 'Add workspace folder',
        properties: ['openDirectory'],
      };
      const result = state.windowRef
        ? await dialog.showOpenDialog(state.windowRef, options)
        : await dialog.showOpenDialog(options);
      const picked = result.canceled ? null : (result.filePaths[0] ?? null);
      if (!picked) return { ok: true as const, value: null };
      return { ok: true as const, value: requireHost().addWorkspace(picked) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handleResult(IpcChannels.localWorkspaceAdd, LocalWorkspaceArg, ({ path }) => requireHost().addWorkspace(path));
  handleResult(IpcChannels.localWorkspaceRemove, LocalWorkspaceArg, ({ path }) => {
    // Forget the lifted selection when its session lived in this workspace —
    // the sessions map is read before removeWorkspace drops it.
    const selectedWorkspace = state.localSessionId
      ? getLocalState().sessions[state.localSessionId]?.workspace
      : undefined;
    terminalHost.closeForWorkspace(path);
    requireHost().removeWorkspace(path);
    if (selectedWorkspace && resolve(selectedWorkspace) === resolve(path)) {
      state.localSessionId = null;
      applyLayout();
    }
    return null;
  });
  handleResult(IpcChannels.localSessionNew, LocalSessionNewArg, ({ workspace }) =>
    requireHost().newSession(workspace),
  );
  handleResult(IpcChannels.localSessionList, LocalSessionListArg, ({ workspace }) =>
    requireHost().listSessions(workspace),
  );
  handleResult(IpcChannels.localSessionLoad, LocalSessionLoadArg, async ({ workspace, sessionId }) => {
    await requireHost().loadSession(workspace, sessionId);
    return null;
  });
  // Per-id cleanup after a session is gone from local state: close its devin
  // pty, forget the lifted selection, and close its GitHub tab scope.
  const forgetDeletedSession = (sessionId: string): Promise<string[]> | undefined => {
    terminalHost.closeForSession(sessionId);
    if (state.localSessionId === sessionId) state.localSessionId = null;
    return state.tabManager?.closeScope(localScope(sessionId));
  };
  handleResult(IpcChannels.localSessionDelete, LocalSessionDeleteArg, async ({ sessionId }) => {
    await requireHost().deleteSession(sessionId);
    void forgetDeletedSession(sessionId)?.then(applyLayout);
    return null;
  });
  handleResult(IpcChannels.localSessionDeleteAll, LocalSessionDeleteAllArg, async ({ workspace }) => {
    const result = await requireHost().deleteWorkspaceSessions(workspace);
    await Promise.all(result.deleted.map((id) => forgetDeletedSession(id)));
    applyLayout();
    if (result.failed > 0) {
      throw new Error(
        `${result.failed} of ${result.deleted.length + result.failed} sessions could not be deleted`,
      );
    }
    return { deleted: result.deleted.length };
  });
  guardedOn(IpcChannels.localActiveSession, (_event, payload: unknown) => {
    const parsed = LocalActiveSessionArg.safeParse(payload);
    if (!parsed.success) return;
    state.localSessionId = parsed.data.sessionId;
    log('local', 'active-session', { detail: { sessionId: parsed.data.sessionId } });
    applyLayout();
  });
  handleResult(IpcChannels.localPrompt, LocalPromptArg, ({ sessionId, text }) =>
    requireHost().prompt(sessionId, text),
  );
  handleResult(IpcChannels.localCancel, LocalCancelArg, async ({ sessionId }) => {
    await requireHost().cancel(sessionId);
    return null;
  });
  handleResult(IpcChannels.localPermission, LocalPermissionArg, ({ sessionId, requestId, optionId }) => {
    requireHost().resolvePermission(sessionId, requestId, optionId);
    return null;
  });
  guardedOn(IpcChannels.localOpenLink, (_event, payload: unknown) => {
    const parsed = LocalOpenLinkArg.safeParse(payload);
    if (!parsed.success) return;
    log('local', 'link-click', { url: parsed.data.url });
    handleLink(parsed.data.url, 'local');
  });
}
