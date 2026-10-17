import { clipboard, webContents, WebContentsView } from 'electron';
import { cloudSessions } from './cloudSessions';
import { computeBounds } from '../core/layout';
import { clampFraction01, clampTerminalHeight } from '../core/layout';
import { auditCookies } from './cookieAudit';
import { refreshAnalyticsView } from './analytics';
import { cloudViews } from './cloudViews';
import { fromHostedView, fromShell, guardedHandle } from './ipcGuard';
import { terminalHost } from './local/terminalHost';
import type { Surface } from '../shared/ipc';
import { identityResolver } from './identity';
import { notificationStore } from './notifications';
import { notifier, openNotification, openPr, openPrs, openSessionPr } from './notifier';
import { prStore } from './prs';
import {
  updateAvailable,
  updateDownloaded,
  updateOnResume,
  updateOnWindowFocus,
} from './updater';
import { handleLink } from './routing';
import { copyTabAddress, reloadCurrentScope } from './ipc';
import { historyAction, navigationTarget, openNewSession } from './shortcuts';
import { state, testMode } from './state';
import { applyLayout, layoutState, publicState, setPaneOpen, setSessionsOpen } from './window';
import { shutdown } from './index';
import { localHost } from './local/ipc';
import { loadSdk } from './claude/sdk';
import { claudeSessions } from './claude/sessions';
import { publicLocalState } from './local/localState';

