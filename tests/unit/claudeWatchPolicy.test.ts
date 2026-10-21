import { describe, expect, it } from 'vitest';
import { mergeRefreshHosts, throttleDue } from '../../src/core/claudeWatchPolicy';

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
