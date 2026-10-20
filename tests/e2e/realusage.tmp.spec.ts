// THROWAWAY lead check — real account + real WSL, not for commit.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { launchApp, readEvents, shellPage } from './helpers';

test('real Claude usage in the Analytics tab', async () => {
  test.setTimeout(240_000);
  const fixtures: FixtureServers = await startFixtureServers();
  const userData = mkdtempSync(join(tmpdir(), 'dw-realusage-'));
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ surface: 'analytics', analytics: { tab: 'claude' } }));
  const logFile = join(userData, 'events.jsonl');
  const env: Record<string, string> = {
    DEVIN_WORKSPACES_TEST_WSL_CMD: 'C:\\Windows\\System32\\wsl.exe',
    DEVIN_WORKSPACES_TEST_CLAUDE_USAGE_URL: 'https://api.anthropic.com/api/oauth/usage',
    DEVIN_WORKSPACES_TEST_CLAUDE_ACCOUNT_FILE: '',
    CLAUDE_CONFIG_DIR: join(process.env.USERPROFILE!, '.claude'),
  };
  const app = await launchApp(userData, logFile, join(userData, 'dl'), fixtures, env);
  try {
    await app.evaluate(() => (globalThis as any).__devinworkspaces.setSurface('analytics'));
    const page = await shellPage(app);
    await expect(page.locator('#claudeAnalyticsPanel')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await app.evaluate(() => (globalThis as any).__devinworkspaces.claudeUsageState())).accounts.length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await app.evaluate(() => (globalThis as any).__devinworkspaces.claudeUsageState())).tokens.scannedAt, { timeout: 180_000 })
      .not.toBeNull();
    console.log('HOSTS', JSON.stringify((await app.evaluate(() => (globalThis as any).__devinworkspaces.hosts())).map((h: any) => [h.id, h.state])));
    const t1 = Date.now();
    await app.evaluate(() => (globalThis as any).__devinworkspaces.claudeUsageRefresh());
    console.log('REFRESH ms', Date.now() - t1);
    const s = await app.evaluate(() => (globalThis as any).__devinworkspaces.claudeUsageState());
    for (const a of s.accounts) console.log('ACCOUNT', a.email, a.organization, a.plan, a.hosts, 'stale', a.stale, a.error, a.limits.map((l: any) => `${l.kind}=${l.percent}% ${l.resetsAt}`));
    console.log('MONTH', s.month, 'TOTAL', JSON.stringify(s.tokens.total));
    console.log('BYHOST', JSON.stringify(s.tokens.byHost));
    console.log('BYMODEL', JSON.stringify(Object.fromEntries(Object.entries(s.tokens.byModel).map(([m, t]: any) => [m, t.output]))));
    console.log('PREV', JSON.stringify(s.tokens.previousMonthTotal));
    await page.screenshot({ path: 'docs/evidence/analytics-claude-real.png' });
  } finally {
    await app.close().catch(() => {});
    await fixtures.close();
    const ev = await readEvents(logFile);
    console.log('EVENTS', ev.filter((e) => /usage-/.test(String(e.event))).map((e) => `${e.event} ${JSON.stringify(e.detail ?? {})}`).join('\n'));
  }
});
