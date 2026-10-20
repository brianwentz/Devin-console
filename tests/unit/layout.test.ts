import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_TABS_HEIGHT,
  clampFraction01,
  clampPaneWidth,
  clampSessionsWidth,
  clampTerminalHeight,
  computeBounds,
  DEFAULT_PANE_FRACTION,
  DEFAULT_SESSIONS_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  dockSurface,
  fractionFromPx,
  leftChrome,
  MIN_TERMINAL_HEIGHT,
  paneAvailable,
  paneToggleWindowWidth,
  paneWidthPx,
  RAIL_WIDTH,
  SESSIONS_MAX_WIDTH,
  SESSIONS_MIN_WIDTH,
  SPLITTER_WIDTH,
  TITLE_BAR_HEIGHT,
  type LayoutState,
} from '../../src/core/layout';
import type { Surface } from '../../src/shared/ipc';

function layout(overrides: Partial<LayoutState> = {}): LayoutState {
  return {
    paneOpen: true,
    paneFraction: DEFAULT_PANE_FRACTION,
    terminalOpen: false,
    terminalHeight: DEFAULT_TERMINAL_HEIGHT,
    sessionsOpen: false,
    sessionsWidth: DEFAULT_SESSIONS_WIDTH,
    ...overrides,
  };
}

// 1400 window: available = 1400 - 56 - 6 = 1338; 560 px = fraction 560/1338.
const F560 = 560 / 1338;

