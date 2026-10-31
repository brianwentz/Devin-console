// Diagnostics for the "Linked Context tab is blank until its title is clicked"
// bug. A click on the tab that is already active is the user's workaround, so
// that click is the moment the pane is known to look wrong: before re-attaching,
// main snapshots the view stack and the on-screen pixels of the pane. These
// helpers are the pure part of that snapshot; the log carries only the numbers
// and booleans they return.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StackChild {
  bounds: Rect;
  isShell: boolean;
  isTab: boolean;
}

export interface StackInfo {
  attached: boolean;
  index: number;
  childCount: number;
  shellIndex: number;
  // Views stacked above the tab whose bounds overlap it (the shell included).
  coveredBy: number;
  shellAbove: boolean;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function stackInfo(children: StackChild[]): StackInfo {
  const index = children.findIndex((child) => child.isTab);
  const shellIndex = children.findIndex((child) => child.isShell);
  const target = children[index];
  if (!target) {
    return { attached: false, index, childCount: children.length, shellIndex, coveredBy: 0, shellAbove: false };
  }
  const tab = target.bounds;
  const above = children.slice(index + 1).filter((child) => overlaps(child.bounds, tab));
  return {
    attached: true,
    index,
    childCount: children.length,
    shellIndex,
    coveredBy: above.length,
    shellAbove: above.some((child) => child.isShell),
  };
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// The tab's rect in screen pixels of the captured display image, inset by
// `inset` DIPs (keeps scrollbars/borders out of the sample) and clamped to the
// image. Null when nothing is left to sample.
export function captureRect(
  contentBounds: Rect,
  viewBounds: Rect,
  displayBounds: Rect,
  scaleFactor: number,
  image: { width: number; height: number },
  inset = 16,
): Rect | null {
  const left = (contentBounds.x - displayBounds.x + viewBounds.x + inset) * scaleFactor;
  const top = (contentBounds.y - displayBounds.y + viewBounds.y + inset) * scaleFactor;
  const right = left + (viewBounds.width - 2 * inset) * scaleFactor;
  const bottom = top + (viewBounds.height - 2 * inset) * scaleFactor;
  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  const width = Math.min(image.width, Math.round(right)) - x;
  const height = Math.min(image.height, Math.round(bottom)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export interface PixelStats {
  samples: number;
  // Share of pixels matching the view/shell background (#111827): the blank pane.
  bgFraction: number;
  // Share of dark pixels (luma < 48) — tells a blank pane from a dark-themed page.
  darkFraction: number;
  // Share of pixels equal to the most common sampled colour.
  uniformFraction: number;
  // The most common sampled colour as #rrggbb (first to reach the top count wins ties); null without samples.
  topColour: string | null;
}

export const PANE_BG = { r: 0x11, g: 0x18, b: 0x27 };

// `bitmap` is BGRA (nativeImage.toBitmap()); every `step`-th pixel is sampled.
export function pixelStats(bitmap: Uint8Array, step = 7, bg = PANE_BG, tolerance = 10): PixelStats {
  let samples = 0;
  let bgCount = 0;
  let darkCount = 0;
  const colours = new Map<number, number>();
  let top = 0;
  let topKey = -1;
  for (let i = 0; i + 3 < bitmap.length; i += 4 * step) {
    const b = bitmap[i] ?? 0;
    const g = bitmap[i + 1] ?? 0;
    const r = bitmap[i + 2] ?? 0;
    samples++;
    if (Math.abs(r - bg.r) <= tolerance && Math.abs(g - bg.g) <= tolerance && Math.abs(b - bg.b) <= tolerance)
      bgCount++;
    if (0.299 * r + 0.587 * g + 0.114 * b < 48) darkCount++;
    const key = (r << 16) | (g << 8) | b;
    const count = (colours.get(key) ?? 0) + 1;
    colours.set(key, count);
    if (count > top) {
      top = count;
      topKey = key;
    }
  }
  const frac = (n: number) => (samples ? Math.round((n / samples) * 100) / 100 : 0);
  return {
    samples,
    bgFraction: frac(bgCount),
    darkFraction: frac(darkCount),
    uniformFraction: frac(top),
    topColour: topKey < 0 ? null : `#${topKey.toString(16).padStart(6, '0')}`,
  };
}

export interface TabHistoryInput {
  now: number;
  lastActiveAt: number;
  loadedAt: number;
  shownSinceLoad: boolean;
  createdOnAttach: boolean;
  wasActive: boolean;
}

export interface TabHistory {
  hiddenMs: number;
  sinceLoadMs: number;
  shownSinceLoad: boolean;
  loadedHidden: boolean;
  wasActive: boolean;
  paneHiddenMs?: number;
}

export function tabHistory(i: TabHistoryInput): TabHistory {
  return {
    hiddenMs: i.createdOnAttach || i.wasActive ? 0 : i.now - i.lastActiveAt,
    sinceLoadMs: i.now - i.loadedAt,
    shownSinceLoad: i.shownSinceLoad,
    loadedHidden: !i.createdOnAttach && !i.shownSinceLoad,
    wasActive: i.wasActive,
  };
}

// Structural subset of Electron's child-process-gone Details (core stays electron-free).
export interface ProcessGoneInput {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name?: string;
}

export function processGoneDetail(d: ProcessGoneInput): { type: string; reason: string; exitCode: number } {
  return { type: d.type, reason: d.reason, exitCode: d.exitCode };
}
