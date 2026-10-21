import { describe, expect, it } from 'vitest';
import { AGENTS_TIMEOUT_MS, listAgents } from '../../../src/helper/agents';

describe('helper agents.list', () => {
  it('runs `claude agents --json --all` with a 5 s timeout and returns raw stdout', async () => {
    const calls: unknown[][] = [];
    const r = await listAgents(undefined, (file, args, opts, cb) => {
      calls.push([file, args, opts.timeout]);
      cb(null, '[{"id":"a1"}]');
    });
    expect(r).toEqual({ stdout: '[{"id":"a1"}]' });
    expect(calls).toEqual([['claude', ['agents', '--json', '--all'], 5_000]]);
    expect(AGENTS_TIMEOUT_MS).toBe(5_000);
  });

  it('a failure reports only its kind, never the output', async () => {
    const fail = (error: Error & { code?: unknown; killed?: boolean }) =>
      listAgents('/opt/claude', (_f, _a, _o, cb) => cb(error, 'secret output'));
    await expect(fail(Object.assign(new Error('spawn /opt/claude ENOENT'), { code: 'ENOENT' }))).rejects.toMatchObject({
      code: 'internal',
      message: 'claude agents failed: ENOENT',
    });
    await expect(fail(Object.assign(new Error('killed'), { killed: true }))).rejects.toMatchObject({
      message: 'claude agents failed: timeout',
    });
  });
});
