import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { ANALYTICS_TABS_HEIGHT, TITLE_BAR_HEIGHT } from '../../src/core/layout';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  closeApp,
  launchApp,
  pageFor,
  readEvents,
  shellPage,
  state,
  waitForEventCount,
} from './helpers';

type Rect = { x: number; y: number; width: number; height: number };
interface G {
  __devinworkspaces: {
    getAnalyticsBounds(): Rect | null;
    getDevinBounds(): Rect | null;
    childViews(): Array<{ bounds: Rect; url: string | null }>;
    layoutRects(): { devin: Rect; analyticsTabs: Rect | null };
    setSurface(value: string): void;
  };
}
const hooks = (app: import('playwright').ElectronApplication) => ({
  getAnalyticsBounds: () =>
    app.evaluate(() => (globalThis as unknown as G).__devinworkspaces.getAnalyticsBounds()),
  getDevinBounds: () =>
    app.evaluate(() => (globalThis as unknown as G).__devinworkspaces.getDevinBounds()),
  childViews: () =>
    app.evaluate(() => (globalThis as unknown as G).__devinworkspaces.childViews()),
  layoutRects: () =>
    app.evaluate(() => (globalThis as unknown as G).__devinworkspaces.layoutRects()),
  setSurface: (value: string) =>
    app.evaluate((_e, v) => (globalThis as unknown as G).__devinworkspaces.setSurface(v), value),
});

const analyticsTab = async (app: import('playwright').ElectronApplication) =>
  ((await state(app)).settings as unknown as { analytics: { tab: string } }).analytics.tab;
