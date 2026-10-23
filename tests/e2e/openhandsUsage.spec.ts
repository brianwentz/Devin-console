// B3 T27: OpenHands usage (credits / daily quota / 30 d spend), the
// Analytics -> OpenHands tab and the `openhands-quota` usage alert.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ShellState } from '../../src/shared/ipc';
import { launchApp, readEvents, shellPage, state as publicState } from './helpers';

const state = async (app: ElectronApplication) => (await publicState(app)) as unknown as ShellState;

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test.afterEach(() => {
  fixtures.openhands.setStatus('credits', 0);
  fixtures.openhands.setBody('quota', null);
  fixtures.openhands.requireAuth('none');
});

async function launch(profile: string) {
  const app = await launchApp(profile, join(profile, 'events.jsonl'), join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '0',
  });
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return app;
}

async function close(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
}

const hook = <T>(app: ElectronApplication, name: string, ...args: unknown[]) =>
  app.evaluate(
    async (_electron, [n, a]) => (globalThis as any).__agentworkspace[n as string](...(a as unknown[])) as T,
    [name, args] as [string, unknown[]],
  );

const USAGE_PATH = /^\/api\/(billing\/credits|quota\/status|v1\/users\/me|organizations\/[^/]+\/conversations\/my-usage)/;
const usageRequests = () => fixtures.openhands.requests().filter((r) => USAGE_PATH.test(r.path));

type Entry = { kind: string; source?: string; metric?: string; title: string };
const usageEntries = async (app: ElectronApplication) =>
  (await hook<Entry[]>(app, 'notifications')).filter((e) => e.kind === 'usage' && e.metric === 'openhands-quota');