describe('computeBounds', () => {
  it('places the rail, title bar, conversation, splitter, and browser pane', () => {
    const bounds = computeBounds({ width: 1400, height: 900 }, layout({ paneFraction: F560 }));
    expect(bounds.rail).toEqual({ x: 0, y: 0, width: 56, height: 900 });
    expect(bounds.titleBar).toEqual({ x: 0, y: 0, width: 1400, height: 36 });
    expect(bounds.splitter).toEqual({ x: 834, y: 36, width: 6, height: 864 });
    expect(bounds.devin).toEqual({ x: 56, y: 36, width: 778, height: 864 });
    expect(bounds.ghTab).toEqual({ x: 840, y: 36, width: 560, height: 864 });
    expect(bounds.terminal).toBeNull();
    expect(bounds.terminalSplitter).toBeNull();
  });

  it('splits 50/50 at the 1400 px default window', () => {
    // 1400 - 56 - 6 = 1338 available → 669 px each side (both ≥ MIN_DEVIN_WIDTH 640).
    const bounds = computeBounds({ width: 1400, height: 900 }, layout());
    expect(bounds.ghTab?.width).toBe(669);
    expect(bounds.devin.width).toBe(669);
    expect(bounds.splitter?.x).toBe(725);
    expect(bounds.ghTab?.x).toBe(731);
    expect(bounds.paneCollapsed).toBe(false);
  });

  it('splits 50/50 in a wide window too', () => {
    // 2000 - 56 - 6 = 1938 available → 969 px each side.
    const bounds = computeBounds({ width: 2000, height: 900 }, layout());
    expect(bounds.ghTab?.width).toBe(969);
    expect(bounds.devin.width).toBe(969);
    expect(bounds.splitter?.x).toBe(1025);
  });

  it('clamps the rendered pane in a small window without touching the input fraction', () => {
    // 1000 - 56 - 6 = 938 available; 0.5 → 469 px, but allowedMax is 1000 - 56 - 6 - 640 = 298
    // < MIN_PANE_WIDTH, so the pane auto-collapses. Just above the threshold the pane is
    // capped at allowedMax while the devin view keeps MIN_DEVIN_WIDTH.
    const input = layout({ paneFraction: 0.5 });
    const snapshot = { ...input };
    const collapsed = computeBounds({ width: 1000, height: 800 }, input);
    expect(collapsed.paneCollapsed).toBe(true);
    expect(collapsed.ghTab).toBeNull();
    expect(collapsed.devin.width).toBe(944);
    const capped = computeBounds({ width: 1100, height: 800 }, input);
    // 1100 - 56 - 6 - 640 = 398 allowed; 0.5 * 1038 = 519 requested → 398.
    expect(capped.paneCollapsed).toBe(false);
    expect(capped.ghTab?.width).toBe(398);
    expect(capped.devin.width).toBe(640);
    expect(input).toEqual(snapshot);
    expect(input.paneFraction).toBe(0.5);
  });

  it('fills the remaining window when the pane is closed', () => {
    const bounds = computeBounds({ width: 1400, height: 900 }, layout({ paneOpen: false }));
    expect(bounds.devin).toEqual({ x: 56, y: 36, width: 1344, height: 864 });
    expect(bounds.ghTab).toBeNull();
    expect(bounds.splitter).toBeNull();
    expect(bounds.titleBar).toEqual({ x: 0, y: 0, width: 1400, height: 36 });
    expect(bounds.terminal).toBeNull();
    expect(bounds.terminalSplitter).toBeNull();
  });

  it('keeps all regions within undersized dimensions', () => {
    const bounds = computeBounds({ width: 1400, height: 20 }, layout({ paneFraction: F560 }));
    expect(bounds.titleBar?.height).toBe(20);
    expect(bounds.devin.width).toBe(778);
    expect(bounds.devin.height).toBe(0);
    expect(bounds.ghTab?.width).toBe(560);
    expect(bounds.ghTab?.height).toBe(0);
    expect(bounds.paneCollapsed).toBe(false);
  });

  it('caps a too-wide pane at the width that leaves MIN_DEVIN_WIDTH', () => {
    // 1400 - 56 - 6 - 640 = 698: pane wider than allowed shrinks to allowedMax.
    const bounds = computeBounds({ width: 1400, height: 900 }, layout({ paneFraction: 0.9 }));
    expect(bounds.paneCollapsed).toBe(false);
    expect(bounds.ghTab?.width).toBe(698);
    expect(bounds.devin.width).toBe(640);
  });

  it('stays open at the boundary where allowedMax equals MIN_PANE_WIDTH', () => {
    // 1022 - 56 - 6 - 640 = 320 = MIN_PANE_WIDTH exactly.
    const bounds = computeBounds({ width: 1022, height: 900 }, layout());
    expect(bounds.paneCollapsed).toBe(false);
    expect(bounds.ghTab?.width).toBe(320);
    expect(bounds.devin.width).toBe(640);
  });

  it('auto-collapses the pane when allowedMax is below MIN_PANE_WIDTH', () => {
    // 1021 - 56 - 6 - 640 = 319 < 320: collapse.
    const bounds = computeBounds({ width: 1021, height: 900 }, layout());
    expect(bounds.paneCollapsed).toBe(true);
    expect(bounds.ghTab).toBeNull();
    expect(bounds.devin.width).toBe(965);
    const closed = computeBounds({ width: 1021, height: 900 }, layout({ paneOpen: false }));
    expect(closed.paneCollapsed).toBe(false);
  });

  it('docks the terminal under the devin column and shrinks devin', () => {
    const bounds = computeBounds({ width: 1400, height: 900 },
      layout({ paneFraction: F560, terminalOpen: true, terminalHeight: 280 }));
    // devin column ends at the splitter (x=834); the dock spans rail..splitterX.
    expect(bounds.devin).toEqual({ x: 56, y: 36, width: 778, height: 578 });
    expect(bounds.terminalSplitter).toEqual({ x: 56, y: 614, width: 778, height: 6 });
    expect(bounds.terminal).toEqual({ x: 56, y: 620, width: 778, height: 280 });
    // Pane rects are unaffected.
    expect(bounds.ghTab).toEqual({ x: 840, y: 36, width: 560, height: 864 });
  });

  it('docks the terminal across the full width when the pane is closed', () => {
    const bounds = computeBounds({ width: 1400, height: 900 },
      layout({ paneOpen: false, terminalOpen: true, terminalHeight: DEFAULT_TERMINAL_HEIGHT }));
    expect(bounds.devin.height).toBe(578);
    expect(bounds.terminal).toEqual({ x: 56, y: 620, width: 1344, height: 280 });
    expect(bounds.terminalSplitter).toEqual({ x: 56, y: 614, width: 1344, height: 6 });
  });

  it('clamps the terminal height and survives tiny windows', () => {
    expect(clampTerminalHeight(50, 900)).toBe(MIN_TERMINAL_HEIGHT);
    // max = 900 - TITLE_BAR_HEIGHT - 200 = 664
    expect(clampTerminalHeight(9999, 900)).toBe(664);
    expect(clampTerminalHeight(280, 200)).toBe(MIN_TERMINAL_HEIGHT); // tiny window keeps the min

    const bounds = computeBounds({ width: 1400, height: 300 },
      layout({ paneFraction: F560, terminalOpen: true, terminalHeight: 500 }));
    // clamped to 300 - 36 - 200 = 64 → min 120
    expect(bounds.terminal?.height).toBe(MIN_TERMINAL_HEIGHT);
    expect(bounds.devin.height).toBe(138);
    expect(bounds.terminalSplitter?.y).toBe(174);
  });
});

