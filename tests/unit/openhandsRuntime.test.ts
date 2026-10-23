import { describe, expect, it, vi } from 'vitest';
import {
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
        connection: () => 'idle' as const,
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
