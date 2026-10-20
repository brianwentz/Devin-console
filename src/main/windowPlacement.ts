import { screen, type BaseWindow, type BaseWindowConstructorOptions } from 'electron';
import {
  displayKey,
  pickPlacement,
  rememberPlacement,
  type DisplayInfo,
  type Placement,
} from '../core/windowPlacement';
import { log } from './log';
import { state, testMode } from './state';

// Disabled under test mode unless a test explicitly opts in.
function placementEnabled(): boolean {
  return !testMode || process.env.AGENT_WORKSPACE_TEST_PLACEMENT === '1';
}

// F2: remember window bounds per display configuration. The whole module is a
// no-op in test mode (e2e drives explicit window sizes). Only the key and the
// source are logged — never bounds.

export const DEFAULT_WINDOW_SIZE = { width: 1400, height: 900 } as const;
const SAVE_DEBOUNCE_MS = 500;
// setBounds/maximize emit resize/move asynchronously; ignore them for this long.
const APPLY_SETTLE_MS = 600;

function currentDisplays(): DisplayInfo[] {
  return screen.getAllDisplays().map((display) => ({
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  }));
}

function currentKey(): string {
  return displayKey(currentDisplays());
}

export function initialWindowOptions(): Partial<BaseWindowConstructorOptions> & {
  restored: Placement | null;
} {
  if (!placementEnabled()) return { ...DEFAULT_WINDOW_SIZE, restored: null };
  const key = currentKey();
  const saved = state.settings?.current.windowPlacements ?? {};
  const restored = pickPlacement(saved, key, currentDisplays());
  log('shell', 'window-placement', { detail: { key, source: restored ? 'restored' : 'default' } });
  if (!restored) return { ...DEFAULT_WINDOW_SIZE, restored: null };
  const { x, y, width, height } = restored.bounds;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    useContentSize: true,
    restored,
  };
}

let tracked: BaseWindow | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let applying = false;
let applyTimer: NodeJS.Timeout | null = null;
let lastKey = '';

// Bounds are stored as *content* bounds: on Windows the hidden title bar leaves
// invisible resize borders that getNormalBounds() includes but the constructor/
// setBounds do not round-trip, which grew the window by several px per launch.
// A maximized window has no "normal content bounds" getter — its restore rect
// comes from getNormalBounds and lands a few px off on unmaximize; acceptable.
function placementOf(window: BaseWindow): Placement {
  return {
    bounds: window.isMaximized() ? window.getNormalBounds() : window.getContentBounds(),
    maximized: window.isMaximized(),
    savedAt: Date.now(),
  };
}

function saveUnder(key: string): void {
  if (!tracked || tracked.isDestroyed() || !state.settings) return;
  if (tracked.isMinimized()) return;
  const next = rememberPlacement(state.settings.current.windowPlacements, key, placementOf(tracked));
  state.settings.merge({ windowPlacements: next });
}

// Persist the current placement immediately (shutdown path).
export function savePlacementNow(): void {
  if (!placementEnabled() || !tracked) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saveUnder(lastKey || currentKey());
}

function scheduleSave(): void {
  if (applying) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveUnder(lastKey || currentKey());
  }, SAVE_DEBOUNCE_MS);
}

function applyPlacement(window: BaseWindow, placement: Placement): void {
  applying = true;
  if (applyTimer) clearTimeout(applyTimer);
  if (window.isMaximized()) window.unmaximize();
  const { x, y, width, height } = placement.bounds;
  window.setContentBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
  if (placement.maximized) window.maximize();
  applyTimer = setTimeout(() => {
    applyTimer = null;
    applying = false;
  }, APPLY_SETTLE_MS);
}

// Display topology changed (dock/undock, scale change): file the current bounds
// under the old key, then jump to the remembered placement for the new key.
function onDisplayChange(): void {
  if (!tracked || tracked.isDestroyed()) return;
  const previousKey = lastKey;
  const nextKey = currentKey();
  if (nextKey === previousKey) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (previousKey && !applying) saveUnder(previousKey);
  lastKey = nextKey;
  const saved = state.settings?.current.windowPlacements ?? {};
  const placement = pickPlacement(saved, nextKey, currentDisplays());
  log('shell', 'window-placement', {
    detail: { key: nextKey, source: 'display-change', restored: Boolean(placement) },
  });
  if (placement) applyPlacement(tracked, placement);
}

export function attachPlacementTracking(window: BaseWindow): void {
  if (!placementEnabled()) return;
  tracked = window;
  lastKey = currentKey();
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  const onScreen = () => onDisplayChange();
  screen.on('display-added', onScreen);
  screen.on('display-removed', onScreen);
  screen.on('display-metrics-changed', onScreen);
  window.once('closed', () => {
    screen.removeListener('display-added', onScreen);
    screen.removeListener('display-removed', onScreen);
    screen.removeListener('display-metrics-changed', onScreen);
    if (saveTimer) clearTimeout(saveTimer);
    if (applyTimer) clearTimeout(applyTimer);
    saveTimer = null;
    applyTimer = null;
    tracked = null;
  });
}
