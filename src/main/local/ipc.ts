import { resolve } from 'node:path';
import { app, dialog } from 'electron';
import { openFolderDialog } from '../dialogs';
import { pickerStartPath } from '../../core/pickerFolder';
import { guardedHandle, guardedOn, handleResult } from '../ipcGuard';
import {
  IpcChannels,
  LocalActiveSessionArg,
  LocalContextMenuRequestSchema,
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
  WorkspaceRenameSchema,
  SessionReorderArg,
  WorkspaceReorderSchema,
  type LocalContextMenuRequest,
  type LocalResult,
} from '../../shared/ipc';
import { log } from '../log';
import { handleLink } from '../routing';
import { fixtureOrigins, state, testMode } from '../state';
import { applyLayout } from '../window';
import { localScope } from '../../core/tabModel';
import { DevinLocalHost } from './acpHost';
import { LocalContextMenu } from './contextMenu';
import { renameWorkspace, reorderWorkspaces } from '../../core/workspaceTree';
import { autoOpenLocalPr } from './prAutoOpen';
import { getLocalState, publicLocalState } from './localState';
import { hosts } from '../hosts';
import { isWslHost } from '../../core/execHost';
import { setupTerminalIpc } from './terminalIpc';
import { terminalHost } from './terminalHost';

let host: DevinLocalHost | null = null;
let localContextMenu: LocalContextMenu | null = null;

export function localHost(): DevinLocalHost | null {
  return host;
}

export function localContextMenuItems(): Record<string, unknown>[] {
  return localContextMenu?.items() ?? [];
}

export function localContextMenuClick(id: string): { action: unknown } {
  return localContextMenu?.clickItem(id) ?? { action: null };
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
      // The sidebar reads workspaces from pushed settings — republish.
      applyLayout();
    },
    onPullRequestUrl: (url, sessionId) => {
      autoOpenLocalPr(url, localScope(sessionId), 'local-chat');
    },
    prLinkContext: { githubOrigins: fixtureOrigins },
    defaultMode: () => state.settings?.current.local.defaultMode ?? null,
  });
  setupTerminalIpc();
  app.on('before-quit', () => host?.dispose());
  // Spawn the configured workspaces' agents off the startup path: setupLocal
  // runs before the window exists, so a macrotask lets createWindow finish its
  // synchronous view construction first (the agents then list on ready).
  setTimeout(() => host?.startConfigured(), 0);

  const removeWorkspace = (path: string): void => {
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
  };
  const menu = new LocalContextMenu(localHost, terminalHost, removeWorkspace, applyLayout);
  localContextMenu = menu;

  guardedHandle(IpcChannels.localState, () => publicLocalState());

  guardedHandle(IpcChannels.localWorkspacePick, async (): Promise<LocalResult<string | null>> => {
    try {
      // Start the picker in local.pickerFolder when it exists, else in the
      // configured default WSL distro's home (ux3 S3 precedence).
      const local = state.settings?.current.local;
      const defaultDistro = local?.defaultWslDistro;
      const defaultHost = defaultDistro ? hosts().hostById(`wsl:${defaultDistro}`) : null;
      const distroHome =
        defaultHost && isWslHost(defaultHost) && defaultHost.home
          ? hosts().windowsPath(defaultHost, defaultHost.home)
          : undefined;
      const defaultPath = await pickerStartPath(local?.pickerFolder ?? null, distroHome, (p) => hosts().pathExists(p), () =>
        log('local', 'picker-folder-missing', { detail: { surface: 'local' } }),
      );
      const options: Electron.OpenDialogOptions = {
        title: 'Add workspace folder',
        properties: ['openDirectory'],
        ...(defaultPath ? { defaultPath } : {}),
      };
      const result = state.windowRef
        ? await openFolderDialog(state.windowRef, options)
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
    removeWorkspace(path);
    const order = { ...(state.settings?.current.local.sessionOrder ?? {}) };
    const normalized = resolve(path);
    if (path in order || normalized in order) {
      delete order[path];
      delete order[normalized];
      state.settings?.merge({ local: { sessionOrder: order } });
    }
    return null;
  });
  handleResult(IpcChannels.localWorkspaceReorder, WorkspaceReorderSchema, ({ paths }) => {
    const current = state.settings?.current.workspaces ?? [];
    const next = reorderWorkspaces(current, paths);
    if (next === current) return null;
    state.settings?.merge({ workspaces: next });
    requireHost().syncWorkspaces(next);
    applyLayout();
    log('local', 'local-workspace-reorder', { detail: { count: next.length } });
    return null;
  });
  handleResult(IpcChannels.localSessionReorder, SessionReorderArg, ({ section, ids }) => {
    const current = state.settings?.current.local.sessionOrder ?? {};
    const prev = current[section] ?? [];
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return null;
    state.settings?.merge({ local: { sessionOrder: { ...current, [section]: ids } } });
    applyLayout();
    const kind =
      section === 'pinned' || section === 'recent' || section === 'participated'
        ? section
        : 'folder';
    log('local', 'local-session-reorder', {
      detail: { section: kind, count: ids.length },
    });
    return null;
  });
  handleResult(IpcChannels.localWorkspaceRename, WorkspaceRenameSchema, ({ path, label }) => {
    const normalized = resolve(path);
    const labels = state.settings?.current.local.workspaceLabels ?? {};
    state.settings?.merge({
      local: { workspaceLabels: renameWorkspace(labels, normalized, label) },
    });
    applyLayout();
    log('local', 'local-workspace-rename', {});
    return null;
  });
  guardedHandle(IpcChannels.localContextMenu, (_event, payload: unknown) => {
    const parsed = LocalContextMenuRequestSchema.safeParse(payload);
    if (!parsed.success) return { action: null };
    return menu.popup(parsed.data as LocalContextMenuRequest);
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
