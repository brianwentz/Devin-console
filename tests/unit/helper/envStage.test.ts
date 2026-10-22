import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STAGE_MAX_AGE_MS, stageEnv } from '../../../src/helper/envStage';
import { sshEnvFileContent } from '../../../src/core/execHost';

// Fix round 1 #4: `env.stage` writes the app's extra env (the hook token) to
// <home>/.agent-workspace/run/<random> — dir 0700, file 0600, O_EXCL — so an
// ssh pty's argv carries only that path.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'helper-stage-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('helper env.stage', () => {
  it('writes the export lines to a fresh random file under run/ and returns its name', async () => {
    const vars = { AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN: "tok'en $x", B: '1' };
    const { name } = await stageEnv(home, { vars });
    expect(name).toMatch(/^[0-9a-f]{32}$/);
    const file = join(home, '.agent-workspace', 'run', name);
    expect(readFileSync(file, 'utf8')).toBe(sshEnvFileContent(vars));
    const second = await stageEnv(home, { vars });
    expect(second.name).not.toBe(name);
  });

  it.skipIf(process.platform === 'win32')('dir 0700, file 0600 on POSIX', async () => {
    const { name } = await stageEnv(home, { vars: { K: 'v' } });
    expect(statSync(join(home, '.agent-workspace', 'run')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.agent-workspace', 'run', name)).mode & 0o777).toBe(0o600);
  });

  it('rejects bad params: non-string values, bad keys, too many vars', async () => {
    await expect(stageEnv(home, { vars: { K: 1 } })).rejects.toMatchObject({ code: 'bad-params' });
    await expect(stageEnv(home, { vars: { 'A;B': 'x' } })).rejects.toMatchObject({ code: 'bad-params' });
    await expect(stageEnv(home, { vars: [] })).rejects.toMatchObject({ code: 'bad-params' });
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']));
    await expect(stageEnv(home, { vars: many })).rejects.toMatchObject({ code: 'bad-params' });
    expect(existsSync(join(home, '.agent-workspace', 'run'))).toBe(false);
  });

  it('sweeps staged files older than the max age (a pty that never started)', async () => {
    const first = await stageEnv(home, { vars: { K: 'v' } });
    const stale = join(home, '.agent-workspace', 'run', first.name);
    const old = new Date(Date.now() - STAGE_MAX_AGE_MS - 60_000);
    utimesSync(stale, old, old);
    writeFileSync(join(home, '.agent-workspace', 'run', 'keep-me.txt'), 'x');
    const second = await stageEnv(home, { vars: { K: 'v' } });
    expect(readdirSync(join(home, '.agent-workspace', 'run')).sort()).toEqual([second.name, 'keep-me.txt'].sort());
  });
});