describe('paneToggleWindowWidth', () => {
  const WIDE = 10_000;

  it('closing at 1400 @ 0.5 shrinks to rail + devin px', () => {
    // devin column is 669 at 1400/0.5 → 56 + 669 = 725.
    expect(paneToggleWindowWidth(false, 1400, layout({ paneFraction: 0.5 }), WIDE)).toBe(725);
  });

  it('opening from 725 @ 0.5 grows back to 1400', () => {
    expect(paneToggleWindowWidth(true, 725, layout({ paneOpen: false, paneFraction: 0.5 }), WIDE)).toBe(1400);
  });

  it('round-trips an asymmetric split (560 px pane)', () => {
    // 1400 @ F560: devin 778 → closed 56 + 778 = 834; opening restores 1400.
    expect(paneToggleWindowWidth(false, 1400, layout({ paneFraction: F560 }), WIDE)).toBe(834);
    expect(
      paneToggleWindowWidth(true, 834, layout({ paneOpen: false, paneFraction: F560 }), WIDE),
    ).toBe(1400);
  });

  it('caps the grown width at the work area', () => {
    expect(
      paneToggleWindowWidth(true, 725, layout({ paneOpen: false, paneFraction: 0.5 }), 1100),
    ).toBe(1100);
  });

  it('never shrinks when the cap is below the current width', () => {
    expect(
      paneToggleWindowWidth(true, 725, layout({ paneOpen: false, paneFraction: 0.5 }), 700),
    ).toBeNull();
  });

  it('returns null when closing an auto-collapsed pane', () => {
    // 1000 @ 0.5 auto-collapses: the devin view already fills the window.
    expect(paneToggleWindowWidth(false, 1000, layout({ paneFraction: 0.5 }), WIDE)).toBeNull();
  });

  it('clamps fraction 1 to a finite target', () => {
    const result = paneToggleWindowWidth(
      true,
      725,
      layout({ paneOpen: false, paneFraction: 1 }),
      WIDE,
    );
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!)).toBe(true);
  });

  it('returns null when the result equals the current width', () => {
    // Work-area cap == current width: nothing to grow into.
    expect(
      paneToggleWindowWidth(true, 1400, layout({ paneOpen: false, paneFraction: 0.5 }), 1400),
    ).toBeNull();
  });

  it('grows by a full pane width for a large cap', () => {
    // Closed devin column is 1344; @0.5 the pane gets the same → 2750.
    expect(
      paneToggleWindowWidth(true, 1400, layout({ paneOpen: false, paneFraction: 0.5 }), WIDE),
    ).toBe(2750);
  });
});

describe('pane fraction helpers', () => {
  it('converts between px and fraction over the available width', () => {
    expect(paneAvailable(1400)).toBe(1338);
    expect(paneAvailable(10)).toBe(0);
    expect(paneWidthPx(0.5, 1400)).toBe(669);
    expect(paneWidthPx(0.5, 2000)).toBe(969);
    expect(fractionFromPx(669, 1400)).toBeCloseTo(0.5, 6);
    expect(paneWidthPx(fractionFromPx(500, 1400), 1400)).toBe(500);
  });

  it('clamps px to [0, 1] and falls back to the default for bad input', () => {
    expect(fractionFromPx(-50, 1400)).toBe(0);
    expect(fractionFromPx(5000, 1400)).toBe(1);
    expect(fractionFromPx(500, 10)).toBe(DEFAULT_PANE_FRACTION);
    expect(fractionFromPx(Number.NaN, 1400)).toBe(DEFAULT_PANE_FRACTION);
    expect(paneWidthPx(Number.NaN, 1400)).toBe(669);
    expect(paneWidthPx(7, 1400)).toBe(1338);
  });

  it('clampPaneWidth keeps the px guards (no 1200 px cap)', () => {
    // Too small → MIN_PANE_WIDTH 320.
    expect(clampPaneWidth(1, 1400)).toBe(320);
    // Too large → devin keeps MIN_DEVIN_WIDTH: 1400 - 56 - 6 - 640 = 698.
    expect(clampPaneWidth(2000, 1400)).toBe(698);
    // In range → unchanged px.
    expect(clampPaneWidth(500, 1400)).toBe(500);
    // Wide window: 3000 - 56 - 6 - 640 = 2298 — no fixed cap.
    expect(clampPaneWidth(2500, 3000)).toBe(2298);
  });

  it('clampFraction01 sanitises the persisted preference without px guards', () => {
    expect(clampFraction01(0.05)).toBe(0.05);
    expect(clampFraction01(0.95)).toBe(0.95);
    expect(clampFraction01(-1)).toBe(0);
    expect(clampFraction01(2)).toBe(1);
    expect(clampFraction01(Number.NaN)).toBe(DEFAULT_PANE_FRACTION);
  });
});

