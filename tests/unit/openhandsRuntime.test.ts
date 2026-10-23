import { describe, expect, it, vi } from 'vitest';
import type { OpenHandsConnection } from '../../src/shared/ipc';
import {
  authBackoffMs,
  cacheMatchesTenant,
  createOpenHandsRuntimeCore,
  type CoreController,
  type CoreSource,
  type OhSettingsLike,
} from '../../src/main/openhands/runtimeCore';

const settings = (baseUrl: string, pollSeconds = 30): OhSettingsLike => ({ openhands: { baseUrl, pollSeconds } });

function harness(opts: { key?: boolean; cache?: boolean; focused?: boolean; mutateOk?: boolean } = {}) {
  let changes = 0;
  let base = 'https://a.test';
  let poll = 30;
  let connection: OpenHandsConnection = 'idle';
  let clock = 1_000_000;
  const built: { base: string; source: CoreSource & { listing: boolean }; controller: CoreController }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const calls: string[] = [];
  const core = createOpenHandsRuntimeCore({
    currentBase: () => base,
    baseOf: (s) => s.openhands.baseUrl,
    pollSeconds: () => poll,
    pollMs: (s) => s * 1000,
    build: (b) => {
      const source = {
        listing: false,
        requestFull: vi.fn(() => calls.push('full')),
        isListing() {
          return this.listing;
        },
        connection: () => connection,
      };
      const controller: CoreController = {
        start: vi.fn(async () => {
          calls.push('start');
        }),
        stop: vi.fn(() => {
          calls.push('stop');
        }),
        refresh: vi.fn(async (reason: string) => {
          calls.push(`refresh:${reason}`);
        }),
        snapshot: vi.fn() as never,
        drain: vi.fn(async () => {
          calls.push('drain');
        }),
        mutate: vi.fn(async (op: { op: string }) => {
          calls.push(`mutate:${op.op}`);
          return opts.mutateOk ?? true;
        }),
      };
      built.push({ base: b, source, controller });
      return { source, controller };
    },
    hasKey: async () => opts.key ?? false,
    cacheMatches: async () => opts.cache ?? false,
    dropCache: vi.fn(async () => {
      calls.push('drop');
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    now: () => clock,
    focused: () => opts.focused ?? true,
    onChange: () => {
      changes++;
    },
    log: () => {},
  });
  const live = () => timers.filter((t) => !t.cleared);
  return {
    core,
    built,
    timers,
    calls,
    changes: () => changes,
    live,
    setBase: (b: string) => (base = b),
    setPoll: (n: number) => (poll = n),
    advance: (ms: number) => (clock += ms),
    setConnection: (c: OpenHandsConnection) => (connection = c),
  };
}

describe('openhands runtime core', () => {
  it('gate(): pending until start settles, closed with no gate, open once a gate opens', async () => {
    const h = harness();
    expect(h.core.gate()).toBe('pending');
    const started = h.core.start();
    expect(h.core.gate()).toBe('pending');
    await started;
    expect(h.core.gate()).toBe('closed');
    h.core.onSurfaceEnter();
    expect(h.core.gate()).toBe('open');
    const keyed = harness({ key: true });
    await keyed.core.start();
    expect(keyed.core.gate()).toBe('open');
  });

  it('opens no gate on its own: no build, no timer, no focus refresh', async () => {
    const h = harness();
    await h.core.start();
    h.core.onFocus();
    expect(h.built).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
    expect(h.core.snapshot()).toBeNull();
  });

  it('gate (a): a stored API key opens at start', async () => {
    const h = harness({ key: true });
    await h.core.start();
    expect(h.built).toHaveLength(1);
    expect(h.calls).toContain('start');
    expect(h.live()).toHaveLength(1);
  });

  it('gate (c): a cache for this tenant opens at start', async () => {
    const h = harness({ cache: true });
    await h.core.start();
    expect(h.built).toHaveLength(1);
  });

  it('gate (b): entering the surface opens it once, and it stays open', async () => {
    const h = harness();
    await h.core.start();
    h.core.onSurfaceEnter();
    h.core.onSurfaceEnter();
    expect(h.built).toHaveLength(1);
    h.core.onFocus();
    expect(h.calls).toContain('refresh:focus');
  });

  it('onCredentialsChanged opens the gate only when a key is set', async () => {
    const h = harness();
    await h.core.start();
    await h.core.onCredentialsChanged(false);
    expect(h.built).toHaveLength(0);
    await h.core.onCredentialsChanged(true);
    expect(h.built).toHaveLength(1);
  });

  it('a poll tick is skipped while a list is in flight, then re-arms', async () => {
    const h = harness({ key: true });
    await h.core.start();
    h.built[0]!.source.listing = true;
    const tick = h.live()[0]!;
    tick.fn();
    await Promise.resolve();
    expect(h.calls.filter((c) => c === 'refresh:poll')).toHaveLength(0);
    expect(h.timers).toHaveLength(2);
    expect(h.timers[1]).not.toBe(tick);

    h.built[0]!.source.listing = false;
    h.timers[1]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.filter((c) => c === 'refresh:poll')).toHaveLength(1);
  });

  it('blurred polls run at 4x the interval', async () => {
    const h = harness({ key: true, focused: false });
    await h.core.start();
    expect(h.live()[0]!.ms).toBe(30 * 1000 * 4);
  });

  it('focus runs a full list and restarts the poll timer', async () => {
    const h = harness({ key: true });
    await h.core.start();
    const before = h.live()[0]!;
    h.core.onFocus();
    expect(h.calls.slice(-2)).toEqual(['full', 'refresh:focus']);
    expect(before.cleared).toBe(true);
    expect(h.live()).toHaveLength(1);
  });

  it('a baseUrl change drains and drops the old cache, then starts a fresh source', async () => {
    const h = harness({ key: true });
    await h.core.start();
    h.setBase('https://b.test');
    await h.core.onSettingsChanged(settings('https://a.test'), settings('https://b.test'));
    expect(h.built).toHaveLength(2);
    expect(h.built[1]!.base).toBe('https://b.test');
    expect(h.built[0]!.controller.stop).toHaveBeenCalled();
    const i = h.calls.indexOf('stop');
    expect(h.calls.slice(i, i + 3)).toEqual(['stop', 'drain', 'drop']);
    expect(h.calls.lastIndexOf('start')).toBeGreaterThan(h.calls.indexOf('drop'));
  });

  it('only a pollSeconds or baseUrl change reschedules', async () => {
    const h = harness({ key: true });
    await h.core.start();
    const t = h.live()[0]!;
    await h.core.onSettingsChanged(settings('https://a.test', 30), settings('https://a.test', 30));
    expect(h.live()[0]).toBe(t);
    h.setPoll(60);
    await h.core.onSettingsChanged(settings('https://a.test', 30), settings('https://a.test', 60));
    expect(t.cleared).toBe(true);
    expect(h.live()[0]!.ms).toBe(60 * 1000);
  });

  it('a settings change before the gate opens does nothing', async () => {
    const h = harness();
    await h.core.start();
    await h.core.onSettingsChanged(settings('https://a.test'), settings('https://b.test'));
    expect(h.built).toHaveLength(0);
    expect(h.calls).toEqual([]);
  });

  it('dispose clears the timer and stops without throwing even if stop throws', async () => {
    const h = harness({ key: true });
    await h.core.start();
    (h.built[0]!.controller.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(h.core.dispose()).resolves.toBeUndefined();
    expect(h.live()).toHaveLength(0);
    h.core.onSurfaceEnter();
    expect(h.built).toHaveLength(1);
  });
});

describe('mutate', () => {
  it('is a no-op (false) before any gate opens', async () => {
    const h = harness();
    await h.core.start();
    await expect(h.core.mutate({ op: 'delete', id: 'x' })).resolves.toBe(false);
    expect(h.built).toHaveLength(0);
  });

  it('delegates to the active controller once open', async () => {
    const h = harness({ key: true });
    await h.core.start();
    await expect(h.core.mutate({ op: 'rename', id: 'x', title: 't' })).resolves.toBe(true);
    expect(h.calls).toContain('mutate:rename');
  });

  it('is false when the controller reports a failed mutation', async () => {
    const h = harness({ key: true, mutateOk: false });
    await h.core.start();
    await expect(h.core.mutate({ op: 'delete', id: 'x' })).resolves.toBe(false);
  });

  it('with no gate open holds a not-connected error and notifies', async () => {
    const h = harness();
    await h.core.start();
    expect(h.core.localError()).toBeNull();
    await h.core.mutate({ op: 'rename', id: 'x', title: 't' });
    expect(h.core.localError()).toEqual({ op: 'rename', message: 'not-connected' });
    expect(h.changes()).toBe(1);
    await h.core.mutate({ op: 'delete', id: 'x' });
    expect(h.core.localError()).toEqual({ op: 'delete', message: 'not-connected' });
  });

  it('clears the not-connected error when the gate opens', async () => {
    const h = harness();
    await h.core.start();
    await h.core.mutate({ op: 'delete', id: 'x' });
    h.core.onSurfaceEnter();
    expect(h.core.localError()).toBeNull();
  });
});

describe('cacheMatchesTenant (gate c)', () => {
  const cache = (tenantUrl: string) => ({
    version: 1,
    tenantUrl,
    savedAt: '2026-10-20T10:00:00.000Z',
    sessions: [],
    folders: [],
    folderTotals: {},
  });
  it('matches only this tenant', () => {
    expect(cacheMatchesTenant(cache('https://a.test'), 'https://a.test')).toBe(true);
    expect(cacheMatchesTenant(cache('https://a.test'), 'https://b.test')).toBe(false);
  });
  it('rejects junk and missing files', () => {
    expect(cacheMatchesTenant(null, 'https://a.test')).toBe(false);
    expect(cacheMatchesTenant({ nope: 1 }, 'https://a.test')).toBe(false);
  });
});

describe('openhands runtime core: signed-out poll backoff', () => {
  const MIN = 60_000;
  const last = (h: ReturnType<typeof harness>) => h.live().at(-1)!;
  // Fires the pending poll tick and lets its list + reschedule settle.
  const tickOnce = async (h: ReturnType<typeof harness>) => {
    last(h).fn();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('authBackoffMs multiplies x4 per refusal, caps at 16 min, never drops below the base', () => {
    expect(authBackoffMs(30_000, 0)).toBe(30_000);
    expect(authBackoffMs(30_000, 1)).toBe(120_000);
    expect(authBackoffMs(30_000, 2)).toBe(480_000);
    expect(authBackoffMs(30_000, 3)).toBe(16 * MIN);
    expect(authBackoffMs(30_000, 9)).toBe(16 * MIN);
    expect(authBackoffMs(20 * MIN, 2)).toBe(20 * MIN);
  });

  it('stretches the next tick per consecutive refused list and caps at 16 min', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await Promise.resolve();
    await Promise.resolve();
    // start() list was refused once: 30 s -> 120 s
    expect(last(h).ms).toBe(120_000);
    await tickOnce(h);
    expect(last(h).ms).toBe(480_000);
    await tickOnce(h);
    expect(last(h).ms).toBe(16 * MIN);
    await tickOnce(h);
    expect(last(h).ms).toBe(16 * MIN);
  });

  it('api-key-rejected backs off too; becoming authenticated resets', async () => {
    const h = harness({ key: true });
    h.setConnection('api-key-rejected');
    await h.core.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(last(h).ms).toBe(120_000);
    h.setConnection('web-session');
    await tickOnce(h);
    expect(last(h).ms).toBe(30_000);
  });

  it('credentials change resets the backoff (and applies it at once)', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await Promise.resolve();
    await Promise.resolve();
    await tickOnce(h);
    expect(last(h).ms).toBe(480_000);
    h.setConnection('api-key');
    await h.core.onCredentialsChanged(true);
    expect(last(h).ms).toBe(30_000);
  });

  it('surface entry resets the backoff', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await Promise.resolve();
    await Promise.resolve();
    await tickOnce(h);
    expect(last(h).ms).toBe(480_000);
    h.core.onSurfaceEnter();
    expect(last(h).ms).toBe(30_000);
  });

  it('a successful focus refresh resets; a refused one keeps backing off', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await Promise.resolve();
    await Promise.resolve();
    h.core.onFocus();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(last(h).ms).toBe(480_000);
    h.setConnection('web-session');
    h.core.onFocus();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(last(h).ms).toBe(30_000);
  });
});

