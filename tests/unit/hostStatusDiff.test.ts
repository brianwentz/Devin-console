import { describe, expect, it } from 'vitest';
import { parseNodeVersion, parseProbeOutput, statusesChanged } from '../../src/core/execHost';
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
  it('reads home and shell', () => {
    expect(parseProbeOutput('/home/u\nu\n/bin/zsh\n')).toEqual({ home: '/home/u', shell: '/bin/zsh' });
  });
  it('keeps the shell empty when getent printed nothing', () => {
    expect(parseProbeOutput('/home/u\nu\n')).toEqual({ home: '/home/u', shell: undefined });
  });
});

describe('parseNodeVersion', () => {
  const env = '\0__DW_ENV__\0HOME=/home/u\0PATH=/x\0';
  it('reads the version after the second marker', () => {
    expect(parseNodeVersion(`${env}\0__DW_NODE__\0v-ignored\n22.4.1\n`)).toBe('22.4.1');
    expect(parseNodeVersion(`${env}\0__DW_NODE__\x0022.4.1\n`)).toBe('22.4.1');
  });
  it('maps NONODE to null', () => {
    expect(parseNodeVersion(`${env}\0__DW_NODE__\0NONODE\n`)).toBeNull();
  });
  it('is null when the second marker is missing', () => {
    expect(parseNodeVersion(env)).toBeNull();
  });
  it('accepts bytes', () => {
    expect(parseNodeVersion(new TextEncoder().encode(`${env}\0__DW_NODE__\x0018.0.0\n`))).toBe('18.0.0');
  });
});