describe('sessions column', () => {
  it('sits right of the rail, full height, and shifts devin.x', () => {
    const bounds = computeBounds(
      { width: 1400, height: 900 },
      layout({ sessionsOpen: true, sessionsWidth: 260, paneOpen: false }),
    );
    expect(bounds.sessions).toEqual({ x: 56, y: 36, width: 260, height: 864 });
    expect(bounds.sessionsSplitter).toEqual({ x: 316, y: 36, width: 6, height: 864 });
    expect(bounds.sessionsCollapsed).toBe(false);
    expect(bounds.devin.x).toBe(56 + 260 + 6);
    expect(bounds.devin.width).toBe(1400 - 322);
  });

  it('the dock starts at leftChrome (not the rail)', () => {
    const bounds = computeBounds(
      { width: 1400, height: 900 },
      layout({ sessionsOpen: true, terminalOpen: true, paneOpen: false }),
    );
    expect(bounds.terminal?.x).toBe(56 + 260 + 6);
    expect(bounds.terminal?.width).toBe(bounds.devin.width);
    // The dock does not shorten the sessions column.
    expect(bounds.sessions?.height).toBe(900 - 36);
  });

  it('collapse order: pane first, then sessions', () => {
    // 1400 - chrome(322) - 6 - 640 = 432 ≥ 320 → pane fits.
    const wide = computeBounds({ width: 1400, height: 900 }, layout({ sessionsOpen: true }));
    expect(wide.paneCollapsed).toBe(false);
    expect(wide.sessions).not.toBeNull();
    // 1100: pane can't fit (1100-322-6-640 = 132 < 320) → paneCollapsed,
    // sessions still on (1100 - 322 = 778 ≥ 640).
    const narrow = computeBounds({ width: 1100, height: 800 }, layout({ sessionsOpen: true }));
    expect(narrow.paneCollapsed).toBe(true);
    expect(narrow.sessionsCollapsed).toBe(false);
    expect(narrow.sessions).not.toBeNull();
    // 800: even without the pane, 800 - 322 < 640 → sessions collapses too.
    const tiny = computeBounds({ width: 800, height: 800 }, layout({ sessionsOpen: true }));
    expect(tiny.sessionsCollapsed).toBe(true);
    expect(tiny.sessions).toBeNull();
    expect(tiny.devin.x).toBe(RAIL_WIDTH);
  });

  it('clampSessionsWidth respects min/max and the devin minimum', () => {
    expect(clampSessionsWidth(100, 2000)).toBe(SESSIONS_MIN_WIDTH);
    expect(clampSessionsWidth(9999, 2000)).toBe(SESSIONS_MAX_WIDTH);
    // Narrow: capped so the devin column keeps MIN_DEVIN_WIDTH.
    expect(clampSessionsWidth(9999, 1100)).toBe(398);
  });

  it('leftChrome includes the sessions column only when visible', () => {
    const open = layout({ sessionsOpen: true });
    expect(leftChrome(open, 1400)).toBe(RAIL_WIDTH + 260 + SPLITTER_WIDTH);
    expect(leftChrome(open, 700)).toBe(RAIL_WIDTH); // collapsed
    expect(leftChrome(layout({ sessionsOpen: false }), 1400)).toBe(RAIL_WIDTH);
  });

  it('pane toggle widths account for the open column', () => {
    // 1400, sessions open, pane @0.5: fraction wants 669 px but allowedMax is
    // 1400 - 322 - 6 - 640 = 432 → splitter.x = 1400 - 432 - 6 = 962.
    expect(
      paneToggleWindowWidth(false, 1400, layout({ sessionsOpen: true, paneFraction: 0.5 }), 10000),
    ).toBe(962);
    // Opening from 725: the sessions column is collapsed at that width
    // (725-322 < 640) so leftChrome = 56, devin = 669, pane = 669 → 1400.
    expect(
      paneToggleWindowWidth(
        true,
        725,
        layout({ sessionsOpen: true, paneOpen: false, paneFraction: 0.5 }),
        10000,
      ),
    ).toBe(1400);
    // From a width where the column is actually visible (1400): devin = 1078,
    // pane = 1078 → target 1400 + 6 + 1078 = 2484.
    expect(
      paneToggleWindowWidth(
        true,
        1400,
        layout({ sessionsOpen: true, paneOpen: false, paneFraction: 0.5 }),
        10000,
      ),
    ).toBe(2484);
  });
});

