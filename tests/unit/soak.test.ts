import { describe, expect, it } from 'vitest';
import { reduceEventLog, summarizeSoak } from '../../src/core/soak';

const t0 = Date.parse('2026-01-01T00:00:00Z');
const line = (offsetS: number, event: string, detail: object) =>
  JSON.stringify({ ts: new Date(t0 + offsetS * 1000).toISOString(), view: 'host', event, detail });

describe('summarizeSoak', () => {
  it('counts by kind, excludes spawn, applies the grace window', () => {
    const text = [
      line(5, 'host-exec', { host: 'wsl:A', kind: 'probe' }),
      line(70, 'host-exec', { host: 'wsl:A', kind: 'exec' }),
      line(80, 'host-exec', { host: 'wsl:A', kind: 'spawn' }),
      line(90, 'claude-list', { source: 'watch', count: 1 }),
      line(100, 'claude-list', { source: 'shell', count: 1 }),
      line(110, 'claude-list', { source: 'hosts', count: 1 }),
      line(120, 'usage-scan', { files: 3, wslFiles: 0 }),
      'not json',
      line(-10, 'host-exec', { host: 'x', kind: 'enum' }),
    ].join('\n');
    const s = summarizeSoak(text, t0, 3);
    expect(s.hostExecTotal).toBe(3);
    expect(s.hostExecByKind).toEqual({ probe: 1, exec: 1, spawn: 1 });
    expect(s.excludedLongLived).toBe(1);
    expect(s.hostExecPerMin).toBe(1);
    expect(s.hostExecPerMinPostGrace).toBe(1);
    expect(s.hostExecPerMinPostGraceExclLongLived).toBe(0.5);
    expect(s.backgroundRelistsTotal).toBe(2);
    expect(s.backgroundRelistsPerMinPostGrace).toBe(1);
    expect(s.usageScanFilesMax).toBe(3);
    expect(s.wslUsageScanFiles).toBe(0);
  });

  it('counts remote-fs-violation events by op and keeps them in the reduced log', () => {
    const text = [
      line(1, 'remote-fs-violation', { op: 'readFileSync' }),
      line(2, 'remote-fs-violation', { op: 'promises.stat', path: '\\\\wsl.localhost\\D\\x' }),
      line(3, 'host-exec', { host: 'wsl:A', kind: 'exec' }),
    ].join('\n');
    const s = summarizeSoak(text, t0, 2);
    expect(s.remoteFsViolations).toBe(2);
    expect(s.remoteFsViolationOps).toEqual({ readFileSync: 1, 'promises.stat': 1 });
    expect(summarizeSoak(line(1, 'host-exec', { kind: 'exec' }), t0, 1).remoteFsViolations).toBe(0);
    const reduced = reduceEventLog(text);
    expect(reduced).toContain('"op":"promises.stat"');
    expect(reduced).not.toContain('wsl.localhost');
  });

  it('reports null wslUsageScanFiles when the field is absent and reduces the log', () => {
    const text = [
      line(1, 'usage-scan', { files: 4 }),
      line(2, 'host-exec', { host: 'wsl:A', kind: 'exec', secret: 'x' }),
      line(3, 'other', {}),
    ].join('\n');
    expect(summarizeSoak(text, t0, 2).wslUsageScanFiles).toBeNull();
    const reduced = reduceEventLog(text);
    expect(reduced).not.toContain('secret');
    expect(reduced).not.toContain('other');
    expect(reduced.trim().split('\n')).toHaveLength(2);
  });
});

describe('helperTimings', () => {
  it('per distro: deploy ms, spawn→hello ms, store.list ms and patch counts', () => {
    const text = [
      line(1, 'host-helper-deploy', { host: 'wsl:A', ok: true, bytes: 10, ms: 420 }),
      line(2, 'host-helper', { host: 'wsl:A', state: 'starting', reason: 'spawn' }),
      line(3.5, 'host-helper', { host: 'wsl:A', state: 'ready', reason: 'hello' }),
      line(4, 'claude-store-list', { host: 'wsl:A', count: 716, ms: 900 }),
      line(9, 'claude-store-list', { host: 'wsl:A', count: 717, ms: 1300 }),
      line(10, 'claude-patch', { host: 'wsl:A', updated: 1, removed: 0 }),
      line(11, 'host-helper', { host: 'wsl:A', state: 'reconnecting', reason: 'exit' }),
      line(12, 'host-helper', { host: 'wsl:A', state: 'starting', reason: 'spawn' }),
      line(12.25, 'host-helper', { host: 'wsl:A', state: 'ready', reason: 'hello' }),
      line(20, 'host-helper', { host: 'wsl:B', state: 'starting', reason: 'spawn' }),
      line(-5, 'claude-store-list', { host: 'wsl:A', count: 1, ms: 99_999 }),
    ].join('\n');
    const s = summarizeSoak(text, t0, 1);
    expect(s.helpers['wsl:A']).toEqual({
      deployMs: [420],
      helloMs: [1500, 250],
      storeListMs: [900, 1300],
      storeListMaxMs: 1300,
      storeListCount: 717,
      patches: 1,
      readyCount: 2,
    });
    // Started, never said hello: no hello timing.
    expect(s.helpers['wsl:B']).toMatchObject({ helloMs: [], readyCount: 0 });
    // The reduced log keeps the helper events (ids/enums/counts/ms only).
    const reduced = reduceEventLog(text);
    expect(reduced).toContain('host-helper-deploy');
    expect(reduced).toContain('claude-store-list');
    expect(reduced).toContain('"state":"ready"');
    expect(reduced).not.toContain('bytes');
  });
});
