import type { Surface } from '../shared/ipc';

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface LayoutState {
  paneOpen: boolean;
  paneFraction: number; // pane share of (windowWidth - RAIL_WIDTH - SPLITTER_WIDTH); 0..1
  terminalOpen: boolean;
  terminalHeight: number; // px
  sessionsOpen: boolean;
  sessionsWidth: number; // px
}

export interface WindowBounds {
  devin: Rect;
  ghTab: Rect | null;
  splitter: Rect | null;
  titleBar: Rect | null;
  terminal: Rect | null;
  terminalSplitter: Rect | null;
  sessions: Rect | null;
  sessionsSplitter: Rect | null;
  sessionsCollapsed: boolean;
  rail: Rect;
  paneCollapsed: boolean;
}

export const RAIL_WIDTH = 56;
export const SPLITTER_WIDTH = 6;
export const TITLE_BAR_HEIGHT = 36;
export const MIN_PANE_WIDTH = 320;
// Cloud session sidebar column (left of the devin view, right of the rail).
export const SESSIONS_MIN_WIDTH = 200;
export const SESSIONS_MAX_WIDTH = 480;
export const DEFAULT_SESSIONS_WIDTH = 260;
// 640 keeps the default 50/50 split real at the 1400 px default window
// (available 1338 → 669 / 669). Auto-collapse threshold: 56 + 6 + 640 + 320 = 1022.
export const MIN_DEVIN_WIDTH = 640;
export const DEFAULT_PANE_FRACTION = 0.5;
export const DEFAULT_TERMINAL_HEIGHT = 280;
export const MIN_TERMINAL_HEIGHT = 120;
// Minimum px the main column keeps above an open terminal dock (below the title bar).
export const TERMINAL_RESERVED_MAIN = 200;

// The terminal dock belongs to the work surfaces only: it is laid out (and
// Ctrl+` / the rail toggle act) on Cloud, Local and Claude, never on Settings or
// Analytics. `layout.terminalOpen` persists across a visit to an off-surface —
// this predicate gates visibility, not the stored preference. Single source of
// truth for main (native view bounds), App (shell DOM) and Rail (button state).
export function dockSurface(surface: Surface): boolean {
  return surface === 'cloud' || surface === 'local' || surface === 'claude';
}

export function clampTerminalHeight(height: number, windowHeight: number): number {
  const max = Math.max(
    MIN_TERMINAL_HEIGHT,
    windowHeight - TITLE_BAR_HEIGHT - TERMINAL_RESERVED_MAIN,
  );
  return Math.min(max, Math.max(MIN_TERMINAL_HEIGHT, Math.round(height)));
}

// Persisted fraction sanitiser: 0..1, default for non-finite input. The px
// guards are NOT applied here — they are derived in computeBounds so the stored
// preference survives a temporarily small window.
export function clampFraction01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_PANE_FRACTION;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Width the pane and the devin view share (window minus rail minus splitter).
export function paneAvailable(windowWidth: number): number {
  return Math.max(0, Math.floor(windowWidth) - RAIL_WIDTH - SPLITTER_WIDTH);
}

// Pane width in px for a fraction (not clamped to the px guards).
export function paneWidthPx(fraction: number, windowWidth: number): number {
  const safe = Number.isFinite(fraction) ? clamp01(fraction) : DEFAULT_PANE_FRACTION;
  return Math.round(safe * paneAvailable(windowWidth));
}

// Fraction for a pane width in px (clamped to 0..1).
export function fractionFromPx(px: number, windowWidth: number): number {
  const available = paneAvailable(windowWidth);
  if (available <= 0 || !Number.isFinite(px)) return DEFAULT_PANE_FRACTION;
  return clamp01(px / available);
}

