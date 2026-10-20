// R9 tab strip behaviours driven through the shell page with real input:
// dnd-kit pointer reorder (both directions), keyboard reorder (handle + Space/Arrows),
// keyboard activate/close, overflow scrolling keeps the active tab in view, titles update.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  dragTab,
  launchApp,
  openTab,
  shellPage,
  state,
  waitForEvent,
  waitForTabCount,
  waitForTabTitle,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function order(app: ElectronApplication): Promise<string[]> {
  return (await state(app)).tabs.tabs.map((tab) => tab.id);
}

// Fractions of the 1338 px available at the 1400 px test window (see core/layout paneAvailable).
const WIDE_PANE = 0.568; // ≈760 px, rendered at 698 px so the devin view keeps MIN_DEVIN_WIDTH
const NARROW_PANE = 0.314; // ≈420 px

async function setPaneFraction(app: ElectronApplication, fraction: number): Promise<void> {
  await app.evaluate(
    (_e, value: number) => (globalThis as any).__devinworkspaces.setPaneFraction(value),
    fraction,
  );
}

async function domOrder(shell: Page): Promise<string[]> {
  return shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#tabStrip .tab')].map((el) => el.dataset.tabId ?? ''),
  );
}

test('pointer and keyboard reorder, keyboard activate/close, titles', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-strip-'));
  const logFile = join(profile, 'events.jsonl');
  // Headed: dnd-kit's click-vs-drag distinction on the sub-activation-distance
  // move needs a real activated window — the pointerup is otherwise swallowed.
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_TEST_QUIET: '0',
  });
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__devinworkspaces))).toBe(true);
    await setPaneFraction(app, WIDE_PANE);
    const a = await openTab(app, `${fixtures.githubUrl}/page/strip-a`);
    const b = await openTab(app, `${fixtures.githubUrl}/page/strip-b`);
    const c = await openTab(app, `${fixtures.githubUrl}/page/strip-c`);
    await waitForTabTitle(app, 'strip-c');
    await waitForTabTitle(app, 'strip-a');
    const shell = await shellPage(app);
    await expect(shell.locator('#tabStrip .tab')).toHaveCount(3);
    await expect(shell.locator(`[data-tab-id="${a}"] .tabTitle`)).toHaveText('GitHub fixture: strip-a');
    expect(await domOrder(shell)).toEqual([a, b, c]);
    // dragTab is strict: it refuses clipped tabs — the strip must not overflow.
    const stripMetrics = await shell
      .locator('#tabStrip')
      .evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
    console.log('stripMetrics', JSON.stringify(stripMetrics));
    expect(stripMetrics.scrollWidth).toBeLessThanOrEqual(stripMetrics.clientWidth + 1);

    // Pointer: first -> last.
    await dragTab(shell, a, c);
    await waitForEvent(logFile, 'tab-reorder');
    await expect.poll(() => order(app)).toEqual([b, c, a]);
    await expect.poll(() => domOrder(shell)).toEqual([b, c, a]);
    expect((await state(app)).tabs.activeId).toBe(c);

    // Pointer: last -> first.
    await dragTab(shell, a, b);
    await expect.poll(() => order(app)).toEqual([a, b, c]);

    // Pointer: a tiny move (< activation distance) is a click, not a drag: activates.
    const bTab = shell.locator(`[data-tab-id="${b}"]`);
    await bTab.scrollIntoViewIfNeeded();
    const bBox = (await bTab.boundingBox())!;
    await shell.mouse.move(bBox.x + 20, bBox.y + bBox.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(bBox.x + 22, bBox.y + bBox.height / 2);
    await shell.mouse.up();
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(b);
    expect(await order(app)).toEqual([a, b, c]);

    // Keyboard: focus the handle of A, Space picks up, ArrowRight x2, Space drops at the end.
    // dnd-kit re-measures droppables between moves, so give each key a frame.
    const key = async (name: string) => {
      await shell.keyboard.press(name);
      await shell.waitForTimeout(120);
    };
    await shell.focus(`[data-tab-id="${a}"] .dragHandle`);
    await key('Space');
    await key('ArrowRight');
    await key('ArrowRight');
    await key('Space');
    await expect.poll(() => order(app)).toEqual([b, c, a]);

    // Keyboard: Escape cancels a pick-up.
    await shell.focus(`[data-tab-id="${a}"] .dragHandle`);
    await key('Space');
    await key('ArrowLeft');
    await key('Escape');
    await shell.waitForTimeout(200);
    expect(await order(app)).toEqual([b, c, a]);

    // Keyboard on the tab itself: Enter activates, Delete closes (right neighbour becomes active).
    await shell.focus(`[data-tab-id="${c}"]`);
    await shell.keyboard.press('Enter');
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(c);
    await shell.keyboard.press('Delete');
    await waitForTabCount(app, 2);
    expect((await state(app)).tabs.activeId).toBe(a);
    expect(await order(app)).toEqual([b, a]);

    // Close button and middle-click still work with real input.
    await shell.click(`[data-tab-id="${a}"] .closeMark`);
    await waitForTabCount(app, 1);
    expect((await state(app)).tabs.activeId).toBe(b);
    await shell.click(`[data-tab-id="${b}"]`, { button: 'middle' });
    await waitForTabCount(app, 0);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('overflowing strip scrolls the active tab into view', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-strip-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__devinworkspaces))).toBe(true);
    await setPaneFraction(app, NARROW_PANE);
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(await openTab(app, `${fixtures.githubUrl}/page/overflow-${i}`));
    }
    await waitForTabCount(app, 8);
    const shell = await shellPage(app);
    const strip = shell.locator('#tabStrip');
    const metrics = () =>
      strip.evaluate((el) => ({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    const visible = (id: string) =>
      shell.evaluate((tabId: string) => {
        const strip = document.getElementById('tabStrip')!;
        const el = strip.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!;
        const s = strip.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.left >= s.left - 1 && r.right <= s.right + 1;
      }, id);

    const initial = await metrics();
    expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth);
    // Last tab is active (opened last) and must be in view.
    await expect.poll(() => visible(ids[7]!)).toBe(true);
    expect((await metrics()).scrollLeft).toBeGreaterThan(0);

    // Activate the first tab -> strip scrolls back.
    await app.evaluate((_e, id: string) => (globalThis as any).__devinworkspaces.activate(id), ids[0]!);
    await expect.poll(() => visible(ids[0]!)).toBe(true);
    expect((await metrics()).scrollLeft).toBe(0);

    // Ctrl+Tab cycles; the newly active tab is always visible.
    for (let i = 0; i < 5; i += 1) {
      await app.evaluate((_e, id: string) => (globalThis as any).__devinworkspaces.activate(id), ids[i + 1]!);
      await expect.poll(() => visible(ids[i + 1]!)).toBe(true);
    }
    // Middle-click close on a visible tab in the overflowed strip.
    // (Chromium would otherwise start middle-button autoscroll on the scrollable strip.)
    const tabBox = (await shell.locator(`[data-tab-id="${ids[5]}"]`).boundingBox())!;
    const stripBox = (await strip.boundingBox())!;
    // Scrollbar hidden: tabs fill the full strip height.
    expect(tabBox.height).toBe(stripBox.height);
    await shell.click(`[data-tab-id="${ids[5]}"]`, { button: 'middle' });
    await waitForTabCount(app, 7);

    // Vertical wheel over the strip scrolls it horizontally.
    const before = (await metrics()).scrollLeft;
    await shell.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
    await shell.mouse.wheel(0, -200);
    await expect.poll(async () => (await metrics()).scrollLeft).toBeLessThan(before);
    await shell.mouse.wheel(0, 400);
    await expect.poll(async () => (await metrics()).scrollLeft).toBeGreaterThan(before);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
