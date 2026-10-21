import { describe, expect, it } from 'vitest';
import { summarizeSoak } from '../../src/core/soak';

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
      line(120, 'usage-scan', { files: 3 }),
      'not json',
      line(-10, 'host-exec', { host: 'x', kind: 'enum' }),
    ].join('\n');
    const s = summarizeSoak(text, t0, 3);
    expect(s.hostExecTotal).toBe(3);
    expect(s.hostExecByKind).toEqual({ probe: 1, exec: 1, spawn: 1 });
    expect(s.excludedLongLived).toBe(1);
    expect(s.hostExecPerMin).toBe(1);
    expect(s.hostExecPerMinPostGrace).toBe(1);
    expect(s.hostExecPerMinPostGraceExclSpawn).toBe(0.5);
    expect(s.claudeListTotal).toBe(2);
    expect(s.wslClaudeListPerMinPostGrace).toBe(1);
    expect(s.usageScanFilesMax).toBe(3);
  });
});
