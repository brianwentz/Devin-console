import { describe, expect, it } from 'vitest';
import { mergeRefreshHosts, statusRefreshTargets, throttleDue } from '../../src/core/claudeWatchPolicy';

describe('throttleDue', () => {
  it('is due when never run', () => {
    expect(throttleDue(null, 5, 60_000)).toBe(true);
  });
  it('is not due within the window', () => {
    expect(throttleDue(1_000, 60_999, 60_000)).toBe(false);
  });
  it('is due once the window elapsed', () => {
    expect(throttleDue(1_000, 61_000, 60_000)).toBe(true);
  });
});

describe('mergeRefreshHosts', () => {
  it('null (all hosts) absorbs any filter', () => {
    expect(mergeRefreshHosts(null, new Set(['local']))).toBeNull();
    expect(mergeRefreshHosts(new Set(['local']), null)).toBeNull();
  });
  it('unions two filters', () => {
    expect([...mergeRefreshHosts(new Set(['local']), new Set(['wsl:D']))!].sort()).toEqual([
      'local',
      'wsl:D',
    ]);
  });
});

describe('statusRefreshTargets (R27)', () => {
  it('local plus every WSL host whose store is not watching yet — ready or not', () => {
    expect(
      statusRefreshTargets([
        { id: 'local', wsl: false, watching: true },
        { id: 'wsl:Slow', wsl: true, watching: false }, // still probing: reported as skipped, no I/O
        { id: 'wsl:New', wsl: true, watching: false },
        { id: 'wsl:Live', wsl: true, watching: true }, // resyncs itself on channel return
      ]),
    ).toEqual(['local', 'wsl:Slow', 'wsl:New']);
  });
  it('local is always a target', () => {
    expect(statusRefreshTargets([])).toEqual(['local']);
  });
});