// px guards: the pane never drops below MIN_PANE_WIDTH and the devin view keeps
// MIN_DEVIN_WIDTH (when the window is too narrow for both, the smaller wins and
// computeBounds auto-collapses the pane).
export function clampPaneWidth(
  width: number,
  windowWidth: number,
  leftChrome = RAIL_WIDTH,
): number {
  const max = Math.max(0, windowWidth - leftChrome - SPLITTER_WIDTH - MIN_DEVIN_WIDTH);
  const min = Math.min(MIN_PANE_WIDTH, max);
  return Math.min(max, Math.max(min, Math.round(width)));
}

// The sessions column px width, clamped so the devin column keeps
// MIN_DEVIN_WIDTH. The caller decides whether the column is collapsed
// entirely (computeBounds' sessionsCollapsed).
export function clampSessionsWidth(width: number, windowWidth: number): number {
  const max = Math.max(
    SESSIONS_MIN_WIDTH,
    Math.min(SESSIONS_MAX_WIDTH, windowWidth - RAIL_WIDTH - SPLITTER_WIDTH - MIN_DEVIN_WIDTH),
  );
  return Math.min(max, Math.max(SESSIONS_MIN_WIDTH, Math.round(width)));
}

// Width of the fixed left chrome: rail + sessions column (+ its splitter)
// when the sessions column is actually visible.
export function leftChrome(layout: LayoutState, width: number): number {
  const sessionsWidth = clampSessionsWidth(layout.sessionsWidth, width);
  const visible =
    layout.sessionsOpen && width - (RAIL_WIDTH + sessionsWidth + SPLITTER_WIDTH) >= MIN_DEVIN_WIDTH;
  return RAIL_WIDTH + (visible ? sessionsWidth + SPLITTER_WIDTH : 0);
}

