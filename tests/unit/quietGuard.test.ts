// Guards the "tests never take over the desktop" contract (plans/quiet-tests.md).
// A launch that is not in test mode, or that opts out of quiet mode, shows a real
// window and steals the foreground for the whole spec — it has regressed before.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E = join(process.cwd(), 'tests/e2e');
const specs = readdirSync(E2E).filter((name) => name.endsWith('.spec.ts'));
const read = (path: string): string => readFileSync(path, 'utf8');

describe('quiet test launches', () => {
  it('finds the specs it is meant to guard', () => {
    expect(specs.length).toBeGreaterThan(20);
    expect(specs).toContain('quiet.spec.ts');
  });

  it('no spec opts out of quiet mode except quiet.spec.ts (and only behind the headed skip)', () => {
    const offenders = specs.filter(
      (name) => name !== 'quiet.spec.ts' && /AGENT_WORKSPACE_TEST_QUIET['"]?\s*:\s*['"]0['"]/.test(read(join(E2E, name))),
    );
    expect(offenders).toEqual([]);
    const quietSpec = read(join(E2E, 'quiet.spec.ts'));
    const headedCase = quietSpec.slice(quietSpec.indexOf('headed run keeps the window visible'));
    expect(headedCase).toMatch(/test\.skip\(\s*process\.env\.AGENT_WORKSPACE_TEST_QUIET !== '0'/);
  });

  it('no spec launches Electron directly — launchApp sets the test flag and quiet default', () => {
    const offenders = specs.filter((name) => /_electron\s*\.\s*launch\s*\(/.test(read(join(E2E, name))));
    expect(offenders).toEqual([]);
  });

  it('launchApp forces AGENT_WORKSPACE_TEST=1 after caller env, and never forces quiet off', () => {
    const helpers = read(join(E2E, 'helpers.ts'));
    const launch = helpers.slice(helpers.indexOf('export async function launchApp'));
    const env = launch.slice(launch.indexOf('env: {'), launch.indexOf('ELECTRON_DISABLE_SECURITY_WARNINGS'));
    expect(env.indexOf('...extraEnv')).toBeGreaterThan(-1);
    expect(env.indexOf("AGENT_WORKSPACE_TEST: '1'")).toBeGreaterThan(env.indexOf('...extraEnv'));
    expect(env).not.toMatch(/AGENT_WORKSPACE_TEST_QUIET/);
  });

  it('the installed-app smoke spec runs in test mode (so it is quiet too)', () => {
    const smoke = read(join(process.cwd(), 'tests/smoke/installed.spec.ts'));
    expect(smoke).toMatch(/AGENT_WORKSPACE_TEST: '1'/);
    expect(smoke).not.toMatch(/AGENT_WORKSPACE_TEST_QUIET['"]?\s*:\s*['"]0['"]/);
  });
});
