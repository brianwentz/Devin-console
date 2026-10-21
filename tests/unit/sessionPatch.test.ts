import { describe, expect, it } from 'vitest';
import { patchSessions, type ClaudeStoreSession } from '../../src/core/claudeRegistry';

const row = (id: string, host: string, extra: Partial<ClaudeStoreSession> = {}): ClaudeStoreSession => ({
  id,
  host: host as ClaudeStoreSession['host'],
  title: `t-${id}`,
  cwd: '/home/u/p',
  gitBranch: null,
  tag: null,
  createdAt: 1,
  lastModified: 1,
  fileSize: 10,
  ...extra,
});

describe('patchSessions', () => {
  const prev = [row('l1', 'local'), row('w1', 'wsl:D'), row('w2', 'wsl:D'), row('o1', 'wsl:Other')];

  it('replaces an existing row of the host in place', () => {
    const next = patchSessions(prev, 'wsl:D', [row('w1', 'wsl:D', { title: 'new', lastModified: 9 })], []);
    expect(next.map((s) => s.id)).toEqual(['l1', 'w1', 'w2', 'o1']);
    expect(next[1]).toMatchObject({ id: 'w1', title: 'new', lastModified: 9 });
    expect(next).toHaveLength(4);
  });

  it('inserts an unseen session', () => {
    const next = patchSessions(prev, 'wsl:D', [row('w3', 'wsl:D')], []);
    expect(next.map((s) => s.id)).toEqual(['l1', 'w1', 'w2', 'o1', 'w3']);
  });

  it('stamps the patched host on updated rows', () => {
    const next = patchSessions(prev, 'wsl:D', [row('w3', 'local')], []);
    expect(next.find((s) => s.id === 'w3')?.host).toBe('wsl:D');
  });

  it('removes deleted transcripts of that host only', () => {
    const next = patchSessions(prev, 'wsl:D', [], ['w2', 'l1', 'o1']);
    expect(next.map((s) => s.id)).toEqual(['l1', 'w1', 'o1']);
  });

  it('a removed id wins over an update for the same id', () => {
    const next = patchSessions(prev, 'wsl:D', [row('w1', 'wsl:D', { title: 'x' })], ['w1']);
    expect(next.map((s) => s.id)).toEqual(['l1', 'w2', 'o1']);
  });

  it('leaves other hosts untouched (same objects)', () => {
    const next = patchSessions(prev, 'wsl:D', [row('l1', 'wsl:D'), row('o1', 'wsl:D', { title: 'clash' })], []);
    expect(next[0]).toBe(prev[0]);
    expect(next.find((s) => s.host === 'wsl:Other')).toBe(prev[3]);
    // same id on another host is a distinct row
    expect(next.filter((s) => s.id === 'o1')).toHaveLength(2);
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(prev));
    patchSessions(prev, 'wsl:D', [row('w9', 'wsl:D')], ['w1']);
    expect(prev).toEqual(copy);
  });
});
