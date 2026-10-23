import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullCommand, spawnCommand } from '../../src/core/acpAgentSpec';
import { createDevinSpec } from '../../src/main/local/devinSpec';

const status = vi.fn();
vi.mock('../../src/main/hosts', () => ({ hosts: () => ({ status }) }));

describe('createDevinSpec', () => {
  const saved = process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD;
  let appPath: string;
  let devinBin: string;
  beforeEach(() => {
    appPath = mkdtempSync(join(tmpdir(), 'devinspec-'));
    writeFileSync(join(appPath, 'agent.cjs'), '');
    devinBin = join(appPath, 'devin-bin');
    writeFileSync(devinBin, '');
    status.mockReset();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD;
    else process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = saved;
  });

  it('test override: full argv, existing relative args resolved against appPath, no acp appended', async () => {
    process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = '  node  agent.cjs missing.cjs  ';
    const spec = createDevinSpec({ testMode: true, appPath, devinPathOverride: join(appPath, 'nope') });
    const resolved = await spec.resolveCommand('local');
    expect(resolved).toEqual({ full: ['node', join(appPath, 'agent.cjs'), 'missing.cjs'] });
    expect(fullCommand(spec, resolved)).toEqual(['node', join(appPath, 'agent.cjs'), 'missing.cjs']);
  });

  it('the override is ignored outside test mode; an existing local.devinPath + acp', async () => {
    process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = 'node agent.cjs';
    const spec = createDevinSpec({ testMode: false, appPath, devinPathOverride: devinBin });
    expect(fullCommand(spec, await spec.resolveCommand('local'))).toEqual([devinBin, 'acp']);
  });

  it('a local.devinPath that does not exist → null (missing-cli)', async () => {
    delete process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD;
    const spec = createDevinSpec({ testMode: true, appPath, devinPathOverride: join(appPath, 'nope') });
    expect(await spec.resolveCommand('local')).toBeNull();
  });

  it('WSL host: the probe path + acp; never the local override', async () => {
    process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = 'node agent.cjs';
    const spec = createDevinSpec({ testMode: true, appPath, devinPathOverride: null });
    status.mockReturnValue({ devin: { path: '/home/u/.local/bin/devin' } });
    const resolved = await spec.resolveCommand('wsl:Fake');
    expect(fullCommand(spec, resolved)).toEqual(['/home/u/.local/bin/devin', 'acp']);
    expect(spawnCommand(spec, resolved)).toEqual(['/home/u/.local/bin/devin', 'acp']);
    expect(status).toHaveBeenCalledWith('wsl:Fake');
  });

  it('WSL host with no probed path: the presence check reports missing, the spawn falls back to devin acp', async () => {
    const spec = createDevinSpec({ testMode: false, appPath, devinPathOverride: null });
    for (const probed of [{ devin: { path: null } }, undefined]) {
      status.mockReturnValue(probed);
      const resolved = await spec.resolveCommand('wsl:Fake');
      // ensureAgent's missing-cli gate
      expect(fullCommand(spec, resolved)).toBeNull();
      // start()/restartAgent — the pre-seam `status.devin.path ?? 'devin'` + ['acp']
      expect(spawnCommand(spec, resolved)).toEqual(['devin', 'acp']);
    }
  });
});
