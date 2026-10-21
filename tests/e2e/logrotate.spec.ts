// F2: the event log rotates at the byte cap into a single events.1.jsonl.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { launchApp, openTab, waitForTabTitle } from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});
test.afterAll(async () => {
  await fixtures.close();
});

test('events.jsonl rotates to events.1.jsonl at the byte cap', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-logrot-'));
  const logFile = join(profile, 'events.jsonl');
  // 2 KB cap (test-only env): a handful of tab events overflows it.
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_LOG_MAX_BYTES: '2000',
  });
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await openTab(app, `${fixtures.githubUrl}/page/rot-1`);
    await waitForTabTitle(app, 'rot-1');
    await expect
      .poll(async () => existsSync(join(profile, 'events.1.jsonl')))
      .toBe(true);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
