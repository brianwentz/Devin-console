// First import on purpose: bootstrap applies the userData override and moves
// the legacy `devin-workspaces` profile into it, before ./log (imported
// transitively below) resolves and mkdirs the dir.
import { migration } from './bootstrap';
// Second on purpose: the remote-fs guard is live before any other module loads.
import './remoteFsGuardInstall';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BaseWindow, dialog, Menu, powerMonitor, screen, session, webContents, WebContentsView } from 'electron';
import { clampFraction01 } from '../core/layout';
import { auditCookies, startCookieAudit } from './cookieAudit';
import { CredentialStore } from './credentials';
import { closeAutofillOverlaysForInactiveTabs, disposeAutofill, setupAutofillIpc } from './autofill';
import { setupDownloads } from './downloads';
import { setupIpc } from './ipc';
import { setupLocal, localHost } from './local/ipc';
import { setupClaude } from './claude/ipc';
import { disposeAll, runtimes } from './providers';
import { claudeSessions } from './claude/sessions';
import { hosts } from './hosts';
import { claudeUsage } from './claude/usage';
import { autoOpenLocalPr } from './local/prAutoOpen';
import { terminalHost } from './local/terminalHost';
import { log, logFile } from './log';
import { setPermissions } from './permissions';
import { installProtocol } from './protocol';
import { cloudSessions } from './cloudSessions';
import { cloudViews } from './cloudViews';
import { openhandsViews } from './openhands/views';
import { allPoolViews } from './cloudKit/pools';
import { SettingsStore } from './settings';
import { providerBySurface } from '../core/providers';
import { fixtureOrigins, quiet, state, testMode } from './state';
import { registerTestHooks } from './testHooks';
import { keepAliveMs, TabManager } from './tabs';
import { identityResolver } from './identity';
import { notificationStore, notificationsFlush } from './notifications';
import { usageAlertStore } from './usageAlerts';
import { devinUsage } from './devinUsage';
import { prStore, prsFlush } from './prs';
import { prLedger } from './prLedger';
import {
  hasDownloadedUpdate,
  quitAndInstall,
  restoreUpdateEntry,
  updateOnWindowFocus,
} from './updater';
import {
  applyLayout,
  cancelDrag,
  detachView,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH_CLOSED,
  MIN_WINDOW_WIDTH_OPEN,
  notifyShell,
} from './window';
import {
  attachPlacementTracking,
  initialWindowOptions,
  savePlacementNow,
} from './windowPlacement';
import { attachContextMenu } from './contextMenu';
import { attachRouting } from './routing';
import { setupUpdater } from './updater';
import { notifier } from './notifier';
import { SecretStore } from './secrets';
import { requestSettingsFlush } from './settingsFlush';
import { cancelFolderPrompt } from './folderPrompt';

// Windows toasts require an AppUserModelID; match electron-builder's appId.
if (process.platform === 'win32') app.setAppUserModelId('io.github.brianwentz.agent-workspace');

