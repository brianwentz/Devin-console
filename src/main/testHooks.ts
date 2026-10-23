import { clipboard, webContents, WebContentsView } from 'electron';
import { request as httpRequest } from 'node:http';
import { cloudSessions } from './cloudSessions';
import { computeBounds } from '../core/layout';
import { clampFraction01, clampTerminalHeight } from '../core/layout';
import { auditCookies } from './cookieAudit';
import { refreshAnalyticsView } from './analytics';
import { cloudViews } from './cloudViews';
import { fromHostedView, fromShell, guardedHandle } from './ipcGuard';
import { terminalHost } from './local/terminalHost';
import type { Surface } from '../shared/ipc';
import type { HostId } from '../core/execHost';
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
import { handleLink, openUserUrl } from './routing';
import { copyTabAddress, reloadCurrentScope } from './ipc';
import { historyAction, navigationTarget, openNewSession } from './shortcuts';
import { lastOpenDialogOptions } from './dialogs';
import { lastFolderPrompt } from './folderPrompt';
import { favoritesMenuClick, favoritesMenuItems } from './favoritesMenu';
import { allPoolViews } from './cloudKit/pools';
import { state, testMode } from './state';
import {
  applyLayout,
  focusContents,
  layoutState,
  publicState,
  setPaneOpen,
  setSessionsOpen,
} from './window';
import { shutdown } from './index';
import { localContextMenuClick, localContextMenuItems, localHost } from './local/ipc';
import { loadSdk } from './claude/sdk';
import { claudeHost } from './claude/host';
import { claudeSessions } from './claude/sessions';
import { claudeUsage } from './claude/usage';
import { devinUsage } from './devinUsage';
import { getChatState, publicChatState } from './claude/chatState';
import { prTitles } from './prTitles';
import { publicLocalState } from './local/localState';
import { hosts } from './hosts';
import { openhandsBaseUrl, openhandsUsageSnapshot } from './openhandsConfig';
import {
  openhandsMenuClick,
  openhandsMenuItems,
  openhandsMutations,
  openhandsRefresh,
  openhandsState,
  openhandsUsageRefresh,
} from './providers/openhands';
import { openhandsOpenSession, openhandsViewsInfo, resetOpenHandsViews } from './openhands/views';
import { remoteFsViolationCount } from './remoteFsGuard';

