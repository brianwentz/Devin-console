import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  launchApp,
  launchWithClaudeFixture,
  readEvents,
  shellPage,
  state,
} from './helpers';

// Usage alerts: Devin Cloud monthly ACUs (fixture usage-limit endpoint) +
// Claude limits (eager claudeUsage fetch). Poll is 400 ms via the test override.
const POLL_MS = 400;
const USAGE_BODY = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/devin-usage-limit.json'), 'utf8'),
) as Record<string, unknown>;
const CLAUDE_USAGE_BODY = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/claude-usage.json'), 'utf8'),
) as { limits: { kind: string; percent: number }[] };

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test.beforeEach(() => {
  fixtures.devin.setUsageLimit(null);
  fixtures.devin.setUsageStatus(0);
});

type UsageEntry = {
  id: string;
  kind: string;
  source?: string;
  metric?: string;
  accountKey?: string;
  title: string;
  body: string;
  readAt: number | null;
};

function hooks(app: ElectronApplication) {
  return {
    notifications: () =>
      app.evaluate(() => (globalThis as any).__agentworkspace.notifications() as UsageEntry[]),
    usageEntries: async () =>
      (await app.evaluate(
        () => (globalThis as any).__agentworkspace.notifications(),
      ) as UsageEntry[]).filter((e) => e.kind === 'usage'),
    openNotification: (id: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__agentworkspace.notificationsOpen(value), id),
    setSurface: (value: string) =>
      app.evaluate((_e, v) => (globalThis as any).__agentworkspace.setSurface(v), value),
    getAnalyticsBounds: () =>
      app.evaluate(
        () => (globalThis as any).__agentworkspace.getAnalyticsBounds() as {
          x: number; y: number; width: number; height: number;
        } | null,
      ),
    devinUsageState: () =>
      app.evaluate(() => (globalThis as any).__agentworkspace.devinUsageState()),
    devinUsageRefresh: () =>
      app.evaluate(() => (globalThis as any).__agentworkspace.devinUsageRefresh()),
  };
}

async function launch(profile: string, logFile: string, extraEnv: Record<string, string> = {}) {
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_DEVIN_USAGE_POLL_MS: String(POLL_MS),
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '0',
    ...extraEnv,
  });
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return app;
}

async function close(app: ElectronApplication) {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
}

const usageAlertCount = async (logFile: string) =>
  (await readEvents(logFile)).filter((e) => e.event === 'usage-alert').length;

