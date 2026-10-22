import { describe, expect, it } from 'vitest';
import { EnumerationCache, enumOutcome, failureBackoffMs, helperSpawnGate } from '../../src/core/hostEnum';

type Row = { name: string; state: 'Running' | 'Stopped' };

/** Each run() call parks until the test resolves/rejects it. */
function controllable() {
  const calls: Array<{ resolve: (rows: Row[]) => void; reject: (e: Error) => void }> = [];
  const run = () =>
    new Promise<Row[]>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, run };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EnumerationCache', () => {
  it('concurrent refresh() calls share one run', async () => {
    const { calls, run } = controllable();
    const cache = new EnumerationCache<Row>(run);
    const a = cache.refresh();
    const b = cache.refresh();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([{ name: 'D', state: 'Running' }]);
    await Promise.all([a, b]);
    expect(cache.rows).toEqual([{ name: 'D', state: 'Running' }]);
    expect(cache.completed).toBe(true);
  });

  it('refreshFresh() never trusts an enumeration that started before the request', async () => {
    const { calls, run } = controllable();
    const cache = new EnumerationCache<Row>(run);
    // A background enumeration already in flight (its wsl -l -v predates `wsl --terminate`).
    void cache.refresh();
    const gate = cache.refreshFresh();
    calls[0]!.resolve([{ name: 'D', state: 'Running' }]);
    await flush();
    // The stale one landed; the gate is still waiting on a fresh run.
    expect(calls).toHaveLength(2);
    let settled = false;
    void gate.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    calls[1]!.resolve([{ name: 'D', state: 'Stopped' }]);
    await gate;
    expect(cache.rows).toEqual([{ name: 'D', state: 'Stopped' }]);
  });

  it('refreshFresh() joins a run that started after the request', async () => {
    const { calls, run } = controllable();
    const cache = new EnumerationCache<Row>(run);
    const gate = cache.refreshFresh();
    const other = cache.refresh();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([]);
    await Promise.all([gate, other]);
    expect(calls).toHaveLength(1);
  });

  it('a failed run keeps the previous rows, marks the cache failed and not fresh', async () => {
    const { calls, run } = controllable();
    let now = 1_000;
    const cache = new EnumerationCache<Row>(run, () => now);
    const first = cache.refresh();
    calls[0]!.resolve([{ name: 'D', state: 'Running' }]);
    await first;
    expect(cache.failed).toBe(false);
    expect(cache.isFresh(60_000)).toBe(true);
    now = 2_000;
    const second = cache.refresh();
    calls[1]!.reject(new Error('wsl.exe exited 1'));
    await second; // never throws
    expect(cache.rows).toEqual([{ name: 'D', state: 'Running' }]);
    expect(cache.failed).toBe(true);
    // Not re-run inside the failure backoff; stale once it has passed.
    expect(cache.isFresh(60_000)).toBe(true);
    now = 2_000 + 60_000;
    expect(cache.isFresh(60_000)).toBe(false);
    // A later good run clears the failure.
    const third = cache.refresh();
    calls[2]!.resolve([{ name: 'D', state: 'Stopped' }]);
    await third;
    expect(cache.failed).toBe(false);
    expect(cache.isFresh(60_000)).toBe(true);
  });

  it('a first run that fails still completes (waiters wake) with no rows', async () => {
    const { calls, run } = controllable();
    const cache = new EnumerationCache<Row>(run);
    const p = cache.refresh();
    calls[0]!.reject(new Error('x'));
    await p;
    expect(cache.completed).toBe(true);
    expect(cache.rows).toEqual([]);
    expect(cache.failed).toBe(true);
  });

  it('onSettled reports each run outcome', async () => {
    const { calls, run } = controllable();
    const seen: boolean[] = [];
    const cache = new EnumerationCache<Row>(run, Date.now, (ok) => seen.push(ok));
    const a = cache.refresh();
    calls[0]!.resolve([]);
    await a;
    const b = cache.refresh();
    calls[1]!.reject(new Error('x'));
    await b;
    expect(seen).toEqual([true, false]);
  });

  it('invalidate() makes the cache stale without dropping rows', async () => {
    const { calls, run } = controllable();
    const cache = new EnumerationCache<Row>(run);
    const a = cache.refresh();
    calls[0]!.resolve([{ name: 'D', state: 'Running' }]);
    await a;
    cache.invalidate();
    expect(cache.isFresh(60_000)).toBe(false);
    expect(cache.rows).toEqual([{ name: 'D', state: 'Running' }]);
  });

  it('a failed cache stays "fresh" for the failure backoff, then re-runs; success resets it', async () => {
    const { calls, run } = controllable();
    let now = 0;
    const cache = new EnumerationCache<Row>(run, () => now, undefined, 60_000);
    // Past cold start: one success first.
    const first = cache.refresh();
    calls[0]!.resolve([]);
    await first;
    const fail = async () => {
      const p = cache.refresh();
      calls[calls.length - 1]!.reject(new Error('timeout'));
      await p;
    };
    await fail();
    expect(cache.isFresh(300)).toBe(true); // within 60 s: no re-run on focus / backgroundReady
    now = 59_999;
    expect(cache.isFresh(300)).toBe(true);
    now = 60_000;
    expect(cache.isFresh(300)).toBe(false);
    await fail(); // 2nd failure at 60 s → 120 s window
    now = 60_000 + 119_999;
    expect(cache.isFresh(300)).toBe(true);
    now = 60_000 + 120_000;
    expect(cache.isFresh(300)).toBe(false);
    expect(cache.failed).toBe(true);
    const ok = cache.refresh();
    calls[calls.length - 1]!.resolve([]);
    await ok;
    expect(cache.failed).toBe(false);
    await fail();
    now += 60_000;
    expect(cache.isFresh(300)).toBe(false); // back to the 60 s base
  });

  it('failureBackoffMs: 60 s doubling, capped at 5 min', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => failureBackoffMs(n))).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(failureBackoffMs(2, 1_000)).toBe(2_000);
  });

  it('enumOutcome: only a timeout/kill fails; a prompt non-zero exit is an empty list', () => {
    expect(enumOutcome(0)).toBe('ok');
    expect(enumOutcome(1)).toBe('empty');
    expect(enumOutcome(-1)).toBe('empty');
    expect(enumOutcome(4294967295)).toBe('empty');
    expect(enumOutcome(null)).toBe('failed');
  });

  it('a throwing onSettled never makes refresh() reject', async () => {
    const { calls, run } = controllable();
    const cache = new EnumerationCache<Row>(run, Date.now, () => {
      throw new Error('listener bug');
    });
    const p = cache.refresh();
    calls[0]!.resolve([]);
    await expect(p).resolves.toBeUndefined();
    expect(cache.completed).toBe(true);
    const q = cache.refresh();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([]);
    await expect(q).resolves.toBeUndefined();
  });

  it('cold start: before any success the failure backoff is 10 s doubling, capped at 60 s', async () => {
    const { calls, run } = controllable();
    let now = 0;
    const cache = new EnumerationCache<Row>(run, () => now);
    const windows: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = cache.refresh();
      calls[calls.length - 1]!.reject(new Error('timeout'));
      await p;
      const failAt = now;
      let w = 0;
      while (cache.isFresh(300)) {
        w += 1_000;
        now = failAt + w;
      }
      windows.push(w);
    }
    expect(windows).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
    // After the first success the normal ladder applies.
    const ok = cache.refresh();
    calls[calls.length - 1]!.resolve([]);
    await ok;
    const p = cache.refresh();
    calls[calls.length - 1]!.reject(new Error('timeout'));
    await p;
    const failAt = now;
    now = failAt + 59_999;
    expect(cache.isFresh(300)).toBe(true);
    now = failAt + 60_000;
    expect(cache.isFresh(300)).toBe(false);
  });

  it('failureBackoffMs cold-start ladder', () => {
    expect([1, 2, 3, 4, 5].map((n) => failureBackoffMs(n, undefined, true))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('invalidate() also resets the failure count (refresh during an outage restarts at the base)', async () => {
    const { calls, run } = controllable();
    let now = 0;
    const cache = new EnumerationCache<Row>(run, () => now);
    const ok = cache.refresh();
    calls[0]!.resolve([]);
    await ok;
    for (let i = 0; i < 3; i++) {
      const p = cache.refresh();
      calls[calls.length - 1]!.reject(new Error('timeout'));
      await p;
    }
    cache.invalidate();
    const p = cache.refresh();
    calls[calls.length - 1]!.reject(new Error('timeout'));
    await p;
    now += 60_000;
    expect(cache.isFresh(300)).toBe(false); // base 60 s step, not 480 s
  });
});

describe('helperSpawnGate (R26 #4)', () => {
  it('a Running row spawns', () => {
    expect(helperSpawnGate(false, true)).toEqual({ ok: true, hold: false });
  });
  it('a non-Running / absent row refuses and holds (the next good list resets the breaker)', () => {
    expect(helperSpawnGate(false, false)).toEqual({ ok: false, hold: true });
  });
  it('a FAILED list refuses without holding: a flapping `-l -v` must not reset the breaker', () => {
    expect(helperSpawnGate(true, true)).toEqual({ ok: false, hold: false });
    expect(helperSpawnGate(true, false)).toEqual({ ok: false, hold: false });
  });
});
