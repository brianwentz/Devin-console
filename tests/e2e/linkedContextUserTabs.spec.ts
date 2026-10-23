// Linked Context user tabs: the "+" button, the on-demand address bar and its
// shortcuts (Ctrl+T / Ctrl+L). Task 4 adds the drop cases to this file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  closeApp,
  launchApp,
  openTab,
  readEvents,
  shellPage,
  state,
  waitForTabCount,
} from './helpers';

type Rect = { x: number; y: number; width: number; height: number };
type G = typeof globalThis & {
  __agentworkspace: {
    addressBar(): { open: boolean; mode: 'new' | 'current' };
    layoutRects(): { ghTab: Rect | null };
    loadDevinUrl(url: string): void;
    setPaneOpen(value: boolean): void;
    setSurface(value: string): void;
    getShellWebContents(): Electron.WebContents;
  };
};

const TITLE_BAR = 36;
const BAR = 32;

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

interface Launched {
  app: ElectronApplication;
  shell: Page;
  profile: string;
  logFile: string;
}

// Shared launch: one temp profile per test; `profile` lets a test relaunch on it.
async function launch(profile?: string): Promise<Launched> {
  const dir = profile ?? mkdtempSync(join(tmpdir(), 'agent-workspace-usertabs-'));
  const logFile = join(dir, 'events.jsonl');
  const app = await launchApp(dir, logFile, join(dir, 'downloads'), fixtures);
  const shell = await shellPage(app);
  return { app, shell, profile: dir, logFile };
}

async function dispose(launched: Launched, keepProfile = false): Promise<void> {
  await closeApp(launched.app);
  if (!keepProfile) rmSync(launched.profile, { recursive: true, force: true });
}

async function openSession(app: ElectronApplication, name: string): Promise<void> {
  await app.evaluate(
    (_e, url: string) => (globalThis as G).__agentworkspace.loadDevinUrl(url),
    `${fixtures.devinUrl}/sessions/${name}`,
  );
  await expect.poll(async () => (await state(app)).tabs.scope).toBe(name);
}

function addressBar(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as G).__agentworkspace.addressBar());
}

async function ghTabY(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(() => (globalThis as G).__agentworkspace.layoutRects().ghTab?.y);
}

// Main-process shortcuts only see sendInputEvent (before-input-event), never
// Playwright's keyboard. `urlPrefix` targets a hosted view instead of the shell.
async function shortcut(app: ElectronApplication, key: string, urlPrefix?: string): Promise<void> {
  // A hosted tab's webContents may still be loading its first URL: retry until it exists.
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }, arg: { key: string; urlPrefix: string | null }) => {
          const contents = arg.urlPrefix
            ? webContents.getAllWebContents().find((c) => c.getURL().startsWith(arg.urlPrefix!))
            : (globalThis as G).__agentworkspace.getShellWebContents();
          if (!contents) return false;
          contents.sendInputEvent({ type: 'keyDown', keyCode: arg.key, modifiers: ['control'] });
          contents.sendInputEvent({ type: 'keyUp', keyCode: arg.key, modifiers: ['control'] });
          return true;
        },
        { key, urlPrefix: urlPrefix ?? null },
      ),
    )
    .toBe(true);
}

async function addressBarEvents(logFile: string): Promise<Array<Record<string, unknown>>> {
  return (await readEvents(logFile)).filter((event) => event.event === 'address-bar');
}