describe('dockSurface', () => {
  it('is true for the work surfaces and false for Settings/Analytics', () => {
    const surfaces: Surface[] = ['cloud', 'local', 'claude', 'settings', 'analytics'];
    expect(surfaces.filter(dockSurface)).toEqual(['cloud', 'local', 'claude']);
    expect(dockSurface('settings')).toBe(false);
    expect(dockSurface('analytics')).toBe(false);
  });
});

describe('analytics tab strip', () => {
  it('is absent by default and leaves every rect untouched', () => {
    const base = computeBounds({ width: 1400, height: 900 }, layout());
    expect(ANALYTICS_TABS_HEIGHT).toBe(36);
    expect(base.analyticsTabs).toBeNull();
    const explicit = computeBounds({ width: 1400, height: 900 }, layout({ analyticsTabs: false }));
    expect(explicit).toEqual(base);
  });

  it('sits directly under the title bar, full main-column width, and shrinks the main rect', () => {
    const base = computeBounds({ width: 1400, height: 900 }, layout({ paneFraction: F560 }));
    const bounds = computeBounds(
      { width: 1400, height: 900 },
      layout({ paneFraction: F560, analyticsTabs: true }),
    );
    expect(bounds.analyticsTabs).toEqual({ x: 56, y: TITLE_BAR_HEIGHT, width: 778, height: 36 });
    expect(bounds.devin).toEqual({ x: 56, y: TITLE_BAR_HEIGHT + 36, width: 778, height: 864 - 36 });
    // Pane, splitter, rail and title bar are unaffected.
    expect(bounds.ghTab).toEqual(base.ghTab);
    expect(bounds.splitter).toEqual(base.splitter);
    expect(bounds.rail).toEqual(base.rail);
    expect(bounds.titleBar).toEqual(base.titleBar);
    expect(bounds.paneCollapsed).toBe(false);
  });

  it('follows the main column when the pane is closed and the sessions column is open', () => {
    const bounds = computeBounds(
      { width: 1400, height: 900 },
      layout({ paneOpen: false, sessionsOpen: true, analyticsTabs: true }),
    );
    const chrome = RAIL_WIDTH + DEFAULT_SESSIONS_WIDTH + SPLITTER_WIDTH;
    expect(bounds.analyticsTabs).toEqual({ x: chrome, y: 36, width: 1400 - chrome, height: 36 });
    expect(bounds.devin).toEqual({ x: chrome, y: 72, width: 1400 - chrome, height: 828 });
    expect(bounds.sessions?.height).toBe(864);
  });

  it('keeps the strip above an open terminal dock and never makes the main rect negative', () => {
    const bounds = computeBounds(
      { width: 1400, height: 900 },
      layout({ paneOpen: false, terminalOpen: true, terminalHeight: 280, analyticsTabs: true }),
    );
    expect(bounds.analyticsTabs?.y).toBe(36);
    expect(bounds.devin.y).toBe(72);
    expect(bounds.devin.height).toBe(900 - 36 - 36 - 280 - SPLITTER_WIDTH);
    expect(bounds.terminal?.y).toBe(900 - 280);

    const tiny = computeBounds({ width: 1400, height: 50 }, layout({ paneOpen: false, analyticsTabs: true }));
    expect(tiny.analyticsTabs?.height).toBe(14);
    expect(tiny.devin.height).toBe(0);
  });

  it('survives the pane auto-collapse path', () => {
    const bounds = computeBounds({ width: 900, height: 900 }, layout({ analyticsTabs: true }));
    expect(bounds.paneCollapsed).toBe(true);
    expect(bounds.analyticsTabs).toEqual({ x: 56, y: 36, width: 844, height: 36 });
    expect(bounds.devin).toEqual({ x: 56, y: 72, width: 844, height: 828 });
  });
});
