import { describe, expect, it } from 'vitest';
import {
  HOOKS_OFF_BACKOFF_MAX_MS,
  HOOKS_OFF_BACKOFF_MS,
  hooksOffDue,
  hooksOffFailed,
} from '../../src/core/hooksOffBackoff';

describe('hooks-off one-shot backoff', () => {
  it('is due with no failure recorded', () => {
    expect(hooksOffDue(undefined, 0)).toBe(true);
  });

  it('60 s after the first failure, doubling per consecutive failure, capped at 1 h', () => {
    let b = hooksOffFailed(undefined, 1_000);
    expect(b).toEqual({ failures: 1, nextAt: 1_000 + HOOKS_OFF_BACKOFF_MS });
    const delays = [HOOKS_OFF_BACKOFF_MS];
    for (let i = 0; i < 10; i++) {
      b = hooksOffFailed(b, 0);
      delays.push(b.nextAt);
    }
    expect(delays.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(Math.max(...delays)).toBe(HOOKS_OFF_BACKOFF_MAX_MS);
    expect(HOOKS_OFF_BACKOFF_MAX_MS).toBe(3_600_000);
  });

  it('not due inside the window, due once it has passed', () => {
    const b = hooksOffFailed(undefined, 10_000);
    expect(hooksOffDue(b, 10_000)).toBe(false);
    expect(hooksOffDue(b, 10_000 + HOOKS_OFF_BACKOFF_MS - 1)).toBe(false);
    expect(hooksOffDue(b, 10_000 + HOOKS_OFF_BACKOFF_MS)).toBe(true);
  });

  it('scales with a test base', () => {
    expect(hooksOffFailed(undefined, 0, 100).nextAt).toBe(100);
    expect(hooksOffFailed({ failures: 30, nextAt: 0 }, 0, 100).nextAt).toBe(HOOKS_OFF_BACKOFF_MAX_MS / 600);
  });
});