export function registerTestHooks(): void {
  if (!testMode) return;
  Object.assign(globalThis, {
    __devinworkspaces: {
      state: () => publicState(),
      open: (url: string) => {
        const id = state.tabManager?.open(url);
        if (!id) return '';
        setPaneOpen(true, 'test-open');
        applyLayout();
        return id;
      },
      routeLink: (url: string) => handleLink(url),
      activate: (id: string) => state.tabManager?.activate(id),
      close: (id: string) => state.tabManager?.close(id),
      reorder: (id: string, index: number) => state.tabManager?.reorder(id, index),
      // Also pin lastFocused: on a background CI desktop the OS 'focus' event
      // may never fire, which made the credential fill target non-deterministic.
      focus: (id: string) => {
        const contents = state.tabManager?.getView(id)?.webContents;
        if (!contents) return;
        state.lastFocused = contents;
        contents.focus();
      },
      setPaneOpen: (value: boolean) => setPaneOpen(value, 'test'),
      // Mirrors settings:set — stores the raw preference, layout applies the px guards.
      setPaneFraction: (value: number) => {
        state.paneFraction = clampFraction01(value);
        applyLayout();
      },
      setSurface: (value: Surface) => {
        const previous = state.surface;
        state.surface = value;
        if (value === 'analytics' && previous !== 'analytics') refreshAnalyticsView();
        applyLayout();
      },
      navigate: (action: 'back' | 'forward' | 'reload') => {
        const contents = navigationTarget();
        if (contents) historyAction(action, contents);
      },
      setBeforeUnloadDecision: (value: 'stay' | 'leave') => {
        process.env.DEVIN_WORKSPACES_TEST_BEFOREUNLOAD = value;
      },
      getShellWebContents: () => state.shellView?.webContents ?? null,
      getWebContentsCount: () => webContents.getAllWebContents().length,
      getWindowBounds: () => state.windowRef?.getBounds() ?? null,
      getContentBounds: () => state.windowRef?.getContentBounds() ?? null,
      setWindowSize: (width: number, height: number) => {
        state.windowRef?.setContentSize(width, height);
        applyLayout();
        return state.windowRef?.getContentBounds() ?? null;
      },
      loadDevinUrl: (url: string) => {
        state.devinView?.webContents.loadURL(url).catch(() => undefined);
      },
      getTabBounds: (id: string) => state.tabManager?.getView(id)?.getBounds() ?? null,
      getDevinBounds: () => state.devinView?.getBounds() ?? null,
      getAnalyticsBounds: () => state.analyticsView?.getBounds() ?? null,
      // Native view layering check: every contentView child with its bounds.
      childViews: () =>
        state.windowRef?.contentView.children.map((view) => ({
          bounds: view.getBounds(),
          url: view instanceof WebContentsView ? view.webContents.getURL() : null,
        })) ?? [],
      layoutRects: () =>
        computeBounds(
          state.windowRef?.getContentBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
          layoutState(),
        ),
      setSessionsOpen: (value: boolean) => setSessionsOpen(value, 'test'),
      getSessionsBounds: () =>
        computeBounds(
          state.windowRef?.getContentBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
          layoutState(),
        ).sessions,
      saveCredential: (credential: { origin: string; username: string; password: string }) =>
        state.credentials?.add(credential) ?? null,
      listCredentials: () => state.credentials?.list() ?? [],
      revealCredential: (id: string) => state.credentials?.reveal(id) ?? null,
      updateCredential: (id: string, patch: { username?: string; password?: string }) =>
        state.credentials?.update(id, patch) ?? null,
      deleteCredential: (id: string) => state.credentials?.delete(id) ?? false,
      // F4: would a foreign webContents (the devin view) pass the IPC guard?
      ipcProbe: () => {
        // A pooled NON-active Cloud view — must still pass the hosted-view
        // guard (a detached view's webContents is just as privileged).
        const pooled = cloudViews()
          .views()
          .map((v) => v.webContents)
          .find((wc) => wc !== state.devinView?.webContents);
        return {
          foreign: fromShell({ sender: state.devinView?.webContents, senderFrame: null } as never),
          shell: state.shellView
            ? fromShell({ sender: state.shellView.webContents, senderFrame: null } as never)
            : null,
          pooled: pooled
            ? fromHostedView({ sender: pooled, senderFrame: pooled.mainFrame } as never)
            : null,
        };
      },
      cloudViewsInfo: () => cloudViews().debugInfo(),
      // Load an arbitrary URL inside a pooled background view (bypasses the
      // router like loadURL does) — for probing ipc guards on a github-origin
      // fixture page, which the http fixture tenant can't satisfy.
      cloudViewLoadUrl: async (key: string, url: string) => {
        const target = cloudViews().viewForKey(key);
        if (!target) return false;
        await target.webContents.loadURL(url).catch(() => undefined);
        return true;
      },
      cloudShow: (id: string) => cloudSessions().openSession(id),
      cloudPrefetchHook: (id: string) => cloudSessions().prefetchSession(id),
      cloudIdleSweep: () => cloudViews().runIdleSweep('idle'),
      setCloudKeepAliveMs: (ms: number) => cloudViews().setKeepAliveMs(ms),
      auditCookies: () => auditCookies(),
      closeWindow: () => shutdown(),
      getTabWebContents: (id: string) => state.tabManager?.getView(id)?.webContents ?? null,
      openBackground: (url: string) => state.tabManager?.open(url, { background: true }) ?? '',
      discard: (id: string) => state.tabManager?.discard(id) ?? Promise.resolve(false),
      discardIdle: () => state.tabManager?.discardIdle() ?? Promise.resolve([]),
      setKeepAliveMs: (ms: number) => state.tabManager?.setKeepAliveMs(ms),
      getKeepAliveMs: () => state.tabManager?.keepAliveThresholdMs ?? null,
      listScopes: () => state.tabManager?.listScopes() ?? [],
      reloadScope: () => reloadCurrentScope(),
      copyTabAddress: (id: string) => copyTabAddress(id),
      // F1: inspect a tab in any scope (publicState only lists the visible scope).
      tabInfo: (id: string) => {
        const tab = state.tabManager?.getTab(id);
        if (!tab) return null;
        return {
          url: tab.url,
          originSessionId: tab.originSessionId ?? null,
          discarded: tab.discarded,
          loading: tab.loading,
          hasView: tab.view !== null,
        };
      },
      currentScope: () => state.tabManager?.currentScope ?? '',
      // P5: secrets / notifier hooks. setPat goes through the same store as
      // the IPC path; nothing here ever returns the token.
      setPat: async (pat: string) => {
        await state.secrets?.setPat(pat);
        notifier.restart('test-set-pat');
        return state.secrets?.hasPat() ?? false;
      },
      clearPat: async () => {
        await state.secrets?.clearPat();
        notifier.restart('test-clear-pat');
      },
      hasPat: () => state.secrets?.hasPat() ?? false,
      pollNow: () => notifier.pollNow(),
      // Cloud session sidebar data layer.
      cloudState: () => cloudSessions().snapshot(),
      cloudMutations: () => cloudSessions().mutationLog(),
      cloudMenuItems: () => cloudSessions().menuItems(),
      cloudMenuClick: (id: string) => cloudSessions().clickMenuItem(id), // returns {action}
      cloudRefresh: () => cloudSessions().refresh('test'),
      cloudNewSession: (folder: string | null) => cloudSessions().newSession(folder),
      cloudNoteHomeNavigation: (id: string) => cloudSessions().noteHomeNavigation(id),
      listPrs: () => openPrs(),
      openSessionPr: (sessionId: string, url: string) => openSessionPr(sessionId, url),
      prsPanelOpen: () => state.prsPanelOpen,
      prRecords: () => prStore().records(),
      prsOpen: (sessionId: string, url: string) => openPr(sessionId, url),
      // P6 notification center
      notifications: () => notificationStore().entries(),
      pushNotification: (partial: Record<string, unknown>) =>
        notificationStore().add({
          kind: 'waiting',
          sessionId: null,
          ownerUserId: null,
          sessionTitle: 'Devin Workspaces',
          title: 'Test',
          body: 'Test notification',
          createdAt: Date.now(),
          ...(partial as object),
        }).id,
      simulateUpdateDownloaded: (version: string) => updateDownloaded(version),
      simulateUpdateAvailable: (version: string) => updateAvailable(version),
      simulateUpdateFocus: () => updateOnWindowFocus(),
      simulateUpdateResume: () => updateOnResume(),
      panelOpen: () => state.notificationsPanelOpen,
      // Service-user identity resolution (never the raw user id).
      identity: () => identityResolver().current(),
      identityReset: () => {
        identityResolver().reset();
        notifier.restart('identity-reset');
      },
      notificationsOpen: (id: string) => openNotification(id),
      newSession: () => openNewSession(),
      // Devin Local (P4)
      localState: () => publicLocalState(),
      localAddWorkspace: (path: string) => localHost()?.addWorkspace(path) ?? null,
      localRemoveWorkspace: (path: string) => localHost()?.removeWorkspace(path),
      localNewSession: (workspace: string) => localHost()?.newSession(workspace),
      localPrompt: (sessionId: string, text: string) => localHost()?.prompt(sessionId, text),
      localCancel: (sessionId: string) => localHost()?.cancel(sessionId),
      localListSessions: (workspace: string) => localHost()?.listSessions(workspace),
      localLoadSession: (workspace: string, sessionId: string) =>
        localHost()?.loadSession(workspace, sessionId),
      localDeleteSession: (sessionId: string) => localHost()?.deleteSession(sessionId),
      localDeleteWorkspaceSessions: (workspace: string) =>
        localHost()?.deleteWorkspaceSessions(workspace),
      localAgentPid: (workspace: string) => localHost()?.agentPid(workspace) ?? null,
      // P4b terminal
      terminalOpen: (
        options:
          | { kind: 'devin'; workspace: string; sessionId: string }
          | { kind: 'shell'; cwd?: string },
      ) =>
        terminalHost.open(options),
      terminalList: () => terminalHost.list(),
      setTerminalOpen: (value: boolean) => {
        state.terminalOpen = value;
        applyLayout();
      },
      setTerminalHeight: (value: number) => {
        state.terminalHeight = clampTerminalHeight(
          value,
          state.windowRef?.getContentBounds().height ?? 900,
        );
        applyLayout();
      },
      terminalInput: (id: string, data: string) => terminalHost.write(id, data),
      terminalResize: (id: string, cols: number, rows: number) =>
        terminalHost.resize(id, cols, rows),
      terminalClose: (id: string) => terminalHost.close(id),
      terminalRead: (id: string) => terminalHost.read(id),
      terminalPid: (id: string) => terminalHost.pid(id),
      clipboardWrite: (text: string) => clipboard.writeText(text),
      clipboardRead: () => clipboard.readText(),
      // Claude sidebar (Phase 1 PR 3).
      claudeState: () => claudeSessions().snapshot(),
      claudeRefresh: () => claudeSessions().refresh('test'),
      claudeSelect: (id: string | null) => {
        if (id === null) {
          state.claudeSessionId = null;
          applyLayout();
          return;
        }
        claudeSessions().open(id);
      },
      claudeMenuItems: () => claudeSessions().menuItems(),
      claudeMenuClick: (id: string) => claudeSessions().clickMenuItem(id),
      claudeMutations: () => claudeSessions().mutationLog(),
      claudeConfigDir: () => claudeSessions().snapshot().configDir,
      claudeSdkProbe: async () => {
        const t0 = Date.now();
        try {
          const sdk = await loadSdk();
          return { ok: true, ms: Date.now() - t0, hasListSessions: typeof sdk.listSessions === 'function' };
        } catch {
          return { ok: false, ms: Date.now() - t0, hasListSessions: false };
        }
      },
    },
  });
  // Lets the shell page (and therefore the installed smoke spec, which cannot
  // evaluate in the main context over CDP) dispatch into the hooks above.
  // Test-mode only: this handler simply is not registered otherwise.
  guardedHandle('test:hook', (_event, name: unknown, args: unknown) => {
    const hooks = (globalThis as Record<string, unknown>).__devinworkspaces as
      | Record<string, unknown>
      | undefined;
    const fn = typeof name === 'string' ? hooks?.[name] : undefined;
    if (typeof fn !== 'function') return undefined;
    return (fn as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
  });
}
