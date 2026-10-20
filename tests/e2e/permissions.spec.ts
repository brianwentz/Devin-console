// F1: GitHub tabs get clipboard-sanitized-write (PR copy buttons); everything
// else stays denied. Empirically (Electron 44), navigator.clipboard.writeText
// in a gesture-free evaluate returns NotAllowedError regardless of the grant —
// the observable signal is navigator.permissions.query({name:'clipboard-write'})
// → 'granted', which consults our permission-check handler (and logs it).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInView,
  launchApp,
  openTab,
  readEvents,
  waitForEvent,
  waitForTabTitle,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});
test.afterAll(async () => {
  await fixtures.close();
});

async function quit(app: ElectronApplication, profile: string): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

test('gh tab clipboard-write granted, notifications denied; devin view keeps clipboard', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-perm-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    const tabId = await openTab(app, `${fixtures.githubUrl}/page/copy-test`);
    await waitForTabTitle(app, 'copy-test');
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.focus(id), tabId);

    // clipboard-write granted in a GitHub-origin tab (pre-F1: denied).
    await expect
      .poll(async () =>
        evaluateInView(
          app,
          `${fixtures.githubUrl}/page/copy-test`,
          `navigator.permissions.query({ name: 'clipboard-write' }).then((r) => r.state, (e) => 'err:' + e.name)`,
        ),
      )
      .toBe('granted');
    // notifications stay denied in gh tabs.
    expect(
      await evaluateInView(
        app,
        `${fixtures.githubUrl}/page/copy-test`,
        `navigator.permissions.query({ name: 'notifications' }).then((r) => r.state)`,
      ),
    ).toBe('denied');
    await waitForEvent(logFile, 'permission-check', 'allow');
    const events = await readEvents(logFile);
    expect(
      events.some(
        (e) =>
          e.event === 'permission-check' &&
          e.decision === 'allow' &&
          (e.detail as any)?.permission === 'clipboard-sanitized-write' &&
          String(e.view).startsWith('gh:'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event === 'permission-check' &&
          e.decision === 'deny' &&
          (e.detail as any)?.permission === 'notifications' &&
          String(e.view).startsWith('gh:'),
      ),
    ).toBe(true);
  } finally {
    await quit(app, profile);
  }
});
