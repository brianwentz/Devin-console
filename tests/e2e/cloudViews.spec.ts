import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  launchApp,
  readEvents,
  shellPage,
  state,
  waitForEvent,
} from './helpers';
import type { CloudListResult } from '../../src/core/cloudAcp';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

type ViewInfo = { key: string; url: string; active: boolean; loads: number; loading: boolean };

function hooks(app: ElectronApplication) {
  return {
    views: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.cloudViewsInfo()) as Promise<
        ViewInfo[]
      >,
    cloudShow: (id: string) =>
      app.evaluate(
        (_e, value: string) => (globalThis as any).__devinworkspaces.cloudShow(value),
        id,
      ),
    prefetch: (id: string) =>
      app.evaluate(
        (_e, value: string) => (globalThis as any).__devinworkspaces.cloudPrefetchHook(value),
        id,
      ),
    idleSweep: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.cloudIdleSweep()),
    setKeepAlive: (ms: number) =>
      app.evaluate(
        (_e, value: number) => (globalThis as any).__devinworkspaces.setCloudKeepAliveMs(value),
        ms,
      ),
    loadDevinUrl: (url: string) =>
      app.evaluate(
        (_e, value: string) => (globalThis as any).__devinworkspaces.loadDevinUrl(value),
        url,
      ),
    loadPooled: (key: string, url: string) =>
      app.evaluate(
        (_e, args: { key: string; url: string }) =>
          (globalThis as any).__devinworkspaces.cloudViewLoadUrl(args.key, args.url),
        { key, url },
      ),
    ipcProbe: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.ipcProbe()) as Promise<{
        pooled: boolean | null;
      }>,
  };
}

const A = 'bbbb0000000000000000000000000002';
const B = 'eeee0000000000000000000000000005';
const C = '22220000000000000000000000000000';
const D = '33330000000000000000000000000000';

test('cloud view pool: cache, eviction, rekey, prefetch, guards, shutdown', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-cloudviews-'));
  const logFile = join(profile, 'events.jsonl');
  const fixturePath = join(profile, 'cloudSessions.json');
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/cloudSessions.json'), 'utf8'),
  ) as CloudListResult;
  for (const session of raw.sessions) {
    session.url = `${fixtures.devinUrl}/sessions/${session.id}`;
  }
  writeFileSync(fixturePath, JSON.stringify(raw));

  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_TEST_CLOUD_SESSIONS: fixturePath,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    const page = await shellPage(app);
    await expect(page.locator('#sessionsPanel')).toBeVisible();

    // --- (1) cached switch -------------------------------------------------
    const row = (id: string) => page.locator(`[data-session-id="${id}"]`);
    await row(A).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(A);
    await expect.poll(async () => (await h.views()).length).toBe(2);
    let views = await h.views();
    const viewA = views.find((v) => v.key === A)!;
    expect(viewA.active).toBe(true);
    await expect
      .poll(async () => (await h.views()).find((v) => v.key === A)!.url)
      .toBe(`${fixtures.devinUrl}/sessions/${A}`);

    await row(B).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(B);
    await expect.poll(async () => (await h.views()).length).toBe(3);

    // Back to A: cached — no reload, active again quickly.
    const loadsA = (await h.views()).find((v) => v.key === A)!.loads;
    await row(A).click();
    const t0 = Date.now();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(A);
    expect(Date.now() - t0).toBeLessThan(200);
    views = await h.views();
    expect(views.length).toBe(3);
    expect(views.find((v) => v.key === A)!.loads).toBe(loadsA);
    expect(views.find((v) => v.key === A)!.active).toBe(true);

    // --- (5) prefetch on hover ----------------------------------------------
    // Real pointer hover over row C → 300 ms → pooled view without activation.
    const rowC = row(C);
    const box = await rowC.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect
      .poll(async () => (await h.views()).some((v) => v.key === C && !v.active), {
        timeout: 5000,
      })
      .toBe(true);
    expect((await state(app)).currentSessionId).toBe(A);
    await expect.poll(async () => rowC.getAttribute('data-live')).toBe('true');

    // --- (2) keepAliveMs 0 → switch discards --------------------------------
    await h.setKeepAlive(0);
    await row(D).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(D);
    // Everything non-active (home, B, C, A) is discarded on the switch.
    await expect.poll(async () => (await h.views()).length).toBe(1);
    const discards = (await readEvents(logFile)).filter(
      (e) => e.event === 'cloud-view-discard' && (e.detail as any)?.reason === 'switch',
    );
    expect(discards.length).toBeGreaterThanOrEqual(3);
    await h.setKeepAlive(24 * 3600 * 1000);

    // --- (3) cap eviction -----------------------------------------------------
    // maxLiveViews = 2 via the settings path.
    await page.evaluate(() =>
      (window as any).devinworkspaces.setSettings({ sessions: { maxLiveViews: 2 } }),
    );
    await row(A).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(A);
    await row(B).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(B);
    // Live: B active + one more (cap 2); D (least recently active) evicted.
    await expect.poll(async () => (await h.views()).length).toBeLessThanOrEqual(2);
    expect(
      (await readEvents(logFile)).some(
        (e) => e.event === 'cloud-view-discard' && (e.detail as any)?.reason === 'cap',
      ),
    ).toBe(true);

    // --- (4) rekey: active view navigates to a session another view holds ----
    views = await h.views();
    const bView = views.find((v) => v.key === B);
    if (!bView) {
      // If B was evicted, open it again.
      await row(B).click();
      await expect.poll(async () => (await state(app)).currentSessionId).toBe(B);
    }
    // Activate A (a third session may be evicted at cap 2 — that's fine).
    await row(A).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(A);
    const before = (await h.views()).length;
    // Drive the ACTIVE (A) view to B's URL — the pooled B view must be dropped.
    await h.loadDevinUrl(`${fixtures.devinUrl}/sessions/${B}`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(B);
    await expect.poll(async () => (await h.views()).length).toBeLessThan(before);
    await expect
      .poll(async () => (await h.views()).filter((v) => v.key === B).length)
      .toBe(1);
    expect(
      (await readEvents(logFile)).some((e) => e.event === 'cloud-view-duplicate'),
    ).toBe(true);

    // --- (6) ipc guard: a pooled NON-active view passes fromHostedView -------
    // The http fixture tenant can't satisfy the guard's https/fixture-origin
    // check — load a github fixture page into the pooled background view.
    await row(D).click();
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(D);
    await expect
      .poll(async () => (await h.views()).filter((v) => !v.active).length)
      .toBeGreaterThanOrEqual(1);
    const nonActive = (await h.views()).find((v) => !v.active)!.key;
    await h.loadPooled(nonActive, `${fixtures.githubUrl}/page/pooled-guard`);
    await expect.poll(async () => (await h.ipcProbe()).pooled, { timeout: 8000 }).toBe(true);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    // --- (7) shutdown closes every pooled view -------------------------------
    await waitForEvent(logFile, 'window-close-complete');
    const close = (await readEvents(logFile)).find((e) => e.event === 'window-close-complete');
    expect((close!.detail as any).webContentsCountAfter).toBe(0);
    rmSync(profile, { recursive: true, force: true });
  }
});