test('Analytics -> OpenHands: gated fetch, cards, unavailable credits, one 80% alert, tab persists', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohusage-'));
  const logFile = join(profile, 'events.jsonl');
  const before = usageRequests().length;
  const allBefore = fixtures.openhands.requests().length;
  let app = await launch(profile);
  try {
    // No key, no cache, no OpenHands visit: the gate is closed (no source was
    // built, so no usage service exists) and the OpenHands host sees nothing.
    expect(await hook(app, 'openhandsState')).toBeNull();
    expect(fixtures.openhands.requests().length).toBe(allBefore);

    // Analytics on its default Devin tab is not an OpenHands action either.
    const shell = await shellPage(app);
    await shell.locator('#analyticsButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    await expect(shell.locator('#analyticsTab-devin')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('#analyticsTab-openhands')).toHaveText('OpenHands');
    expect(await hook(app, 'openhandsState')).toBeNull();
    expect((await hook<{ credits: { state: string } }>(app, 'openhandsUsageState')).credits.state).toBe('pending');
    expect(fixtures.openhands.requests().length).toBe(allBefore);

    // Opening the tab is the explicit OpenHands action: the gate opens.
    await shell.locator('#analyticsTab-openhands').click();
    await expect(shell.locator('#openhandsAnalytics')).toBeVisible();
    await expect.poll(() => usageRequests().length).toBeGreaterThan(before);
    await expect(shell.locator('[data-card=credits]')).toHaveAttribute('data-card-state', 'ok');
    await expect(shell.locator('[data-card=credits]')).toContainText('12.34');
    await expect(shell.locator('[data-card=quota]')).toHaveAttribute('data-card-state', 'ok');
    await expect(shell.locator('[data-card=quota] [data-gauge-percent]')).toHaveAttribute('data-gauge-percent', '30');
    await expect(shell.locator('[data-card=spend]')).toHaveAttribute('data-card-state', 'ok');
    await expect(shell.locator('[data-card=top]')).toHaveCount(1);
    await expect(shell.locator('[data-card=top]')).toHaveAttribute('data-card-state', 'ok');
    await expect(shell.locator('#openhandsUsageSummary')).toContainText('30%');
    // The hosted Devin analytics page is not shown on this tab.
    expect(await hook(app, 'getAnalyticsBounds')).toEqual({ x: 0, y: 0, width: 0, height: 0 });

    // Billing not configured on this server.
    fixtures.openhands.setStatus('credits', 503);
    await shell.locator('#analyticsRefresh').click();
    await expect(shell.locator('[data-card=credits]')).toHaveAttribute('data-card-state', 'unavailable');
    await expect(shell.locator('[data-card=credits]')).toContainText('Not available on this server');

    // Quota at 85 % -> one usage notification at the 80 % threshold.
    fixtures.openhands.setBody('quota', {
      daily_limit: 20,
      used_today: 17,
      remaining: 3,
      reset_at: '2026-10-24T00:00:00Z',
    });
    await hook(app, 'openhandsUsageRefresh');
    await expect.poll(async () => (await usageEntries(app)).length).toBe(1);
    const [entry] = await usageEntries(app);
    expect(entry).toMatchObject({ source: 'openhands', title: 'OpenHands daily quota: 80% used' });
    const alerts = (await readEvents(logFile)).filter(
      (e) => e.event === 'usage-alert' && (e.detail as { metric?: string })?.metric === 'openhands-quota',
    );
    expect(alerts.map((e) => (e.detail as { threshold: number }).threshold)).toEqual([80]);
    expect((await state(app)).usage.level).toBe('critical');

    // A second reading at 85 % does not add another.
    await hook(app, 'openhandsUsageRefresh');
    await expect
      .poll(async () => ((await hook<{ quota: { state: string } }>(app, 'openhandsUsageState')).quota.state))
      .toBe('ok');
    expect(await usageEntries(app)).toHaveLength(1);

    // Usage fetch logs carry endpoint/ok/status only.
    const fetches = (await readEvents(logFile)).filter((e) => e.event === 'openhands-usage-fetch');
    expect(fetches.length).toBeGreaterThan(0);
    for (const e of fetches) {
      expect(Object.keys(e.detail as object).sort()).toEqual(['endpoint', 'ok', 'status']);
    }
  } finally {
    await close(app);
  }

  // analytics.tab persists across a relaunch.
  app = await launch(profile);
  try {
    expect((await state(app)).settings.analytics.tab).toBe('openhands');
    const shell = await shellPage(app);
    await shell.locator('#analyticsButton').click();
    await expect(shell.locator('#analyticsTab-openhands')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('#openhandsAnalytics')).toBeVisible();
  } finally {
    await close(app);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('signed out: the OpenHands tab shows the sign-in hint instead of Loading', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohusage-auth-'));
  fixtures.openhands.requireAuth('cookie');
  const app = await launch(profile);
  try {
    const shell = await shellPage(app);
    await shell.locator('#analyticsButton').click();
    await shell.locator('#analyticsTab-openhands').click();
    await expect(shell.locator('#openhandsAnalytics')).toBeVisible();

    await expect(shell.locator('#openhandsAnalyticsLogin')).toBeVisible();
    await expect(shell.locator('#openhandsAnalyticsLogin')).toHaveText('Sign in to OpenHands to see usage');
    for (const card of ['credits', 'quota', 'spend']) {
      await expect(shell.locator(`[data-card=${card}]`)).toHaveAttribute('data-card-state', 'error');
      await expect(shell.locator(`[data-card=${card}] [data-card-error]`)).toHaveAttribute(
        'data-card-error',
        'login-required',
      );
    }
    await expect(shell.locator('[data-card=top]')).not.toHaveAttribute('data-card-state', 'pending');
    await expect(shell.locator('#openhandsAnalytics')).not.toContainText('Loading');
    await expect(shell.locator('#openhandsAnalyticsSummaryHint')).toHaveText('Sign in to OpenHands to see usage');
    await expect(shell.locator('#openhandsUsageSummary')).not.toContainText('Usage unavailable');

    // The state carries the auth reason (the 1 -> 16 min backoff on refused passes is unit-tested).
    const usage = await hook<{ credits: { state: string; reason?: string } }>(app, 'openhandsUsageState');
    expect(usage.credits).toEqual({ state: 'error', reason: 'login-required' });

    // The hint takes the user to the OpenHands sign-in page (the sidebar banner's action).
    await shell.locator('#openhandsAnalyticsLogin').click();
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
  } finally {
    await close(app);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('opening an OpenHands usage notification lands on the OpenHands analytics tab', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohusage-'));
  const app = await launch(profile);
  try {
    fixtures.openhands.setBody('quota', { daily_limit: 10, used_today: 6, remaining: 4, reset_at: null });
    await hook(app, 'openhandsUsageRefresh');
    await expect.poll(async () => (await usageEntries(app)).length).toBe(1);
    const [entry] = (await hook<(Entry & { id: string })[]>(app, 'notifications')).filter(
      (e) => e.metric === 'openhands-quota',
    );
    expect(entry!.title).toBe('OpenHands daily quota: 50% used');
    await hook(app, 'notificationsOpen', entry!.id);
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    expect((await state(app)).settings.analytics.tab).toBe('openhands');
  } finally {
    await close(app);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
