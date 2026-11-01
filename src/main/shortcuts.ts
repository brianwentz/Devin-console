import { app } from 'electron';
import { addressBarShortcut } from '../core/addressBarKeys';
import { createReloadGuard, reloadView } from '../core/reloadGuard';
import { clampPaneWidth, dockSurface, fractionFromPx, paneWidthPx, sidebarShortcutSurface } from '../core/layout';
import { newSessionUrl } from '../core/sessions';
import { HOME_KEY } from '../core/viewPool';
import { runtimeFor } from './providers';
import { cloudViews } from './cloudViews';
import { allPoolViews, poolForSurface } from './cloudKit/pools';
import { log } from './log';
import { withActiveTabDiag } from './tabPaintDiag';
import { state, testMode, type ViewName } from './state';
import {
  applyLayout,
  cancelDrag,
  focusContents,
  setAddressBar,
  setPaneOpen,
  setSessionsOpen,
} from './window';

export type ReloadSource = 'button' | 'ctrl-r' | 'f5' | 'test';

// Active-tab reloads waiting on their diagnostic snapshot.
const pendingTabReloads = createReloadGuard<Electron.WebContents>();

// Reloads are logged (never the URL); a reload of the active Linked Context tab
// first snapshots the pane — a reload is a workaround for the blank pane.
function reload(contents: Electron.WebContents, source: ReloadSource): void {
  const tabManager = state.tabManager;
  const tab = !!tabManager && contents === tabManager.activeWebContents;
  if (!tab) {
    const view = reloadView({
      tab,
      shell: contents === state.shellView?.webContents,
      provider:
        contents === state.devinView?.webContents ||
        allPoolViews().some((pooled) => pooled.webContents === contents),
      analytics: contents === state.analyticsView?.webContents,
    });
    log('shell', 'tab-reload', { detail: { source, tab, view } });
    contents.reload();
    return;
  }
  const id = tabManager.activeId;
  const decision = pendingTabReloads.request(contents);
  if (decision === 'drop') return;
  if (decision === 'coalesce') {
    log('shell', 'tab-reload', { detail: { source, tab, view: 'tab', id, coalesced: true } });
    return;
  }
  log('shell', 'tab-reload', { detail: { source, tab, view: 'tab', id } });
  withActiveTabDiag('reload', () => {
    pendingTabReloads.done(contents);
    if (!contents.isDestroyed()) contents.reload();
  });
}

export function historyAction(
  action: 'back' | 'forward' | 'reload',
  contents: Electron.WebContents,
  source: ReloadSource = 'test',
): void {
  if (contents.isDestroyed()) return;
  if (action === 'reload') {
    reload(contents, source);
    return;
  }
  const history = contents.navigationHistory;
  const activeIndex = history.getActiveIndex();
  if (action === 'back' && activeIndex > 0) history.goToIndex(activeIndex - 1);
  if (action === 'forward' && activeIndex + 1 < history.length())
    history.goToIndex(activeIndex + 1);
}

export function navigationTarget(): Electron.WebContents | null {
  return (
    (state.paneOpen ? state.tabManager?.activeWebContents : null) ??
    (state.surface === 'analytics'
      ? state.analyticsView?.webContents
      : (poolForSurface(state.surface)?.activeView() ?? state.devinView)?.webContents) ??
    null
  );
}

export function focusVisibleContents(contents: Electron.WebContents | null): void {
  if (!contents || contents.isDestroyed()) return;
  const visibleTab =
    state.paneOpen && !state.paneCollapsed && contents === state.tabManager?.activeWebContents;
  if (
    contents === state.shellView?.webContents ||
    contents === poolForSurface(state.surface)?.activeView()?.webContents ||
    (state.surface === 'analytics' && contents === state.analyticsView?.webContents) ||
    visibleTab
  ) {
    focusContents(contents, 'focus-visible');
  }
}

// P5: Ctrl+N — show the Cloud surface and navigate the pooled home view to
// the tenant's create-session surface (NEW_SESSION_PATH in core/sessions.ts).
export function openNewSession(): void {
  const url = newSessionUrl(state.tenantUrl);
  state.surface = 'cloud';
  cloudViews().show(HOME_KEY, url, { reload: true });
  applyLayout();
  log('devin', 'new-session', { url });
  focusContents(state.devinView?.webContents, 'new-session');
}

// Ctrl+T (new tab) / Ctrl+L (edit the active tab's address; new when the
// scope has no tab) — Cmd on macOS. Ctrl+T opens a closed pane first; Ctrl+L
// needs the pane visible. Focus goes to the shell so the bar's input takes the
// keys. Hosted views reach this from handleShortcut; the shell's own keys are
// matched in the renderer (App.tsx) so the terminal dock keeps ^L / ^T.
export function openAddressBarShortcut(kind: 'new' | 'current'): boolean {
  let acted = false;
  if (kind === 'new' && !state.paneOpen) {
    setPaneOpen(true, 'shortcut');
    acted = true;
  }
  if (!state.paneOpen || state.paneCollapsed) return acted;
  const mode = kind === 'current' && state.tabManager?.activeId ? 'current' : 'new';
  setAddressBar(true, mode, 'shortcut');
  focusContents(state.shellView?.webContents, 'address-bar');
  return true;
}