export function registerTestHooks(): void {
  if (!testMode) return;
  Object.assign(globalThis, {
    __agentworkspace: {
      state: () => publicState(),
      lastOpenDialogOptions: () => lastOpenDialogOptions(),
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
        focusContents(contents, 'test-focus');
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
        process.env.AGENT_WORKSPACE_TEST_BEFOREUNLOAD = value;
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
      // Execution hosts (WSL) — enumeration, per-host status, env key names.
      hosts: () => hosts().statuses(),
      hostStatus: (id: string) => hosts().status(id as HostId),
      hostRefresh: (id?: string) => hosts().refresh(id as HostId | undefined),
      // The background-check re-list (stale-only, inside the failure backoff).
      hostEnumerateIfStale: () => hosts().enumerateIfStale(),
      hostShellEnvKeys: (id: string) => hosts().shellEnvKeys(id as HostId),
      // Helper channel: kill the live child (reconnect path) / lifecycle snapshot.
      hostHelperKill: (id: string) => hosts().killHelper(id),
      hostChannelState: (id: string) => hosts().channelInfo(id),
      // P3: ssh hosts + the in-app remote folder prompt.
      hostSshAdd: (alias: string) => hosts().addSshHost(alias),
      hostSshRecover: (trigger: 'resume' | 'unlock') => hosts().recoverSsh(trigger, { force: true }),
      hostHookForwardVerified: (id: string) => hosts().hookForwardVerified(id),
      // R39 #3: close the hook forward's stdin (what the app's death does) → the remote `cat` ends it.
      hostSshForwardEndStdin: (id: string) => hosts().sshForwardEndStdin(id),
      // execOn over a host (R36 #2 drain check): stdout of `file args…` run in the host home.
      hostExecOn: (id: string, file: string, args: string[]) => {
        const host = hosts().hostById(id);
        if (!host) throw new Error('unknown host');
        return hosts().execOn(host, { file, args, cwd: host.kind === 'local' ? process.cwd() : (host.home ?? '/') }, 30_000);
      },
      lastFolderPrompt: () => lastFolderPrompt(),
      // App-originated fs calls on a WSL path seen by the guard (launchApp
      // teardown asserts 0).
      remoteFsViolations: () => remoteFsViolationCount(),
      saveCredential: (credential: { origin: string; username: string; password: string }) =>
        state.credentials?.add(credential) ?? null,
      listCredentials: () => state.credentials?.list() ?? [],
      revealCredential: (id: string) => state.credentials?.reveal(id) ?? null,
      updateCredential: (id: string, patch: { username?: string; password?: string }) =>
        state.credentials?.update(id, patch) ?? null,
      deleteCredential: (id: string) => state.credentials?.delete(id) ?? false,
      // F4: would a foreign webContents (the devin view) pass the IPC guard?
      ipcProbe: (pooledId?: number) => {
        // A pooled NON-active Cloud view — must still pass the hosted-view
        // guard (a detached view's webContents is just as privileged). With a
        // webContents id (from cloudViewLoadUrl), probe exactly that view: the
        // pool order need not match the caller's pick, and the load rekeys it.
        const pooled = pooledId !== undefined
          ? webContents.fromId(pooledId)
          : allPoolViews()
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
        if (!target) return null;
        await target.webContents.loadURL(url).catch(() => undefined);
        return target.webContents.id;
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
      // Task 14: seed/clear the OpenHands API key (never returns it).
      secretsSetOpenHands: async (value: string | null) => {
        await state.secrets?.setOpenHandsApiKey(value);
      },
      // B1 T20: effective OpenHands base URL (AGENT_WORKSPACE_TEST_OPENHANDS_URL wins).
      openhandsBaseUrl: () => openhandsBaseUrl(),
      // B1 T21: OpenHands sidebar snapshot / force a full list (resolves when it finishes).
      openhandsState: () => openhandsState(),
      openhandsRefresh: () => openhandsRefresh(),
      // Analytics -> OpenHands usage cards; refresh opens the gate and resolves after one pass.
      openhandsUsageState: () => openhandsUsageSnapshot(),
      openhandsUsageRefresh: () => openhandsUsageRefresh(),
      // B1 T22: hosted views, menus and the recorded sidebar actions.
      openhandsViewsInfo: () => openhandsViewsInfo(),
      openhandsOpen: (id: string) => openhandsOpenSession(id),
      // Test-only shortcut for the base-URL-change reset (the real path: Settings + AGENT_WORKSPACE_TEST_OPENHANDS_URL_MAP).
      openhandsResetViews: () => resetOpenHandsViews(),
      openhandsMenuItems: () => openhandsMenuItems(),
      openhandsMenuClick: (id: string) => openhandsMenuClick(id), // returns {action}
      openhandsMutations: () => openhandsMutations(),
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
          sessionTitle: 'Agent Workspace',
          title: 'Test',
          body: 'Test notification',
          createdAt: Date.now(),
          ...(partial as object),
        }).id,
      simulateUpdateDownloaded: (version: string) => updateDownloaded(version),
      simulateUpdateAvailable: (version: string) => updateAvailable(version),
      simulateUpdateFocus: () => updateOnWindowFocus(),
      simulateUpdateResume: () => updateOnResume(),
      openUserUrl: (url: string, source: 'drop' | 'typed' | 'favorite', target: 'new' | 'current') =>
        openUserUrl(url, source, target),
      addressBar: () => ({ ...state.addressBar }),
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
      // Claude sidebar.
      claudeState: () => claudeSessions().snapshot(),
      claudeUsageState: () => claudeUsage().state,
      claudeUsageRefresh: () => claudeUsage().refresh(),
      devinUsageState: () => devinUsage().state,
      devinUsageRefresh: () => devinUsage().refresh(),
      claudeRefresh: () => claudeSessions().refresh('test'),
      // The status-driven (non-explicit) hooks apply that enumeration/probe changes run.
      claudeApplyHooks: () => claudeSessions().applyHooks(),
      claudeSelect: (id: string | null) => {
        if (id === null) {
          state.claudeSessionId = null;
          applyLayout();
          return;
        }
        claudeSessions().open(id);
      },
      favoritesMenuItems: () => favoritesMenuItems(),
      favoritesMenuClick: (id: string) => favoritesMenuClick(id),
      claudeMenuItems: () => claudeSessions().menuItems(),
      claudeMenuClick: (id: string) => claudeSessions().clickMenuItem(id),
      localMenuItems: () => localContextMenuItems(),
      localMenuClick: (id: string) => localContextMenuClick(id),
      claudeMutations: () => claudeSessions().mutationLog(),
      // Store mutations without the menu round-trip (WSL ones go over the channel).
      claudeRename: (id: string, title: string) => claudeSessions().rename(id, title),
      claudeDeleteTranscript: (id: string) => claudeSessions().sessionDeleteTranscript(id),
      claudeRevealTranscript: (id: string) => claudeSessions().revealTranscript(id),
      claudeRevealed: () => claudeSessions().revealedPaths(),
      claudeConfigDir: () => claudeSessions().snapshot().configDir,
      // Chat.
      claudeChatState: () => publicChatState(),
      claudeNewSession: (cwd: string | null) => claudeSessions().newSession(cwd),
      claudePrompt: (id: string, text: string) => claudeHost().prompt(id, text),
      claudeCancel: (id: string) => claudeHost().cancel(id),
      claudePermission: (id: string, requestId: string, optionId: string) =>
        claudeHost().respondPermission(id, requestId, optionId),
      claudeLiveCount: () => claudeHost().liveCount(),
      // Background agents + claude terminal.
      claudeAgents: () => claudeSessions().agentsList(),
      claudeAgentsRefresh: () => claudeSessions().refreshAgents(),
      // Claude PR tracking: record a PR on the registry, list a
      // session's recorded PRs, seed the title/state cache, force a refresh.
      claudeRecordPr: (sessionId: string, url: string) =>
        claudeSessions().recordPr(sessionId, url, 'hook'),
      claudePrs: (sessionId: string) => claudeSessions().prsOf(sessionId),
      claudeRefreshPrStates: () => claudeSessions().refreshPrStates('test'),
      prTitlesSeed: (url: string, info: { title: string | null; state: string | null }) =>
        prTitles.seed(url, { title: info.title, state: info.state as 'open' | 'draft' | 'merged' | 'closed' | null }),
      // Subagents + message ids + shutdown state.
      claudeSubagents: (sessionId: string) => claudeSessions().loadSubagents(sessionId),
      claudeOpenSubagent: (sessionId: string, agentId: string) =>
        claudeSessions().openSubagent(sessionId, agentId),
      claudeChatMessageIds: (sessionId: string) =>
        getChatState().sessions[sessionId]?.messages.map((m) => m.messageId ?? null) ?? [],
      shutdownState: () => ({ complete: state.shutdownComplete, inFlight: state.shuttingDown }),
      // Hook listener info (port + token for test POSTs), the
      // hook-derived activity map, a test POST against the listener, and the
      // path of <configDir>/settings.json (global install target).
      claudeHookInfo: () => claudeSessions().hookInfo(),
      claudeActivity: () => claudeSessions().activityMap(),
      claudeHooksSettingsPath: () => claudeSessions().hooksSettingsPath(),
      claudePostHook: async (event: string, body: unknown) => {
        const info = claudeSessions().hookInfo();
        if (!info) return { ok: false, status: 0 };
        return new Promise((resolve) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: info.port,
              path: `/agent-workspace/hook/${event}`,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${info.token}`,
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve({ ok: true, status: res.statusCode }));
            },
          );
          req.on('error', () => resolve({ ok: false, status: 0 }));
          req.end(JSON.stringify(body ?? {}));
        });
      },
      claudePostHookRaw: async (event: string, body: unknown, auth?: string) => {
        const info = claudeSessions().hookInfo();
        if (!info) return { ok: false, status: 0 };
        return new Promise((resolve) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: info.port,
              path: `/agent-workspace/hook/${event}`,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(auth !== undefined ? { authorization: auth } : {}),
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve({ ok: true, status: res.statusCode }));
            },
          );
          req.on('error', () => resolve({ ok: false, status: 0 }));
          req.end(JSON.stringify(body ?? {}));
        });
      },
      // POSTs to an arbitrary path on the hook server with the real bearer
      // token — covers the legacy `/devin-workspaces/hook/` prefix.
      claudePostHookPath: async (path: string, body: unknown) => {
        const info = claudeSessions().hookInfo();
        if (!info) return { ok: false, status: 0 };
        return new Promise((resolve) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: info.port,
              path,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${info.token}`,
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve({ ok: true, status: res.statusCode }));
            },
          );
          req.on('error', () => resolve({ ok: false, status: 0 }));
          req.end(JSON.stringify(body ?? {}));
        });
      },
      claudeTerminalOpen: (id: string) => {
        const mode = claudeSessions().terminalModeFor(id);
        return terminalHost.open({
          kind: 'claude',
          sessionId: id,
          mode,
          cwd: getChatState().sessions[id]?.cwd ?? null,
          ...(claudeSessions().hookInjection(id, mode) ?? {}),
        });
      },
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
  // test:hook — the one generic dispatch into the hooks above. The installed
  // smoke spec depends on it: Electron's browser CDP target cannot
  // Runtime.evaluate in the main process, so the spec reaches these hooks
  // through `agentworkspace.testHook(name, ...args)` from the shell page.
  // Test-mode only: this handler is not registered otherwise.
  guardedHandle('test:hook', (_event, name: unknown, args: unknown) => {
    const hooks = (globalThis as Record<string, unknown>).__agentworkspace as
      | Record<string, unknown>
      | undefined;
    const fn = typeof name === 'string' ? hooks?.[name] : undefined;
    if (typeof fn !== 'function') return undefined;
    return (fn as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
  });
}
