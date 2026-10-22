import { describe, expect, it } from 'vitest';
import {
  HOOKS_OFF_BACKOFF_MAX_MS,
  HOOKS_OFF_BACKOFF_MS,
  HOOKS_OFF_HELPER_UNAVAILABLE,
  hooksOffChannelDown,
  hooksOffDue,
  hooksOffFailed,
  hooksOffSpawnError,
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

describe('hooks opt-out error text (self-review L3/L4)', () => {
  it('a spawn rejection maps to a fixed message keeping only the errno code', () => {
    const enoent = Object.assign(new Error('spawn C:\\Windows\\System32\\wsl.exe ENOENT'), { code: 'ENOENT' });
    expect(hooksOffSpawnError(enoent)).toBe('hooks removal failed (spawn ENOENT)');
    expect(hooksOffSpawnError(new Error('wsl.exe not found at C:\\x'))).toBe('hooks removal failed (spawn)');
    expect(hooksOffSpawnError('weird')).toBe('hooks removal failed (spawn)');
    // A code that isn't a plain errno token is dropped, never echoed.
    expect(hooksOffSpawnError(Object.assign(new Error('x'), { code: 'C:\\path' }))).toBe(
      'hooks removal failed (spawn)',
    );
  });

  it('opt-out with the channel down: a degraded helper is reported, a (re)starting one waits', () => {
    expect(hooksOffChannelDown('degraded')).toBe(HOOKS_OFF_HELPER_UNAVAILABLE);
    expect(HOOKS_OFF_HELPER_UNAVAILABLE).toBe("Couldn't remove hooks: helper unavailable");
    for (const state of ['starting', 'reconnecting', 'absent', null, undefined]) {
      expect(hooksOffChannelDown(state)).toBeNull();
    }
  });
});