describe('openhands runtime core: sign-in recovery', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const pollLists = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.startsWith('refresh:')).length;

  it('a forced refresh that comes back authenticated re-arms the timer at the base cadence', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await settle();
    for (let i = 0; i < 2; i++) {
      h.live().at(-1)!.fn();
      await settle();
    }
    expect(h.live().at(-1)!.ms).toBe(16 * 60_000);
    h.setConnection('web-session');
    await h.core.forceRefresh();
    expect(h.live().at(-1)!.ms).toBe(30_000);
  });

  it('a view navigating home while refused lists at once and resets the backoff', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await settle();
    h.live().at(-1)!.fn();
    await settle();
    expect(h.live().at(-1)!.ms).toBe(480_000);
    const before = pollLists(h);
    h.core.onViewNavigatedHome();
    await settle();
    expect(pollLists(h)).toBe(before + 1);
    // Reset to zero, then the (still refused) list counts once: 4x, not 16x.
    expect(h.live().at(-1)!.ms).toBe(120_000);
    // Signed in: the next refresh runs at the base cadence.
    h.setConnection('web-session');
    h.advance(6_000);
    h.core.onViewNavigatedHome();
    expect(pollLists(h)).toBe(before + 1);
  });

  it('ignores a navigation while the connection is not refused', async () => {
    const h = harness({ key: true });
    h.setConnection('web-session');
    await h.core.start();
    await settle();
    const before = pollLists(h);
    h.core.onViewNavigatedHome();
    await settle();
    expect(pollLists(h)).toBe(before);
  });

  it('two navigations within 5 s list once; a later one lists again', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await settle();
    const before = pollLists(h);
    h.core.onViewNavigatedHome();
    await settle();
    h.advance(2_000);
    h.core.onViewNavigatedHome();
    await settle();
    expect(pollLists(h)).toBe(before + 1);
    h.advance(4_000);
    h.core.onViewNavigatedHome();
    await settle();
    expect(pollLists(h)).toBe(before + 2);
  });

  it('a navigation inside the window leaves one trailing hint that lists when the window ends', async () => {
    const h = harness({ key: true });
    h.setConnection('login-required');
    await h.core.start();
    await settle();
    const before = pollLists(h);
    h.core.onViewNavigatedHome();
    h.advance(1_000);
    h.core.onViewNavigatedHome();
    h.core.onViewNavigatedHome();
    await settle();
    expect(pollLists(h)).toBe(before + 1);
    const trailing = h.timers.filter((t) => t.ms === 4_000 && !t.cleared);
    expect(trailing).toHaveLength(1);
    h.advance(4_000);
    trailing[0]!.fn();
    await settle();
    expect(pollLists(h)).toBe(before + 2);
  });
});
