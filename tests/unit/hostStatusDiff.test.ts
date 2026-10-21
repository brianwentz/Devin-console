import { describe, expect, it } from 'vitest';
import { parseProbeOutput, statusesChanged } from '../../src/core/execHost';
import type { HostStatus } from '../../src/shared/ipc';

const row = (over: Partial<HostStatus> = {}): HostStatus => ({
  id: 'wsl:U',
  kind: 'wsl',
  label: 'U',
  state: 'ready',
  error: null,
  probedAt: '2026-01-01T00:00:00.000Z',
  home: '/home/u',
  shell: '/bin/bash',
  node: '22.1.0',
  claude: { path: '/c', version: '1' },
  devin: { path: null },
  shellEnv: { ok: true, count: 3, ms: 40 },
  hooks: 'ok',
  inotify: false,
  gh: false,
  ...over,
});

describe('statusesChanged', () => {
  it('is true for a null prev', () => {
    expect(statusesChanged(null, [row()])).toBe(true);
  });
  it('is false for a structural clone, ignoring timestamps and timings', () => {
    const next = [row({ probedAt: '2027-01-01T00:00:00.000Z', shellEnv: { ok: true, count: 3, ms: 999 } })];
    expect(statusesChanged([row()], next)).toBe(false);
  });
  it('is true when state, env.ok or claude.path changes', () => {
    expect(statusesChanged([row()], [row({ state: 'error' })])).toBe(true);
    expect(statusesChanged([row()], [row({ shellEnv: { ok: false, count: 3, ms: 40 } })])).toBe(true);
    expect(statusesChanged([row()], [row({ claude: { path: '/d', version: '1' } })])).toBe(true);
  });
  it('is true when rows are added or removed', () => {
    expect(statusesChanged([row()], [row(), row({ id: 'wsl:V' })])).toBe(true);
  });
});

describe('parseProbeOutput', () => {
  it('reads home, shell and node version', () => {
    expect(parseProbeOutput('/home/u\nu\n/bin/zsh\n22.4.1\n')).toEqual({
      home: '/home/u',
      shell: '/bin/zsh',
      node: '22.4.1',
    });
  });
  it('maps NONODE to null', () => {
    expect(parseProbeOutput('/home/u\nu\n/bin/bash\nNONODE\n').node).toBeNull();
  });
  it('keeps the shell empty when getent printed nothing', () => {
    expect(parseProbeOutput('/home/u\nu\n18.0.0\n')).toEqual({ home: '/home/u', shell: undefined, node: '18.0.0' });
  });
  it('treats a legacy three-line answer as no node', () => {
    expect(parseProbeOutput('/home/u\nu\n/bin/bash\n').node).toBeNull();
  });
});