test('"+" opens the bar; a typed URL opens a tab in the current scope that survives restart', async () => {
  const first = await launch();
  const { app, shell, logFile } = first;
  const typed = `${fixtures.idpUrl}/page/x`;
  try {
    await openSession(app, 'A');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);
    expect(await ghTabY(app)).toBe(TITLE_BAR);

    const plus = shell.locator('#tabNew');
    await expect(plus).toBeVisible();
    await expect(plus).toHaveAttribute('title', 'New tab (Ctrl+T)');
    await plus.click();
    const bar = shell.locator('#tabAddressBar');
    const input = shell.locator('#tabAddressBarInput');
    await expect(bar).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    expect(await addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    // The DOM row sits exactly where main carved the hosted view down.
    const rects = await app.evaluate(() => (globalThis as G).__agentworkspace.layoutRects());
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y)).toBe(TITLE_BAR);
    expect(Math.round(box.height)).toBe(BAR);
    // The shell lays out from its document size, which can differ from the
    // native content bounds by a px at fractional display scales.
    expect(Math.abs(box.x - rects.ghTab!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x + box.width - (rects.ghTab!.x + rects.ghTab!.width))).toBeLessThanOrEqual(1);

    // Rejected input keeps the bar open with the reason inline; no tab.
    await input.fill('javascript:alert(1)');
    await input.press('Enter');
    await expect(shell.locator('#tabAddressBarError')).toHaveText(
      'Only http and https addresses can open here',
    );
    await expect(bar).toBeVisible();
    await input.fill('   ');
    await input.press('Enter');
    await expect(shell.locator('#tabAddressBarError')).toHaveText('Type a web address');
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // Esc closes without a tab.
    await input.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    await plus.click();
    await expect(input).toBeFocused();
    await input.fill(typed);
    await input.press('Enter');
    await waitForTabCount(app, 1);
    await expect.poll(async () => (await state(app)).tabs.tabs[0]?.url).toBe(typed);
    expect((await state(app)).tabs.scope).toBe('A');
    await expect(bar).toHaveCount(0);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);

    const events = await addressBarEvents(logFile);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.detail).toMatchObject({ open: true, mode: 'new', source: 'button' });
    for (const event of events) expect(JSON.stringify(event)).not.toContain('/page/x');
  } finally {
    await dispose(first, true);
  }

  const second = await launch(first.profile);
  try {
    await openSession(second.app, 'A');
    await expect
      .poll(async () => (await state(second.app)).tabs.tabs.map((tab) => tab.url))
      .toEqual([typed]);
    expect(await addressBar(second.app)).toEqual({ open: false, mode: 'new' });
  } finally {
    await dispose(second);
  }
});

test('Ctrl+T and Ctrl+L open the bar; Ctrl+L navigates the active tab in place', async () => {
  const launched = await launch();
  const { app, shell } = launched;
  const input = shell.locator('#tabAddressBarInput');
  try {
    await openSession(app, 'A');
    // Ctrl+L with no tabs falls back to a new tab.
    await shortcut(app, 'L');
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await input.press('Escape');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);

    // Ctrl+T with the pane closed opens the pane, then the bar.
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(false));
    await expect.poll(async () => (await state(app)).paneOpen).toBe(false);
    await shortcut(app, 'T');
    await expect.poll(async () => (await state(app)).paneOpen).toBe(true);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect(input).toBeFocused();
    await input.press('Escape');

    const first = `${fixtures.githubUrl}/page/ctrl-l-start`;
    const id = await openTab(app, first);
    await expect.poll(async () => (await state(app)).tabs.tabs[0]?.url).toBe(first);

    // Ctrl+L from the hosted tab itself prefills its URL in mode current.
    await shortcut(app, 'L', first);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'current' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(first);
    const next = `${fixtures.idpUrl}/page/ctrl-l-next`;
    await input.fill(next);
    await input.press('Enter');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);
    await expect.poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.url)).toEqual([next]);
    expect((await state(app)).tabs.tabs.map((tab) => tab.id)).toEqual([id]);

    // Ctrl+T from a hosted tab opens a new-tab bar.
    await shortcut(app, 'T', next);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect(input).toHaveValue('');
  } finally {
    await dispose(launched);
  }
});

test('a Devin tenant URL goes to the Cloud surface; pane toggle, surface switch and scope change close the bar', async () => {
  const launched = await launch();
  const { app, shell } = launched;
  const bar = shell.locator('#tabAddressBar');
  const input = shell.locator('#tabAddressBarInput');
  try {
    await openSession(app, 'A');
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await shell.locator('#tabNew').click();
    await expect(input).toBeFocused();
    const tenant = `${fixtures.devinUrl}/sessions/typed-target`;
    await input.fill(tenant);
    await input.press('Enter');
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('typed-target');
    await expect(bar).toHaveCount(0);
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // Pane hidden while open.
    await shell.locator('#tabNew').click();
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(false));
    await expect.poll(async () => (await addressBar(app)).open).toBe(false);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(true));
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    await expect(bar).toHaveCount(0);

    // Surface switch while open.
    await shell.locator('#tabNew').click();
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => (await addressBar(app)).open).toBe(false);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    await expect(bar).toHaveCount(0);

    // Tab-scope change while open (another Cloud session becomes visible).
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('cloud'));
    await shell.locator('#tabNew').click();
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    await openSession(app, 'B');
    await expect.poll(async () => (await addressBar(app)).open).toBe(false);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    await expect(bar).toHaveCount(0);
  } finally {
    await dispose(launched);
  }
});