const ZERO = { x: 0, y: 0, width: 0, height: 0 };

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test('analytics rail button swaps the main column to the tenant analytics view', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    const shell = await shellPage(app);
    const h = hooks(app);

    await shell.locator('#analyticsButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    await expect(shell.locator('#analyticsButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(shell.locator('#cloudButton')).toHaveAttribute('aria-pressed', 'false');

    // The analytics view fills the devin column; the devin view is parked at 0.
    await expect
      .poll(async () => (await h.getAnalyticsBounds())?.width ?? 0)
      .toBeGreaterThan(0);
    const analyticsBounds = await h.getAnalyticsBounds();
    const devinRect = (await h.layoutRects()).devin;
    expect(analyticsBounds?.width).toBe(devinRect.width);
    expect(analyticsBounds?.x).toBe(devinRect.x);
    expect((await h.getDevinBounds())?.width ?? -1).toBe(0);

    await expect
      .poll(async () =>
        (await h.childViews()).some((view) => view.url?.endsWith('/settings/my-analytics')),
      )
      .toBe(true);

    // First entry loads the page once — no refresh fires for the creation load.
    const firstPage = await pageFor(app, `${fixtures.devinUrl}/settings/my-analytics`);
    await expect(firstPage.locator('#analyticsLoadCount')).toHaveText('1');

    // Switching back restores the devin view and parks analytics (it stays loaded).
    await shell.locator('#cloudButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
    await expect.poll(async () => (await h.getDevinBounds())?.width ?? 0).toBe(devinRect.width);
    expect((await h.getAnalyticsBounds())?.width ?? -1).toBe(0);
    await expect
      .poll(async () =>
        (await h.childViews()).some((view) => view.url?.endsWith('/settings/my-analytics')),
      )
      .toBe(false);

    // Re-entering the surface reloads the analytics view in place.
    await shell.locator('#analyticsButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    const page = await pageFor(app, `${fixtures.devinUrl}/settings/my-analytics`);
    await expect(page.locator('#analyticsLoadCount')).toHaveText('2');
    await waitForEventCount(logFile, 'analytics-refresh', 1);
    await shell.waitForTimeout(500);
    const refreshCount = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"analytics-refresh"')).length;
    expect(refreshCount).toBe(1);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('analytics tab strip: Devin default, Claude tab swaps the hosted view for the shell panel, persists', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-antabs-'));
  const logFile = join(profile, 'events.jsonl');
  let app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    let shell = await shellPage(app);
    let h = hooks(app);

    // --- Devin tab (default): strip under the title bar, hosted view below it.
    await h.setSurface('analytics');
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    await expect(shell.locator('#analyticsTabs')).toBeVisible();
    await expect(shell.locator('#analyticsTab-devin')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('#analyticsTab-claude')).toHaveAttribute('aria-selected', 'false');
    expect(await analyticsTab(app)).toBe('devin');
    await expect(shell.locator('#analyticsRefresh')).toBeDisabled();

    const rects = await h.layoutRects();
    expect(rects.analyticsTabs).not.toBeNull();
    expect(rects.analyticsTabs?.y).toBe(TITLE_BAR_HEIGHT);
    expect(rects.analyticsTabs?.height).toBe(ANALYTICS_TABS_HEIGHT);
    expect(rects.devin.y).toBe(TITLE_BAR_HEIGHT + ANALYTICS_TABS_HEIGHT);
    expect(rects.analyticsTabs?.width).toBe(rects.devin.width);
    await expect.poll(async () => (await h.getAnalyticsBounds())?.width ?? 0).toBeGreaterThan(0);
    expect(await h.getAnalyticsBounds()).toEqual(rects.devin);
    // The shell strip DOM matches the computed rect.
    const stripBox = await shell.locator('#analyticsTabs').boundingBox();
    expect(Math.round(stripBox?.y ?? -1)).toBe(TITLE_BAR_HEIGHT);
    expect(Math.round(stripBox?.height ?? -1)).toBe(ANALYTICS_TABS_HEIGHT);
    expect(Math.round(stripBox?.x ?? -1)).toBe(rects.devin.x);
    await expect(shell.locator('#claudeAnalyticsPanel')).toHaveCount(0);

    // --- Click Claude: setting persisted, hosted view zeroed + detached, panel visible.
    await shell.locator('#analyticsTab-claude').click();
    await expect.poll(() => analyticsTab(app)).toBe('claude');
    await expect(shell.locator('#analyticsTab-claude')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => h.getAnalyticsBounds()).toEqual(ZERO);
    await expect
      .poll(async () =>
        (await h.childViews()).some((view) => view.url?.endsWith('/settings/my-analytics')),
      )
      .toBe(false);
    const panel = shell.locator('#claudeAnalyticsPanel');
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    const claudeRects = await h.layoutRects();
    expect(Math.round(panelBox?.y ?? -1)).toBe(claudeRects.devin.y);
    expect(Math.round(panelBox?.x ?? -1)).toBe(claudeRects.devin.x);
    // DPR rounding of the DOM box can be off by one from the integer layout rect.
    expect(Math.abs((panelBox?.width ?? -1) - claudeRects.devin.width)).toBeLessThanOrEqual(1);
    expect(Math.abs((panelBox?.height ?? -1) - claudeRects.devin.height)).toBeLessThanOrEqual(1);
    expect(await panel.locator('[data-gauge-kind]').count()).toBeGreaterThanOrEqual(2);
    await expect(panel.locator('[data-gauge-kind="session"]')).toHaveCount(1);
    await expect(panel.locator('[data-gauge-kind="weekly_all"]')).toHaveAttribute(
      'data-gauge-percent',
      '10',
    );
    await expect(panel.locator('[data-token-table] [data-token-model]').first()).toBeVisible();
    await expect(panel.locator('[data-daily-bars]')).toBeVisible();
    await expect(shell.locator('#analyticsRefresh')).toBeEnabled();

    const evidenceDir = resolve(process.cwd(), 'docs', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    await shell.screenshot({ path: join(evidenceDir, 'analytics-claude-panel.png') });

    // --- Arrow keys switch tabs (wrap both ways).
    await shell.locator('#analyticsTab-claude').focus();
    await shell.keyboard.press('ArrowRight');
    await expect.poll(() => analyticsTab(app)).toBe('devin');
    await expect.poll(async () => (await h.getAnalyticsBounds())?.width ?? 0).toBeGreaterThan(0);
    await shell.locator('#analyticsTab-devin').focus();
    await shell.keyboard.press('ArrowLeft');
    await expect.poll(() => analyticsTab(app)).toBe('claude');
    await expect.poll(async () => h.getAnalyticsBounds()).toEqual(ZERO);

    // --- Leaving to Cloud and back keeps the Claude tab; no hosted reload fires.
    const refreshesBefore = (await readEvents(logFile)).filter(
      (e) => e.event === 'analytics-refresh',
    ).length;
    await shell.locator('#cloudButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
    await expect(shell.locator('#analyticsTabs')).toHaveCount(0);
    await expect(shell.locator('#claudeAnalyticsPanel')).toHaveCount(0);
    await shell.locator('#analyticsButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    await expect(shell.locator('#analyticsTab-claude')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('#claudeAnalyticsPanel')).toBeVisible();
    await waitForEventCount(logFile, 'analytics-refresh-skipped', 1);
    expect(await h.getAnalyticsBounds()).toEqual(ZERO);
    const refreshesAfter = (await readEvents(logFile)).filter(
      (e) => e.event === 'analytics-refresh',
    ).length;
    expect(refreshesAfter).toBe(refreshesBefore);

    // --- Relaunch: the saved tab is active on entry.
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
    const persisted = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    expect(persisted.analytics.tab).toBe('claude');

    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
    shell = await shellPage(app);
    h = hooks(app);
    await h.setSurface('analytics');
    await expect.poll(async () => (await state(app)).surface).toBe('analytics');
    await expect(shell.locator('#analyticsTab-claude')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('#claudeAnalyticsPanel')).toBeVisible();
    expect(await h.getAnalyticsBounds()).toBeNull(); // never created on the Claude tab
    // Back to Devin: the hosted view is created lazily with the reduced rect.
    await shell.locator('#analyticsTab-devin').click();
    await expect.poll(() => analyticsTab(app)).toBe('devin');
    await expect.poll(async () => (await h.getAnalyticsBounds())?.width ?? 0).toBeGreaterThan(0);
    expect(await h.getAnalyticsBounds()).toEqual((await h.layoutRects()).devin);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