export function computeBounds(
  windowSize: Size,
  layout: LayoutState,
): WindowBounds {
  const width = Math.max(0, Math.floor(windowSize.width));
  const height = Math.max(0, Math.floor(windowSize.height));
  const rail: Rect = { x: 0, y: 0, width: Math.min(RAIL_WIDTH, width), height };
  const titleBar: Rect = {
    x: 0,
    y: 0,
    width,
    height: Math.min(TITLE_BAR_HEIGHT, height),
  };

  // The sessions column sits right of the rail, full height below the title
  // bar (the terminal dock does not shorten it). It collapses only when the
  // devin column could no longer keep MIN_DEVIN_WIDTH.
  const sessionsWidth = clampSessionsWidth(layout.sessionsWidth, width);
  const sessionsVisible =
    layout.sessionsOpen &&
    width - (RAIL_WIDTH + sessionsWidth + SPLITTER_WIDTH) >= MIN_DEVIN_WIDTH;
  const sessionsCollapsed = layout.sessionsOpen && !sessionsVisible;
  const sessions: Rect | null = sessionsVisible
    ? {
        x: rail.width,
        y: TITLE_BAR_HEIGHT,
        width: sessionsWidth,
        height: Math.max(0, height - TITLE_BAR_HEIGHT),
      }
    : null;
  const sessionsSplitter: Rect | null = sessionsVisible
    ? {
        x: rail.width + sessionsWidth,
        y: TITLE_BAR_HEIGHT,
        width: SPLITTER_WIDTH,
        height: Math.max(0, height - TITLE_BAR_HEIGHT),
      }
    : null;
  // Everything right of the sessions column: the devin column, the pane
  // splitter/pane, and the terminal dock all start at leftChrome.
  const chrome = leftChrome(layout, width);

  const terminalHeight = layout.terminalOpen
    ? clampTerminalHeight(layout.terminalHeight, height)
    : 0;
  // Dock rects sit at the bottom of the devin column only — pane rects are
  // unaffected. devinHeight is the main column height below the title bar.
  const dock = (devinColumnWidth: number) => {
    if (terminalHeight === 0) {
      return {
        terminal: null,
        terminalSplitter: null,
        devinHeight: Math.max(0, height - TITLE_BAR_HEIGHT),
      };
    }
    return {
      terminal: {
        x: chrome,
        y: height - terminalHeight,
        width: devinColumnWidth,
        height: terminalHeight,
      } as Rect,
      terminalSplitter: {
        x: chrome,
        y: height - terminalHeight - SPLITTER_WIDTH,
        width: devinColumnWidth,
        height: SPLITTER_WIDTH,
      } as Rect,
      devinHeight: Math.max(0, height - TITLE_BAR_HEIGHT - terminalHeight - SPLITTER_WIDTH),
    };
  };

  if (!layout.paneOpen) {
    const docked = dock(Math.max(0, width - chrome));
    return {
      rail,
      titleBar,
      sessions,
      sessionsSplitter,
      sessionsCollapsed,
      devin: {
        x: chrome,
        y: TITLE_BAR_HEIGHT,
        width: Math.max(0, width - chrome),
        height: docked.devinHeight,
      },
      ghTab: null,
      splitter: null,
      terminal: docked.terminal,
      terminalSplitter: docked.terminalSplitter,
      paneCollapsed: false,
    };
  }

  // Auto-collapse the pane when there is not enough room for both the minimum
  // pane width and the minimum devin width. Otherwise the pane is capped at the
  // width that leaves MIN_DEVIN_WIDTH for the devin view. The user's paneOpen
  // preference is not mutated — collapse is purely derived.
  const allowedMax = width - chrome - SPLITTER_WIDTH - MIN_DEVIN_WIDTH;
  if (allowedMax < MIN_PANE_WIDTH) {
    const closed = computeBounds(windowSize, { ...layout, paneOpen: false });
    return { ...closed, paneCollapsed: true };
  }
  const paneCollapsed = false;
  const paneWidth = clampPaneWidth(
    Math.min(paneWidthPx(layout.paneFraction, width), allowedMax),
    width,
    chrome,
  );
  const splitterX = Math.max(chrome, width - paneWidth - SPLITTER_WIDTH);
  const paneX = Math.min(width, splitterX + SPLITTER_WIDTH);
  const paneActualWidth = Math.max(0, width - paneX);
  const docked = dock(Math.max(0, splitterX - chrome));

  return {
    rail,
    titleBar,
    sessions,
    sessionsSplitter,
    sessionsCollapsed,
    devin: {
      x: chrome,
      y: TITLE_BAR_HEIGHT,
      width: Math.max(0, splitterX - chrome),
      height: docked.devinHeight,
    },
    splitter: {
      x: splitterX,
      y: TITLE_BAR_HEIGHT,
      width: Math.min(SPLITTER_WIDTH, Math.max(0, width - splitterX)),
      height: Math.max(0, height - TITLE_BAR_HEIGHT),
    },
    ghTab: {
      x: paneX,
      y: TITLE_BAR_HEIGHT,
      width: paneActualWidth,
      height: Math.max(0, height - TITLE_BAR_HEIGHT),
    },
    terminal: docked.terminal,
    terminalSplitter: docked.terminalSplitter,
    paneCollapsed,
  };
}

// Window content width to apply BEFORE flipping paneOpen so the devin column
// keeps its px width. Returns null when no resize is needed/possible.
export function paneToggleWindowWidth(
  open: boolean,
  contentWidth: number,
  layout: LayoutState,
  maxWidth: number,
): number | null {
  if (!open) {
    const bounds = computeBounds({ width: contentWidth, height: 1000 }, layout);
    if (bounds.paneCollapsed || !bounds.ghTab || !bounds.splitter) return null;
    return bounds.splitter.x;
  }
  const chrome = leftChrome(layout, contentWidth);
  const devin = Math.max(0, Math.floor(contentWidth) - chrome);
  // Clamp the ratio at 0.95 so f→1 doesn't explode the target width.
  const fraction = Math.min(0.95, clampFraction01(layout.paneFraction));
  const pane = Math.max(MIN_PANE_WIDTH, Math.round((fraction / (1 - fraction)) * devin));
  const target = chrome + devin + SPLITTER_WIDTH + pane;
  // Never shrink when opening: stay at contentWidth when it already fits.
  const next = Math.min(target, Math.max(maxWidth, contentWidth));
  return next === contentWidth ? null : next;
}