if (process.env.AGENT_WORKSPACE_SCALE) {
  app.commandLine.appendSwitch('force-device-scale-factor', process.env.AGENT_WORKSPACE_SCALE);
}
if (quiet) {
  // Keep rendering + timers at full speed for a window the OS treats as
  // occluded (opacity 0). appendSwitch merges into disable-features.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
app.enableSandbox();

const userData = app.getPath('userData');
mkdirSync(userData, { recursive: true });

if (migration.migrated) {
  log('shell', 'profile-migrated', { detail: migration.detail });
} else if (migration.error) {
  log('shell', 'profile-migration-failed', { detail: migration.detail });
}

function onBeforeUnload(tabId: string, event: Electron.Event): boolean {
  let leave = false;
  if (testMode) {
    leave = process.env.AGENT_WORKSPACE_TEST_BEFOREUNLOAD !== 'stay';
  } else {
    const options: Electron.MessageBoxSyncOptions = {
      type: 'warning',
      buttons: ['Close tab', 'Stay'],
      defaultId: 0,
      cancelId: 1,
      message: 'This page wants to prevent this tab from closing.',
    };
    const result = state.windowRef
      ? dialog.showMessageBoxSync(state.windowRef, options)
      : dialog.showMessageBoxSync(options);
    leave = result === 0;
  }
  if (leave) event.preventDefault();
  log(`gh:${tabId}`, 'beforeunload-prompt', { decision: leave ? 'close' : 'stay' });
  return leave;
}

// Set by the window 'close' handler when a second close arrives mid-shutdown
// (the close is prevented to keep cleanup running); on a vetoed shutdown the
// window is destroyed to honour the force-quit.
let closeDuringShutdown = false;

export async function shutdown(options: { installUpdate?: boolean } = {}): Promise<void> {
  if (state.shutdownPromise) return state.shutdownPromise;
  state.shuttingDown = true;
  state.shutdownPromise = (async () => {
    disposeAutofill();
    await requestSettingsFlush();
    // F8 stage 1 — probe: close live GitHub tabs honouring beforeunload; a veto
    // is recorded (no per-tab prompt) and resolved by one consolidated dialog.
    const probe = (await state.tabManager?.probe().catch(() => undefined)) ?? {
      live: 0,
      vetoed: [],
    };
    log('shell', 'shutdown-probe', { detail: { live: probe.live, vetoed: probe.vetoed.length } });
    if (probe.vetoed.length > 0) {
      const quit = testMode
        ? process.env.AGENT_WORKSPACE_TEST_BEFOREUNLOAD !== 'stay'
        : dialog.showMessageBoxSync(state.windowRef!, {
            type: 'warning',
            buttons: ['Quit', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: `${probe.vetoed.length} tab(s) have unsaved changes. Quit anyway?`,
          }) === 0;
      if (!quit) {
        log('shell', 'shutdown-vetoed', { detail: { vetoed: probe.vetoed } });
        state.shuttingDown = false;
        state.shutdownPromise = null;
        // A second close arrived while shutdown was in flight — honour it as a
        // force-quit so the app still exits after the veto.
        if (closeDuringShutdown) {
          closeDuringShutdown = false;
          state.windowRef?.destroy();
          // The view's webContents getter is undefined from here on — don't
          // rely on 'closed' having fired yet.
          state.shellView = null;
        }
        // The probe may have discarded the active tab — restore a tab in the
        // visible scope only (never pull a hidden-scope tab into the strip).
        state.tabManager?.restoreAfterProbeCancel(probe.vetoed);
        // Vetoed quit: the update entry must survive the cancelled shutdown.
        restoreUpdateEntry();
        applyLayout();
        return;
      }
    }
    // Detached self-kill on a 20 s fuse — spawned past the beforeunload veto
    // (a cancelled quit keeps running). Covers the observed wedge where the
    // Node loop dies mid-quit (Windows: quit starts after the window is
    // destroyed, the loop tears down, the process never exits — an in-loop
    // watchdog can't fire). A worker thread keeps its own loop alive; the
    // SIGKILL runs inside it. unref'd so it never delays a healthy exit, and
    // a finished process kills the worker anyway.
    try {
      const killer = new Worker(
        `setTimeout(() => { try { process.kill(process.pid, 'SIGKILL') } catch {} }, 20000)`,
        { eval: true },
      );
      killer.unref();
    } catch {
      // best-effort only — the in-loop watchdog at the tail is the primary net.
    }
    notifier.stop('window-close');
    cloudSessions().stop();
    if (state.dragging) cancelDrag(false, 'window-close');
    try {
      await auditCookies();
    } catch {
      // best effort at shutdown
    }
    // Local host dispose then the Claude host dispose (2 s race), in
    // registration order; each failure is logged and never aborts the quit.
    await disposeAll();
    // Not grouped into the runtimes' dispose(): devinUsage sits between the
    // Claude host and claudeUsage in today's order, and these three share one
    // try/catch.
    try {
      devinUsage().dispose();
      claudeUsage().dispose();
      claudeSessions().dispose();
    } catch (error) {
      log('shell', 'claude-dispose-error', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    // Helper channels (after their consumers): stdin EOF — the helper exits on
    // it — then a kill after a short grace.
    try {
      await hosts().stopChannels();
    } catch {
      // never veto the quit sequence
    }
    notificationsFlush();
    prsFlush();
    savePlacementNow();
    state.settings?.syncFromState();
    try {
      await terminalHost.dispose();
    } catch (error) {
      // Never let pty teardown veto the quit sequence.
      log('shell', 'terminal-dispose-failed', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    const contents = [
      state.shellView?.webContents,
      ...allPoolViews().map((view) => view.webContents),
      state.analyticsView?.webContents,
      ...(state.tabManager?.getViews().map((view) => view.webContents) ?? []),
    ].filter((item): item is Electron.WebContents => Boolean(item && !item.isDestroyed()));
    const before = webContents.getAllWebContents().length;
    log('shell', 'window-close-start', { detail: { webContentsCount: before } });
    state.tabManager?.dispose();
    for (const view of allPoolViews()) detachView(view);
    detachView(state.analyticsView);
    detachView(state.shellView);
    for (const item of contents) {
      if (!item.isDestroyed()) item.close();
    }
    await Promise.all(
      contents.map(
        (item) =>
          new Promise<void>((resolveDestroyed) => {
            if (item.isDestroyed()) return resolveDestroyed();
            const timeout = setTimeout(resolveDestroyed, 1200);
            item.once('destroyed', () => {
              clearTimeout(timeout);
              resolveDestroyed();
            });
          }),
      ),
    );
    const after = webContents.getAllWebContents().length;
    log('shell', 'window-close-complete', {
      detail: {
        webContentsCountBefore: before,
        webContentsCountAfter: after,
        survivors: webContents
          .getAllWebContents()
          .map((w) => ({ url: w.getURL(), type: w.getType() })),
      },
    });
    // Cleanup done — flip the flag so the second close (app.quit() → close
    // the window again) passes through instead of vetoing into another
    // shutdown.
    state.shutdownComplete = true;
    try {
      state.windowRef?.destroy();
      // The view's webContents getter is undefined from here on — don't rely
      // on 'closed' having fired yet.
      state.shellView = null;
    } catch (error) {
      // destroy() must never veto the exit path.
      log('shell', 'window-destroy-error', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    state.windowRef = null;
    // Normal Electron lifecycle: destroy the window, then quit (the earlier
    // close was vetoed for cleanup; shutdownComplete lets it through now).
    // When an update is downloaded, quitAndInstall is the exit instead —
    // autoInstallOnAppQuit runs inside it.
    if (options.installUpdate || hasDownloadedUpdate()) quitAndInstall();
    else {
      // Last-resort watchdog: if the quit lifecycle itself stalls (the
      // mid-quit app.quit() no-op hang — seen on Windows when a vetoed
      // quit left Electron mid-shutdown), force-exit rather than leak the
      // process.
      setTimeout(() => {
        log('shell', 'shutdown-exit-watchdog');
        process.exit(0);
      }, 5_000).unref();
      app.quit();
    }
  })();
  return state.shutdownPromise;
}

async function createWindow(): Promise<void> {
  state.settings = new SettingsStore(userData);
  notificationStore(userData);
  // Subscribed to every runtime's usage now, before any service can publish
  // (Devin's refresh() is callable before its start()); nothing is fetched here.
  usageAlertStore(userData).subscribe(runtimes().map((runtime) => runtime.usage));
  prStore(userData);
  prLedger(userData);
  identityResolver(userData, testMode);
  state.secrets = new SecretStore(userData);
  await state.secrets.load();
  setupLocal();
  setupClaude();
  const saved = state.settings.current;
  state.paneOpen = saved.pane.open;
  // Stored as-is (0..1); px guards are derived in computeBounds, not persisted.
  state.paneFraction = clampFraction01(saved.pane.fraction);
  state.terminalOpen = saved.layout.terminalOpen;
  state.terminalHeight = saved.layout.terminalHeight;
  state.sessionsOpen = saved.sessions.open;
  state.sessionsWidth = saved.sessions.width;
  if (testMode && process.env.AGENT_WORKSPACE_TEST_SESSIONS_OPEN !== undefined) {
    state.sessionsOpen = process.env.AGENT_WORKSPACE_TEST_SESSIONS_OPEN === '1';
  }
  terminalHost.onChange = notifyShell;
  terminalHost.onPullRequestUrl = (url, target) => {
    if (target.source === 'claude-terminal') {
      const prefix = providerBySurface('claude')!.scopePrefix;
      const sessionId = target.scope.startsWith(prefix)
        ? target.scope.slice(prefix.length)
        : target.scope;
      claudeSessions().recordPr(sessionId, url, 'terminal');
    }
    autoOpenLocalPr(url, target.scope, target.source);
  };
  // Exclusive handoff: `devin -r` ptys take the CLI's per-session lock; the acp
  // agent releases it (restart) on open and reclaims the session on close.
  terminalHost.sessionGate = {
    release: (sessionId) => localHost()?.releaseSessionForTerminal(sessionId) ?? Promise.resolve(),
    reclaim: (sessionId) =>
      localHost()?.reclaimSessionFromTerminal(sessionId) ?? Promise.resolve(),
  };
  state.surface = saved.surface;
  // Env override wins over the persisted tenant URL (tests rely on it).
  state.tenantUrl = process.env.AGENT_WORKSPACE_TENANT_URL ?? saved.tenantUrl;
  state.credentials = new CredentialStore(
    join(userData, 'credentials.json'),
    undefined,
    fixtureOrigins,
    (event, detail) => log('shell', event, { detail }),
  );

  const devinSession = session.fromPartition('persist:cloud');
  const githubSession = session.fromPartition('persist:github');
  const openhandsSession = session.fromPartition('persist:openhands');
  setPermissions(devinSession, 'devin', 'persist:cloud');
  setPermissions(openhandsSession, 'openhands', 'persist:openhands');
  setPermissions(githubSession, 'gh:session');
  setupDownloads(githubSession);

  // F2: restore bounds for this display configuration; otherwise 1400x900 and
  // the OS picks the position (no center()).
  const { restored, ...placementOptions } = initialWindowOptions();
  state.windowRef = new BaseWindow({
    ...placementOptions,
    minWidth: saved.pane.open ? MIN_WINDOW_WIDTH_OPEN : MIN_WINDOW_WIDTH_CLOSED,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'Agent Workspace',
    show: !quiet,
    titleBarStyle: 'hidden',
    backgroundColor: '#111827',
    titleBarOverlay: { color: '#101722', symbolColor: '#e8edf5', height: 36 },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
  });
  if (restored?.maximized) state.windowRef.maximize();
  attachPlacementTracking(state.windowRef);

  // Test mode: Chromium clamps creation bounds to the work area, which on
  // small CI displays (1024x768) auto-collapses the pane and silently breaks
  // pane-dependent specs. A post-creation setContentSize is not clamped on
  // Windows — force it and log what we actually got for the fail-fast check.
  // With the hidden title bar the content size is (≈) the window size.
  if (testMode) {
    const match = /^(\d+)x(\d+)$/.exec(
      process.env.AGENT_WORKSPACE_TEST_WINDOW_SIZE ?? '1400x900',
    );
    if (match) {
      const [w, h] = [Number(match[1]), Number(match[2])];
      state.windowRef.setContentSize(w, h);
      state.windowRef.center();
      if (quiet) {
        // Invisible + unactivated: nothing in the suite needs the window seen
        // or focused — screenshots and input go through CDP.
        state.windowRef.setOpacity(0);
        state.windowRef.setSkipTaskbar(true);
        state.windowRef.showInactive();
        log('shell', 'window-quiet', { detail: { opacity: 0, skipTaskbar: true } });
      }
      log('shell', 'window-size', {
        detail: {
          requested: { w, h },
          actual: state.windowRef.getContentBounds(),
          display: screen.getPrimaryDisplay().workAreaSize,
        },
      });
    }
  }

  state.shellView = new WebContentsView({
    webPreferences: {
      preload: resolve(app.getAppPath(), 'out', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  state.shellView.setBackgroundColor('#111827');
  state.windowRef.contentView.addChildView(state.shellView);
  attachRouting(state.shellView.webContents, 'shell');
  attachContextMenu(state.shellView.webContents);
  // Pooled Cloud views replace the single devinView — init creates the 'home'
  // view (keyed by the session URL it currently shows) and loads the tenant.
  cloudViews().init(state.tenantUrl);
  cloudViews().applyLimits(); // sessions.maxLiveViews / keepAliveHours
  // Registered now (not on first use) so pools() lists it for permissions,
  // autofill and the cookie audit; it creates no view — so no request —
  // until the user enters the OpenHands surface.
  openhandsViews().applyLimits(); // openhands.maxLiveViews / keepAliveHours
  // Stays named: it runs pre-loadURL, before TabManager creation, so it can't
  // join the post-loadURL runtime start loop without reordering.
  cloudSessions().start();

  state.tabManager = new TabManager({
    parent: state.windowRef.contentView,
    session: githubSession,
    log: (event, detail, url) => log('shell', event, { detail, url }),
    onCreated: (tabId, view) => attachRouting(view.webContents, `gh:${tabId}`),
    onChange: notifyShell,
    onBeforeUnload,
    preload: resolve(app.getAppPath(), 'out', 'autofill-preload.cjs'),
    onActiveChanged: closeAutofillOverlaysForInactiveTabs,
    initialTabs: saved.tabSnapshot,
    testMode,
    keepAliveMs: keepAliveMs(saved.tabs.keepAliveHours),
    maxLiveTabs: saved.tabs.maxLiveTabs,
  });

  // A reload / navigation drops the renderer that would answer an open
  // remote folder prompt (R39 #12) — resolve it as cancelled.
  state.shellView.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) cancelFolderPrompt();
  });
  state.shellView.webContents.on('did-finish-load', () => {
    log('shell', 'shell-ready', { url: state.shellView?.webContents.getURL() });
    notifyShell();
  });
  state.shellView.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('shell', 'console-message', {
      detail: { level, message, line, sourceId },
    });
  });
  state.windowRef.on('resize', applyLayout);
  // Re-poll immediately on focus while the poller is in error (backoff drop).
  state.windowRef.on('focus', () => {
    for (const runtime of runtimes()) runtime.onFocus?.();
    hosts().onWindowFocus();
    updateOnWindowFocus();
  });
  // ssh hosts whose connection failed (sleep / network change) retry on wake
  // (throttled ≤1/min in hosts().recoverSsh).
  powerMonitor.on('resume', () => hosts().recoverSsh('resume'));
  powerMonitor.on('unlock-screen', () => hosts().recoverSsh('unlock'));
  state.windowRef.on('close', (event) => {
    // Post-shutdown lifecycle: app.quit() closes the window again — let it.
    if (state.shutdownComplete) return;
    // A second close while shutdown is in flight (e.g. a repeat app.quit())
    // must not destroy the window — that would cut in-flight cleanup (settings
    // flush, teardown) short via 'window-all-closed'. It's remembered instead
    // and honoured as a force-quit if the shutdown vetoes.
    if (state.shuttingDown) {
      event.preventDefault();
      closeDuringShutdown = true;
      return;
    }
    event.preventDefault();
    void shutdown();
  });
  state.windowRef.on('closed', () => {
    log('shell', 'window-closed');
    state.windowRef = null;
    // The shell view dies with the window; late publishes must see null, not
    // a view whose webContents getter already returns undefined.
    state.shellView = null;
    // Nothing is left to answer an open remote folder prompt (R39 #12).
    cancelFolderPrompt();
  });

  const activeId = state.tabManager.activeId;
  if (activeId) state.tabManager.activate(activeId);
  // Restored GLOBAL-scope tabs load in the background; the devin view's
  // navigation to a session triggers setScope → preload for that scope.
  state.tabManager.preloadVisibleScope();
  applyLayout();
  await state.shellView.webContents.loadURL('app://shell/index.html');
  // Eager start so usage alerts don't depend on visiting the Analytics tab
  // (the hidden cadence is already 10 min). devin-cloud then claude; Local
  // agents autostart from setupLocal()/acpHost.
  for (const runtime of runtimes()) runtime.start();
  registerTestHooks();
  startCookieAudit();
  // Stays named after startCookieAudit: moving it into the cloud start would
  // run it before registerTestHooks()/startCookieAudit().
  notifier.start();
  log('shell', 'window-created', {
    url: state.tenantUrl,
    detail: { userData, logFile, testMode, fixtureOrigins },
  });
}

app
  .whenReady()
  .then(() => {
    Menu.setApplicationMenu(null);
    installProtocol();
    setupIpc();
    setupAutofillIpc();
    return createWindow();
  })
  .catch((error: unknown) => {
    log('shell', 'startup-error', { detail: { message: String(error) } });
    app.quit();
  });

app.on('activate', () => {
  if (!state.windowRef) void createWindow();
});
// During shutdown the window destroy() re-enters window-all-closed — let the
// shutdown tail issue the single quit instead of starting an in-flight quit
// sequence mid-destroy that can stall (Windows: quit starts, the loop tears
// down, the process never exits).
app.on('window-all-closed', () => {
  if (!state.shuttingDown) app.quit();
});
app.whenReady().then(setupUpdater, () => undefined);
