import { describe, expect, it } from 'vitest';
import { EnumerationCache } from '../../src/core/hostEnum';

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
});
