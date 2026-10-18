import { app } from 'electron';
import { clampPaneWidth, fractionFromPx, paneWidthPx } from '../core/layout';
import { newSessionUrl } from '../core/sessions';
import { HOME_KEY } from '../core/viewPool';
import { claudeSessions } from './claude/sessions';
import { cloudViews } from './cloudViews';
import { log } from './log';
import { state, testMode, type ViewName } from './state';
import { applyLayout, cancelDrag, setPaneOpen, setSessionsOpen } from './window';

export function historyAction(
  action: 'back' | 'forward' | 'reload',
  contents: Electron.WebContents,
): void {
  if (contents.isDestroyed()) return;
  if (action === 'reload') {
    contents.reload();
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
      : state.devinView?.webContents) ??
    null
  );
}

export function focusVisibleContents(contents: Electron.WebContents | null): void {
  if (!contents || contents.isDestroyed()) return;
  const visibleTab =
    state.paneOpen && !state.paneCollapsed && contents === state.tabManager?.activeWebContents;
  if (
    contents === state.shellView?.webContents ||
    (state.surface === 'cloud' && contents === state.devinView?.webContents) ||
    (state.surface === 'analytics' && contents === state.analyticsView?.webContents) ||
    visibleTab
  ) {
    contents.focus();
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
  const contents = state.devinView?.webContents;
  if (contents && !contents.isDestroyed()) contents.focus();
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
  } else if (ctrl && input.shift && key === 's' && (state.surface === 'cloud' || state.surface === 'claude')) {
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
    historyAction('reload', contents);
    handled = true;
  } else if (ctrl && !input.shift && !input.alt && key === 'n') {
    if (state.surface === 'claude') {
      // Phase 2: a new Claude chat session (cwd picker / test env var).
      void claudeSessions().newSession(null);
    } else {
      openNewSession();
    }
    handled = true;
  } else if (ctrl && !input.alt && key === '`') {
    state.terminalOpen = !state.terminalOpen;
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
