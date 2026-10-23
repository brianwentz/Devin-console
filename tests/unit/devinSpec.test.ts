import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullCommand } from '../../src/core/acpAgentSpec';
import { createDevinSpec } from '../../src/main/local/devinSpec';

const status = vi.fn();
const resolveDevinPath = vi.fn();
vi.mock('../../src/main/hosts', () => ({ hosts: () => ({ status }) }));
vi.mock('../../src/main/local/acpHost', () => ({ resolveDevinPath: (o: unknown) => resolveDevinPath(o) }));


describe('createDevinSpec', () => {
  const saved = process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD;
  let appPath: string;
  beforeEach(() => {
    appPath = mkdtempSync(join(tmpdir(), 'devinspec-'));
    writeFileSync(join(appPath, 'agent.cjs'), '');
    status.mockReset();
    resolveDevinPath.mockReset();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD;
    else process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = saved;
  });

  it('test override: full argv, existing relative args resolved against appPath, no acp appended', async () => {
    process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = '  node  agent.cjs missing.cjs  ';
    const spec = createDevinSpec({ testMode: true, appPath, devinPathOverride: '/ignored' });
    const resolved = await spec.resolveCommand('local');
    expect(resolved).toEqual({ full: ['node', join(appPath, 'agent.cjs'), 'missing.cjs'] });
    expect(fullCommand(spec, resolved)).toEqual(['node', join(appPath, 'agent.cjs'), 'missing.cjs']);
    expect(resolveDevinPath).not.toHaveBeenCalled();
  });

  it('the override is ignored outside test mode; local.devinPath / PATH via resolveDevinPath + acp', async () => {
    process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = 'node agent.cjs';
    resolveDevinPath.mockReturnValue('/opt/devin/bin/devin');
    const spec = createDevinSpec({ testMode: false, appPath, devinPathOverride: '/opt/devin/bin/devin' });
    expect(fullCommand(spec, await spec.resolveCommand('local'))).toEqual(['/opt/devin/bin/devin', 'acp']);
    expect(resolveDevinPath).toHaveBeenCalledWith('/opt/devin/bin/devin');
  });

  it('missing local CLI → null', async () => {
    delete process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD;
    resolveDevinPath.mockReturnValue(null);
    const spec = createDevinSpec({ testMode: true, appPath, devinPathOverride: null });
    expect(await spec.resolveCommand('local')).toBeNull();
  });

  it('WSL host: the probe path + acp; no probe path → null; never the local override', async () => {
    process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD = 'node agent.cjs';
    const spec = createDevinSpec({ testMode: true, appPath, devinPathOverride: null });
    status.mockReturnValue({ devin: { path: '/home/u/.local/bin/devin' } });
    expect(fullCommand(spec, await spec.resolveCommand('wsl:Fake'))).toEqual(['/home/u/.local/bin/devin', 'acp']);
    expect(status).toHaveBeenCalledWith('wsl:Fake');
    status.mockReturnValue({ devin: { path: null } });
    expect(await spec.resolveCommand('wsl:Fake')).toBeNull();
    status.mockReturnValue(undefined);
    expect(await spec.resolveCommand('wsl:Fake')).toBeNull();
  });
});
