// Positive control for the remote-fs guard (spec §3.3). Every other spec's
// teardown asserts remoteFsViolations() === 0 — which would still pass if the
// guard were never installed (e.g. the `./remoteFsGuardInstall` import dropped
// from or reordered in src/main/index.ts). This spec proves the guard is live
// in the built main process: an fs and an fs/promises call on a WSL path
// throw/reject RemoteFsViolation and are counted and logged.
//
// Both probes use the AGENT_WORKSPACE_TEST_WSL_UNC_ROOT stand-in prefix (a
// plain temp dir), never a real `\\wsl.localhost` path: with the guard missing
// (the RED state) a real-UNC probe would hit the Windows WSL redirector on the
// developer's machine, whereas the stand-in only stats a nonexistent temp
// path. The builtin `\\wsl.localhost` / `\\wsl$` prefix matching is covered
// by tests/unit/remoteFsGuard.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers } from '../fixtures/http';
import { closeApp, expectRemoteFsViolations, launchApp, readEvents } from './helpers';

test('the remote-fs guard is installed: fs and fs/promises on a WSL path are refused and counted', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-guard-'));
  const logFile = join(profile, 'events.jsonl');
  const uncRoot = join(profile, 'unc-root');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
  });
  // This app makes exactly these two violations on purpose.
  expectRemoteFsViolations(app, 2);
  try {
    const result = await app.evaluate(async (_electron, root) => {
      const fs = process.getBuiltinModule('node:fs');
      const errorName = (e: unknown) => (e instanceof Error ? e.name : String(e));
      let sync = 'passed';
      try {
        fs.existsSync(`${root}\\x`);
      } catch (e) {
        sync = errorName(e);
      }
      let promise = 'resolved';
      try {
        await fs.promises.stat(`${root.replace(/\\/g, '/')}/D/home`);
      } catch (e) {
        promise = errorName(e);
      }
      return { sync, promise, count: (globalThis as any).__agentworkspace.remoteFsViolations() as number };
    }, uncRoot);
    expect(result).toEqual({ sync: 'RemoteFsViolation', promise: 'RemoteFsViolation', count: 2 });
    const ops = (await readEvents(logFile))
      .filter((e) => e.event === 'remote-fs-violation')
      .map((e) => (e.detail as { op?: string }).op)
      .sort();
    expect(ops).toEqual(['existsSync', 'promises.stat']);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});
