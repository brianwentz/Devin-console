import { describe, expect, it } from 'vitest';
import { DEVIN_ACP_SPEC, fullCommand, type AcpAgentSpec } from '../../src/core/acpAgentSpec';
import { DEVIN_LOCAL_MODES } from '../../src/core/settingsDraft';

const devinSpec: AcpAgentSpec = { ...DEVIN_ACP_SPEC, resolveCommand: async () => ['devin'] };

describe('AcpAgentSpec / fullCommand', () => {
  it('devin spec: a resolved binary gets `acp` appended', async () => {
    expect(devinSpec.providerId).toBe('devin-local');
    expect(devinSpec.args).toEqual(['acp']);
    expect(devinSpec.modes).toBe(DEVIN_LOCAL_MODES);
    expect(fullCommand(devinSpec, await devinSpec.resolveCommand('local'))).toEqual(['devin', 'acp']);
    expect(fullCommand(devinSpec, ['/home/u/.local/bin/devin'])).toEqual(['/home/u/.local/bin/devin', 'acp']);
  });

  it('a second spec appends its own args after its resolved command', async () => {
    const fake: AcpAgentSpec = {
      providerId: 'fake',
      label: 'Fake',
      args: ['--acp'],
      resolveCommand: async () => ['node', 'out/fixtures/fakeAcpAgent.cjs'],
    };
    expect(fullCommand(fake, await fake.resolveCommand('local'))).toEqual([
      'node',
      'out/fixtures/fakeAcpAgent.cjs',
      '--acp',
    ]);
  });

  it('a `{ full }` command (test override) is used verbatim — args are not appended', () => {
    expect(fullCommand(devinSpec, { full: ['node', '/abs/fakeAcpAgent.cjs'] })).toEqual([
      'node',
      '/abs/fakeAcpAgent.cjs',
    ]);
  });

  it('a missing command is null', async () => {
    const missing: AcpAgentSpec = { ...DEVIN_ACP_SPEC, resolveCommand: async () => null };
    expect(fullCommand(missing, await missing.resolveCommand('wsl:Fake'))).toBeNull();
    expect(fullCommand(devinSpec, [])).toBeNull();
    expect(fullCommand(devinSpec, { full: [] })).toBeNull();
  });

  it('does not mutate the resolved command or the spec args', () => {
    const resolved = ['devin'];
    fullCommand(devinSpec, resolved);
    expect(resolved).toEqual(['devin']);
    expect(DEVIN_ACP_SPEC.args).toEqual(['acp']);
  });
});
