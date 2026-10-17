import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BaseWindow, dialog, Menu, screen, session, webContents, WebContentsView } from 'electron';
import { clampFraction01 } from '../core/layout';
import { auditCookies, startCookieAudit } from './cookieAudit';
import { CredentialStore } from './credentials';
import { closeAutofillOverlaysForInactiveTabs, disposeAutofill, setupAutofillIpc } from './autofill';
import { setupDownloads } from './downloads';
import { setupIpc } from './ipc';
import { setupLocal, localHost } from './local/ipc';
import { setupClaude } from './claude/ipc';
import { claudeHost } from './claude/host';
import { claudeSessions } from './claude/sessions';
import { autoOpenLocalPr } from './local/prAutoOpen';
import { terminalHost } from './local/terminalHost';
import { log, logFile } from './log';
import { setPermissions } from './permissions';
import { installProtocol } from './protocol';
import { cloudSessions } from './cloudSessions';
import { cloudKeepAliveMs, cloudViews } from './cloudViews';
import { SettingsStore } from './settings';
import { localScope } from '../core/tabModel';
import { fixtureOrigins, state, testMode } from './state';
import { registerTestHooks } from './testHooks';
import { keepAliveMs, TabManager } from './tabs';
import { identityResolver } from './identity';
import { notificationStore, notificationsFlush } from './notifications';
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

// Windows toasts require an AppUserModelID; match electron-builder's appId.
if (process.platform === 'win32') app.setAppUserModelId('ai.devin.workspaces');

if (process.env.DEVIN_WORKSPACES_SCALE) {
  app.commandLine.appendSwitch('force-device-scale-factor', process.env.DEVIN_WORKSPACES_SCALE);
}
app.enableSandbox();

const requestedUserData = process.env.DEVIN_WORKSPACES_USER_DATA;
if (requestedUserData) app.setPath('userData', resolve(requestedUserData));

const userData = app.getPath('userData');
mkdirSync(userData, { recursive: true });

function onBeforeUnload(tabId: string, event: Electron.Event): boolean {
  let leave = false;
  if (testMode) {
    leave = process.env.DEVIN_WORKSPACES_TEST_BEFOREUNLOAD !== 'stay';
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
        ? process.env.DEVIN_WORKSPACES_TEST_BEFOREUNLOAD !== 'stay'
        : dialog.showMessageBoxSync(state.windowRef!, {
            type: 'warning',
            buttons: ['Quit', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: `${probe.vetoed.length} GitHub tab(s) have unsaved changes. Quit anyway?`,
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
    notifier.stop('window-close');
    cloudSessions().stop();
    if (state.dragging) cancelDrag(false, 'window-close');
    try {
      await auditCookies();
    } catch {
      // best effort at shutdown
    }
    localHost()?.dispose();
    await claudeHost().dispose();
    claudeSessions().dispose();
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
      ...cloudViews().views().map((view) => view.webContents),
      state.analyticsView?.webContents,
      ...(state.tabManager?.getViews().map((view) => view.webContents) ?? []),
    ].filter((item): item is Electron.WebContents => Boolean(item && !item.isDestroyed()));
    const before = webContents.getAllWebContents().length;
    log('shell', 'window-close-start', { detail: { webContentsCount: before } });
    state.tabManager?.dispose();
    for (const view of cloudViews().views()) detachView(view);
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
    try {
      state.windowRef?.destroy();
    } catch (error) {
      // destroy() must never veto the exit path.
      log('shell', 'window-destroy-error', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    state.windowRef = null;
    // app.quit() can be dropped while a quit is already in flight (the window
    // close was vetoed to run this cleanup); exit is unconditional. When an
    // update is downloaded, quitAndInstall is the exit — app.exit() would skip
    // the quit lifecycle and autoInstallOnAppQuit would never run.
    if (options.installUpdate || hasDownloadedUpdate()) quitAndInstall();
    else {
      // Observed on Windows/Electron 44: when the first quit was already in
      // flight (the close that started this cleanup was vetoed), app.exit()
      // can block or return without exiting. Best-effort fallback only; the
      // normal path exits inside app.exit().
      setTimeout(() => {
        log('shell', 'shutdown-exit-watchdog');
        process.exit(0);
      }, 5_000).unref();
      app.exit(0);
    }
  })();
  return state.shutdownPromise;
}

async function createWindow(): Promise<void> {
  state.settings = new SettingsStore(userData);
  notificationStore(userData);
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
  if (testMode && process.env.DEVIN_WORKSPACES_TEST_SESSIONS_OPEN !== undefined) {
    state.sessionsOpen = process.env.DEVIN_WORKSPACES_TEST_SESSIONS_OPEN === '1';
  }
  terminalHost.onChange = notifyShell;
  terminalHost.onPullRequestUrl = (url, target) => {
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
  state.tenantUrl = process.env.DEVIN_WORKSPACES_TENANT_URL ?? saved.tenantUrl;
  state.credentials = new CredentialStore(
    join(userData, 'credentials.json'),
    undefined,
    fixtureOrigins,
    (event, detail) => log('shell', event, { detail }),
  );

  const devinSession = session.fromPartition('persist:devin');
  const githubSession = session.fromPartition('persist:github');
  setPermissions(devinSession, 'devin');
  setPermissions(githubSession, 'gh:session');
  setupDownloads(githubSession);

  // F2: restore bounds for this display configuration; otherwise 1400x900 and
  // the OS picks the position (no center()).
  const { restored, ...placementOptions } = initialWindowOptions();
  state.windowRef = new BaseWindow({
    ...placementOptions,
    minWidth: saved.pane.open ? MIN_WINDOW_WIDTH_OPEN : MIN_WINDOW_WIDTH_CLOSED,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'Devin Workspaces',
    show: true,
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
      process.env.DEVIN_WORKSPACES_TEST_WINDOW_SIZE ?? '1400x900',
    );
    if (match) {
      const [w, h] = [Number(match[1]), Number(match[2])];
      state.windowRef.setContentSize(w, h);
      state.windowRef.center();
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
  cloudViews().setLimits({
    maxLiveViews: saved.sessions.maxLiveViews,
    keepAliveMs: cloudKeepAliveMs(saved.sessions.keepAliveHours),
  });
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
    notifier.onWindowFocus();
    claudeSessions().onWindowFocus();
    updateOnWindowFocus();
  });
  state.windowRef.on('close', (event) => {
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
  });

  const activeId = state.tabManager.activeId;
  if (activeId) state.tabManager.activate(activeId);
  // Restored GLOBAL-scope tabs load in the background; the devin view's
  // navigation to a session triggers setScope → preload for that scope.
  state.tabManager.preloadVisibleScope();
  applyLayout();
  await state.shellView.webContents.loadURL('app://shell/index.html');
  registerTestHooks();
  startCookieAudit();
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
app.on('window-all-closed', () => app.quit());
app.whenReady().then(setupUpdater, () => undefined);