export function handleShortcut(
  contents: Electron.WebContents,
  view: ViewName,
  event: Electron.Event,
  input: Electron.Input,
): void {
  if (input.type !== 'keyDown') return;
  if (state.dragging && input.key.toLowerCase() === 'escape') {
    event.preventDefault();
    cancelDrag(true, 'escape');
    return;
  }
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const activeId = state.tabManager?.activeId;
  let handled = false;

  if (ctrl && input.shift && key === 'g') {
    setPaneOpen(!state.paneOpen, 'shortcut');
    focusVisibleContents(contents);
    handled = true;
  } else if (ctrl && input.shift && key === 's' && sidebarShortcutSurface(state.surface)) {
    setSessionsOpen(!state.sessionsOpen, 'shortcut');
    focusVisibleContents(contents);
    handled = true;
  } else if (ctrl && key === 'tab' && state.tabManager) {
    // Ctrl+Tab cycles the visible scope's tabs only.
    const tabs = state.tabManager.publicState().tabs;
    if (tabs.length > 0) {
      const currentIndex = Math.max(
        0,
        tabs.findIndex((tab) => tab.id === activeId),
      );
      const delta = input.shift ? -1 : 1;
      const next = tabs[(currentIndex + delta + tabs.length) % tabs.length];
      if (next) state.tabManager.activate(next.id);
      applyLayout();
      focusVisibleContents(state.tabManager.activeWebContents);
      handled = true;
    }
  } else if (ctrl && key === 'w' && state.paneOpen && activeId) {
    void state.tabManager?.close(activeId).then(applyLayout);
    handled = true;
  } else if (input.alt && (key === 'arrowleft' || key === 'left')) {
    historyAction('back', contents);
    handled = true;
  } else if (input.alt && (key === 'arrowright' || key === 'right')) {
    historyAction('forward', contents);
    handled = true;
  } else if ((ctrl && key === 'r') || key === 'f5') {
    historyAction('reload', contents, key === 'f5' ? 'f5' : 'ctrl-r');
    handled = true;
  } else if (ctrl && !input.shift && !input.alt && key === 'n') {
    // devin-local has no newSession and Settings/Analytics have no runtime, so
    // they fall back to the Cloud new session exactly as before.
    const newSession =
      runtimeFor(state.surface)?.newSession ?? runtimeFor('devin-cloud')?.newSession;
    void newSession?.();
    handled = true;
  } else if (view !== 'shell' && addressBarShortcut(input, process.platform)) {
    handled = openAddressBarShortcut(addressBarShortcut(input, process.platform)!);
  } else if (ctrl && !input.alt && key === '`' && dockSurface(state.surface)) {
    // Off dock surfaces (Settings/Analytics) the shortcut is a no-op, matching
    // the disabled rail button — the persisted toggle is left untouched.
    state.terminalOpen = !state.terminalOpen;
    log('shell', 'terminal-toggle', { detail: { open: state.terminalOpen, source: 'shortcut' } });
    applyLayout();
    focusVisibleContents(contents);
    handled = true;
  } else if (ctrl && input.shift && (key === '[' || key === '{' || key === ']' || key === '}')) {
    // Step ±80 px in pixel space, store the result as a fraction.
    const windowWidth = state.windowRef?.getContentBounds().width ?? 1400;
    const panePx = clampPaneWidth(
      paneWidthPx(state.paneFraction, windowWidth) + (key === '[' || key === '{' ? -80 : 80),
      windowWidth,
    );
    state.paneFraction = fractionFromPx(panePx, windowWidth);
    applyLayout();
    focusVisibleContents(contents);
    handled = true;
  } else if (
    view !== 'shell' &&
    ctrl &&
    !input.alt &&
    (key === '=' || key === '+' || key === '-' || key === '0')
  ) {
    // The default menu used to provide zoom shortcuts; re-add them for hosted
    // views (the shell keeps a fixed zoom).
    const zoom =
      key === '0'
        ? 0
        : contents.getZoomLevel() + (key === '-' ? -0.5 : 0.5);
    contents.setZoomLevel(zoom);
    handled = true;
  } else if (
    (key === 'f12' || (ctrl && input.shift && key === 'i')) &&
    (!app.isPackaged || testMode)
  ) {
    contents.openDevTools({ mode: 'detach' });
    handled = true;
  }

  if (handled) {
    event.preventDefault();
    log(view, 'shortcut', {
      detail: { key: input.key, control: ctrl, shift: input.shift, alt: input.alt },
    });
  }
}