test('devin 50 → 80 → no refire → persisted across restart → re-arm', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-usage-'));
  const logFile = join(profile, 'events.jsonl');
  fixtures.devin.setUsageLimit({ ...USAGE_BODY, cycle_usage: 6600 });
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    // 55% → warn level, badge, one 50% usage notification, no banner.
    await expect.poll(async () => (await state(app)).usage.level).toBe('warn');
    const shell = await shellPage(app);
    await expect(shell.locator('#usageBadge')).toHaveAttribute('data-usage-level', 'warn');
    let entries = await h.usageEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'devin',
      metric: 'devin-monthly',
      title: 'Devin Cloud monthly ACUs: 50% used',
    });
    expect(entries[0]!.body).toMatch(/^6,600 \/ 12,000 ACUs used — resets /);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    expect(await usageAlertCount(logFile)).toBe(1);
    await expect(shell.locator('#notificationBanner')).toHaveCount(0);

    // 85% → critical, the 50 entry is superseded by a single 80 entry.
    fixtures.devin.setUsageLimit({ ...USAGE_BODY, cycle_usage: 10200 });
    await expect.poll(async () => (await state(app)).usage.level).toBe('critical');
    await expect(shell.locator('#usageBadge')).toHaveAttribute('data-usage-level', 'critical');
    entries = await h.usageEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Devin Cloud monthly ACUs: 80% used');
    expect(await usageAlertCount(logFile)).toBe(2);
  } finally {
    await close(app);
  }

  // Restart on the same profile: ledger persisted → no refire at 85%.
  const app2 = await launch(profile, logFile);
  const h2 = hooks(app2);
  try {
    await h2.devinUsageRefresh();
    await expect
      .poll(async () => (await state(app2)).usage.devin.status, { timeout: 15_000 })
      .toBe('ready');
    const alertsBefore = await usageAlertCount(logFile);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    expect(await h2.usageEntries()).toHaveLength(1);
    expect(await usageAlertCount(logFile)).toBe(alertsBefore);

    // New billing period at 55% → re-armed 50% alert.
    fixtures.devin.setUsageLimit({
      ...USAGE_BODY,
      cycle_usage: 6600,
      cycle_start: '2026-11-14T00:00:00-08:00',
      cycle_end: '2026-12-01T00:00:00-08:00',
    });
    await expect.poll(async () => await usageAlertCount(logFile)).toBe(alertsBefore + 1);
    const entries = await h2.usageEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Devin Cloud monthly ACUs: 50% used');
  } finally {
    await close(app2);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Devin tab summary row + strip layout + Claude tab row', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-usage-'));
  const logFile = join(profile, 'events.jsonl');
  fixtures.devin.setUsageLimit({ ...USAGE_BODY, cycle_usage: 6600 });
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await state(app)).usage.devin.status).toBe('ready');
    await h.setSurface('analytics');
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    const shell = await shellPage(app);
    const summary = shell.locator('#devinUsageSummary');
    await expect(summary).toContainText('6,600 / 12,000 ACUs (55%)');
    await expect(summary).toContainText('projected');
    await expect(summary).toContainText('resets');

    // The hosted analytics view starts at/below the strip's bottom edge.
    const strip = await shell.locator('#analyticsTabs').boundingBox();
    const hosted = await h.getAnalyticsBounds();
    expect(hosted).not.toBeNull();
    expect(hosted!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height - 1);

    // Claude tab: the summary row is #claudeUsageSummary; the tab row keeps
    // the same position on both tabs (no jump).
    const tablistY = (await shell.locator('#analyticsTabs [role="tablist"]').boundingBox())!.y;
    await evaluateInShell(
      app,
      "window.agentworkspace.setSettings({ analytics: { tab: 'claude' } })",
    );
    await expect(shell.locator('#claudeUsageSummary')).toHaveCount(1);
    const tablistY2 = (await shell.locator('#analyticsTabs [role="tablist"]').boundingBox())!.y;
    expect(tablistY2).toBe(tablistY);
  } finally {
    await close(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('HTTP failure keeps last good; recovery clears stale', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-usage-'));
  const logFile = join(profile, 'events.jsonl');
  fixtures.devin.setUsageLimit({ ...USAGE_BODY, cycle_usage: 6600 });
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    await expect
      .poll(async () => (await state(app)).usage.devin.status, { timeout: 15_000 })
      .toBe('ready');
    await h.setSurface('analytics');
    const shell = await shellPage(app);
    await expect(shell.locator('#devinUsageSummary')).toContainText('6,600');

    fixtures.devin.setUsageStatus(500);
    await expect.poll(async () => (await state(app)).usage.devin.status).toBe('error');
    const errored = (await state(app)).usage.devin;
    expect(errored.stale).toBe(true);
    expect(errored.percent).not.toBeNull();
    await expect(shell.locator('#devinUsageSummary')).toContainText('cached');

    fixtures.devin.setUsageStatus(200);
    // The 500 grew the backoff — force a refresh instead of waiting it out.
    await h.devinUsageRefresh();
    await expect.poll(async () => (await state(app)).usage.devin.status).toBe('ready');
    expect((await state(app)).usage.devin.stale).toBe(false);
  } finally {
    await close(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('claude session-limit alert opens Analytics on the Claude tab', async () => {
  const body = JSON.parse(JSON.stringify(CLAUDE_USAGE_BODY)) as typeof CLAUDE_USAGE_BODY;
  for (const limit of body.limits) if (limit.kind === 'session') limit.percent = 55;
  const previous = process.env.FAKE_USAGE_JSON;
  process.env.FAKE_USAGE_JSON = JSON.stringify(body);
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_DEVIN_USAGE_POLL_MS: String(POLL_MS),
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '0',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.usageEntries()).length).toBe(1);
    const entry = (await h.usageEntries())[0]!;
    expect(entry).toMatchObject({ source: 'claude', metric: 'claude-session' });
    expect(entry.body).toMatch(/^dev@example\.com/);

    await h.openNotification(entry.id);
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    expect(
      ((await state(app)).settings.analytics as { tab: string }).tab,
    ).toBe('claude');
    await expect.poll(async () => (await h.usageEntries()).length).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.FAKE_USAGE_JSON;
    else process.env.FAKE_USAGE_JSON = previous;
    await close(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('kinds.usage = false: ledger still advances, no notification entry', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-usage-'));
  const logFile = join(profile, 'events.jsonl');
  fixtures.devin.setUsageLimit({ ...USAGE_BODY, cycle_usage: 6600 });
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    await expect.poll(async () => await usageAlertCount(logFile)).toBe(1);
    expect(await h.usageEntries()).toHaveLength(1);

    await evaluateInShell(
      app,
      'window.agentworkspace.setSettings({ notifications: { kinds: { usage: false } } })',
    );
    fixtures.devin.setUsageLimit({ ...USAGE_BODY, cycle_usage: 10200 });
    await expect.poll(async () => await usageAlertCount(logFile)).toBe(2);
    // No 80% entry was added; the old 50 entry stays.
    const entries = await h.usageEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Devin Cloud monthly ACUs: 50% used');
    expect((await state(app)).usage.level).toBe('critical');
  } finally {
    await close(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
