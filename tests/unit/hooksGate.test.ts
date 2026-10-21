import { describe, expect, it } from 'vitest';
import { buildHooksBlock, hooksApplyKey } from '../../src/core/claudeHooks';

const block = (port: number, addr?: string) =>
  buildHooksBlock({ port, auth: { kind: 'token', token: 't' }, ...(addr ? { addr } : {}) });

describe('hooksApplyKey', () => {
  it('is stable for equal input', () => {
    expect(hooksApplyKey('wsl:U', true, block(50000))).toBe(hooksApplyKey('wsl:U', true, block(50000)));
  });
  it('changes with enabled', () => {
    expect(hooksApplyKey('wsl:U', true, block(50000))).not.toBe(hooksApplyKey('wsl:U', false, block(50000)));
  });
  it('changes when a block URL changes (port or address)', () => {
    expect(hooksApplyKey('wsl:U', true, block(50000))).not.toBe(hooksApplyKey('wsl:U', true, block(50001)));
    expect(hooksApplyKey('wsl:U', true, block(50000))).not.toBe(
      hooksApplyKey('wsl:U', true, block(50000, '172.20.0.1')),
    );
  });
  it('changes with the host id', () => {
    expect(hooksApplyKey('local', true, block(50000))).not.toBe(hooksApplyKey('wsl:U', true, block(50000)));
  });
});
