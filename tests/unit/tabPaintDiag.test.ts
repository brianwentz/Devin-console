import { describe, expect, it } from 'vitest';
import { captureRect, overlaps, pixelStats, sameRect, stackInfo } from '../../src/core/tabPaintDiag';

const full = { x: 0, y: 0, width: 1400, height: 900 };
const devin = { x: 48, y: 36, width: 680, height: 864 };
const pane = { x: 730, y: 36, width: 670, height: 864 };

describe('overlaps', () => {
  it('needs a shared area', () => {
    expect(overlaps(devin, pane)).toBe(false);
    expect(overlaps(full, pane)).toBe(true);
    expect(overlaps({ x: 0, y: 0, width: 730, height: 900 }, pane)).toBe(false);
    expect(overlaps({ x: 0, y: 0, width: 731, height: 900 }, pane)).toBe(true);
    expect(overlaps({ x: 0, y: 0, width: 0, height: 0 }, pane)).toBe(false);
  });
});

describe('stackInfo', () => {
  it('reports a tab above the shell as uncovered', () => {
    const info = stackInfo([
      { bounds: full, isShell: true, isTab: false },
      { bounds: devin, isShell: false, isTab: false },
      { bounds: pane, isShell: false, isTab: true },
    ]);
    expect(info).toEqual({ attached: true, index: 2, childCount: 3, shellIndex: 0, coveredBy: 0, shellAbove: false });
  });

  it('counts only overlapping views above the tab', () => {
    const info = stackInfo([
      { bounds: full, isShell: false, isTab: false },
      { bounds: pane, isShell: false, isTab: true },
      { bounds: devin, isShell: false, isTab: false },
      { bounds: full, isShell: true, isTab: false },
    ]);
    expect(info).toMatchObject({ index: 1, shellIndex: 3, coveredBy: 1, shellAbove: true });
  });

  it('reports a detached tab', () => {
    const info = stackInfo([{ bounds: full, isShell: true, isTab: false }]);
    expect(info).toEqual({ attached: false, index: -1, childCount: 1, shellIndex: 0, coveredBy: 0, shellAbove: false });
  });
});

describe('sameRect', () => {
  it('compares every field and nulls', () => {
    expect(sameRect(pane, { ...pane })).toBe(true);
    expect(sameRect(pane, { ...pane, height: 863 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(pane, null)).toBe(false);
  });
});

describe('captureRect', () => {
  it('maps the view into display pixels with an inset', () => {
    const rect = captureRect({ x: 100, y: 50, width: 1400, height: 900 }, pane, { x: 0, y: 0, width: 1920, height: 1080 }, 1.5, {
      width: 2880,
      height: 1620,
    });
    expect(rect).toEqual({ x: (100 + 730 + 16) * 1.5, y: (50 + 36 + 16) * 1.5, width: 638 * 1.5, height: 832 * 1.5 });
  });

  it('is relative to the display origin and clamped to the image', () => {
    const rect = captureRect({ x: 1900, y: 0, width: 1400, height: 900 }, pane, { x: 1920, y: 0, width: 1920, height: 1080 }, 1, {
      width: 1920,
      height: 1080,
    });
    // left edge = 1900 - 1920 + 730 + 16 = 726
    expect(rect).toEqual({ x: 726, y: 52, width: 638, height: 832 });
    const display = { x: 0, y: 0, width: 1920, height: 1080 };
    const image = { width: 1920, height: 1080 };
    // Partly off the right edge: 1000 + 730 + 16 = 1746, clipped at 1920.
    expect(captureRect({ x: 1000, y: 0, width: 1400, height: 900 }, pane, display, 1, image)).toEqual({
      x: 1746,
      y: 52,
      width: 174,
      height: 832,
    });
    // Wholly off the image.
    expect(captureRect({ x: 1500, y: 0, width: 1400, height: 900 }, pane, display, 1, image)).toBeNull();
  });

  it('returns null for a zero-size view', () => {
    expect(captureRect(full, { x: 0, y: 0, width: 0, height: 0 }, full, 1, { width: 1400, height: 900 })).toBeNull();
  });
});

function bitmap(pixels: Array<[number, number, number]>): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => out.set([b, g, r, 255], i * 4));
  return out;
}

describe('pixelStats', () => {
  it('flags a pane showing only the dark background', () => {
    const stats = pixelStats(bitmap(Array.from({ length: 100 }, () => [0x11, 0x18, 0x27] as [number, number, number])), 1);
    expect(stats).toEqual({ samples: 100, bgFraction: 1, darkFraction: 1, uniformFraction: 1 });
  });

  it('tells a dark-themed page from the blank background', () => {
    // GitHub dark #0d1117 is dark but not the pane background.
    const stats = pixelStats(bitmap(Array.from({ length: 50 }, () => [0x0d, 0x11, 0x17] as [number, number, number])), 1);
    expect(stats.bgFraction).toBe(0);
    expect(stats.darkFraction).toBe(1);
  });

  it('measures a painted light page', () => {
    const px: Array<[number, number, number]> = [
      ...Array.from({ length: 75 }, () => [255, 255, 255] as [number, number, number]),
      ...Array.from({ length: 25 }, () => [0x11, 0x18, 0x27] as [number, number, number]),
    ];
    expect(pixelStats(bitmap(px), 1)).toEqual({ samples: 100, bgFraction: 0.25, darkFraction: 0.25, uniformFraction: 0.75 });
  });

  it('samples every step-th pixel', () => {
    const px = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? [255, 255, 255] : [0, 0, 0]) as [number, number, number]);
    expect(pixelStats(bitmap(px), 2)).toMatchObject({ samples: 5, darkFraction: 0, uniformFraction: 1 });
  });

  it('handles an empty bitmap', () => {
    expect(pixelStats(new Uint8Array(0))).toEqual({ samples: 0, bgFraction: 0, darkFraction: 0, uniformFraction: 0 });
  });
});
