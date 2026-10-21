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
