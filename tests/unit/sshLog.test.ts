import { describe, expect, it } from 'vitest';
import { scrubKnownAliases, scrubSshAliases } from '../../src/core/sshLog';

const hash = (alias: string): string => `h-${alias}`;

describe('scrubSshAliases', () => {
  it('replaces ssh host ids and ssh:// paths anywhere in a detail, recursively', () => {
    const detail = {
      host: 'ssh:box',
      skippedHosts: ['local', 'wsl:Ubuntu', 'ssh:dev.example'],
      workspace: 'ssh://box/home/u/proj',
      nested: { inner: ['x', { id: 'ssh:box' }] },
      count: 3,
      ok: true,
      none: null,
    };
    expect(scrubSshAliases(detail, hash)).toEqual({
      host: 'ssh:#h-box',
      skippedHosts: ['local', 'wsl:Ubuntu', 'ssh:#h-dev.example'],
      workspace: 'ssh://#h-box/home/u/proj',
      nested: { inner: ['x', { id: 'ssh:#h-box' }] },
      count: 3,
      ok: true,
      none: null,
    });
  });
  it('scrubs object keys keyed by host id and leaves other strings alone', () => {
    expect(scrubSshAliases({ 'ssh:box': 1, local: 2 }, hash)).toEqual({ 'ssh:#h-box': 1, local: 2 });
    expect(scrubSshAliases('no host here: ssh is a word', hash)).toBe('no host here: ssh is a word');
  });
  it('is a no-op (same reference) when nothing matches', () => {
    const detail = { host: 'wsl:Ubuntu', n: [1, 2] };
    expect(scrubSshAliases(detail, hash)).toBe(detail);
  });
  it('hashes the canonical (lower-case) alias', () => {
    expect(scrubSshAliases('ssh:Box', hash)).toBe('ssh:#h-box');
  });
});

describe('scrubKnownAliases (R39 #6)', () => {
  it('replaces a configured alias as a whole word in free text at any depth', () => {
    const detail = { message: 'ssh: Could not resolve hostname box: Name or service not known', nested: { list: ['to BOX.', 'x'] } };
    expect(scrubKnownAliases(detail, ['box'], hash)).toEqual({
      message: 'ssh: Could not resolve hostname ssh:#h-box: Name or service not known',
      nested: { list: ['to ssh:#h-box.', 'x'] },
    });
  });
  it('leaves partial-word matches, keys and non-strings alone', () => {
    const detail = { boxes: 'inbox sandbox box-2 box_x mybox', n: 3, box: true };
    expect(scrubKnownAliases(detail, ['box'], hash)).toBe(detail);
  });
  it('handles aliases with dots and hyphens literally', () => {
    expect(scrubKnownAliases('host dev.example-1 down; devXexample-1 ok', ['dev.example-1'], hash)).toBe(
      'host ssh:#h-dev.example-1 down; devXexample-1 ok',
    );
  });
  it('R40 c: never rewrites structural values (host ids, state/kind/op/source/reason enums)', () => {
    const detail = {
      host: 'wsl:Ubuntu',
      hosts: ['local', 'wsl:Ubuntu'],
      state: 'ready',
      kind: 'probe',
      op: 'local',
      source: 'ready',
      reason: 'local',
      nested: { host: 'local' },
    };
    expect(scrubKnownAliases(detail, ['ubuntu', 'local', 'ready', 'probe'], hash)).toBe(detail);
  });
  it('R40 c: a structural key whose value is free text is still not rewritten; other keys are', () => {
    expect(scrubKnownAliases({ reason: 'ready', message: 'ready to go' }, ['ready'], hash)).toEqual({
      reason: 'ready',
      message: 'ssh:#h-ready to go',
    });
  });
  it('R40 c: wsl:Ubuntu inside free text survives an alias "ubuntu"; a bare Ubuntu word does not', () => {
    expect(scrubKnownAliases('helper on wsl:Ubuntu; ssh to ubuntu failed', ['ubuntu'], hash)).toBe(
      'helper on wsl:Ubuntu; ssh to ssh:#h-ubuntu failed',
    );
  });
  it('R40 c: ssh:<alias> inside free text becomes ssh:#<hash> (no ssh:ssh:)', () => {
    expect(scrubKnownAliases('channel ssh:box died', ['box'], hash)).toBe('channel ssh:#h-box died');
  });
  it('R40 c: an alias as the first label of a hostname is hashed', () => {
    expect(scrubKnownAliases('connect to box.example.com port 22: refused', ['box'], hash)).toBe(
      'connect to ssh:#h-box.example.com port 22: refused',
    );
  });
  it('an already-hashed ssh:#<hash> id is never rewritten again (even if "ssh" reached the alias list)', () => {
    const text = 'helper ssh:#26f8567f down; box unreachable';
    expect(scrubKnownAliases(text, ['box'], hash)).toBe('helper ssh:#26f8567f down; ssh:#h-box unreachable');
    expect(scrubKnownAliases(text, ['box', 'ssh'], hash)).toBe('helper ssh:#26f8567f down; ssh:#h-box unreachable');
    expect(scrubKnownAliases({ m: 'ssh:#26f8567f' }, ['box', 'ssh'], hash)).toEqual({ m: 'ssh:#26f8567f' });
  });
  it('is a no-op without configured aliases', () => {
    const detail = { m: 'box' };
    expect(scrubKnownAliases(detail, [], hash)).toBe(detail);
  });
});
