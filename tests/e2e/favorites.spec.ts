// Favorites: the #tabFavorites star pops a native cascading menu of the user's
// Chrome bookmarks (test mode describes it; favoritesMenuClick drives a click).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { buildFavoritesMenu, parseChromeBookmarks, type FavoritesMenuNode } from '../../src/core/chromeBookmarks';
import { closeApp, evaluateInShell, launchApp, readEvents, shellPage, state, waitForTabCount } from './helpers';

interface MenuItem {
  id: string;
  label: string;
  enabled: boolean;
  submenu?: MenuItem[];
}
type G = typeof globalThis & {
  __agentworkspace: {
    favoritesMenuItems(): MenuItem[] | null;
    favoritesMenuClick(id: string): { action: string | null };
    loadDevinUrl(url: string): void;
    setPaneOpen(value: boolean): void;
    tabInfo(id: string): { url: string; originSessionId: string | null } | null;
  };
};

const FIXTURE = join(process.cwd(), 'tests/fixtures/chrome-user-data');

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
  dir: string;
  chrome: string;
  logFile: string;
}

// A per-test copy of the fixture Chrome user-data dir (tests overwrite `Bookmarks`).
// Bookmark URLs point at the local fixture server so a clicked one never leaves the machine.
function copyChrome(dir: string): string {
  const chrome = join(dir, 'chrome-user-data');
  cpSync(FIXTURE, chrome, { recursive: true });
  for (const profile of ['Profile 1', 'Default']) {
    const file = join(chrome, profile, 'Bookmarks');
    const text = readFileSync(file, 'utf8')
      .replaceAll('https://example.com/', `${fixtures.idpUrl}/page/`)
      .replaceAll('https://example.org/', `${fixtures.idpUrl}/page/org-`)
      .replaceAll('https://example.net/', `${fixtures.idpUrl}/page/net-`);
    writeFileSync(file, text);
  }
  return chrome;
}

async function launch(opts: { chrome?: boolean; settings?: unknown } = {}): Promise<Launched> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-favorites-menu-'));
  const chrome = opts.chrome === false ? join(dir, 'no-chrome') : copyChrome(dir);
  if (opts.settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(opts.settings));
  const logFile = join(dir, 'events.jsonl');
  const app = await launchApp(dir, logFile, join(dir, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CHROME_USER_DATA: chrome,
  });
  const shell = await shellPage(app);
  await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(true));
  return { app, shell, dir, chrome, logFile };
}

async function dispose(launched: Launched): Promise<void> {
  await closeApp(launched.app);
  rmSync(launched.dir, { recursive: true, force: true });
}

function menuItems(app: ElectronApplication): Promise<MenuItem[] | null> {
  return app.evaluate(() => (globalThis as G).__agentworkspace.favoritesMenuItems());
}

async function loadCount(logFile: string): Promise<number> {
  return (await readEvents(logFile)).filter((e) => e.event === 'bookmarks-load').length;
}

// Opens the menu with a real click on the star and returns its description. Each
// open re-loads the bookmarks (one `bookmarks-load` event), so waiting for the next
// event proves the description is from this click, not a previous one.
async function openMenu(launched: Launched): Promise<MenuItem[]> {
  const before = await loadCount(launched.logFile);
  await launched.shell.click('#tabFavorites');
  await expect.poll(() => loadCount(launched.logFile)).toBeGreaterThan(before);
  await expect.poll(() => menuItems(launched.app)).not.toBeNull();
  return (await menuItems(launched.app))!;
}

type Shape = { label: string; enabled: boolean; submenu?: Shape[] };
const shape = (items: MenuItem[]): Shape[] =>
  items.map((item) => ({
    label: item.label,
    enabled: item.enabled,
    ...(item.submenu ? { submenu: shape(item.submenu) } : {}),
  }));
const expectedShape = (nodes: FavoritesMenuNode[]): Shape[] =>
  nodes.map((node) =>
    node.kind === 'folder'
      ? { label: node.label, enabled: true, submenu: expectedShape(node.children) }
      : { label: node.label, enabled: node.kind === 'url' },
  );
function treeOf(chrome: string, profile: string): Shape[] {
  const tree = parseChromeBookmarks(JSON.parse(readFileSync(join(chrome, profile, 'Bookmarks'), 'utf8')));
  if (!tree) throw new Error(`fixture ${profile} does not parse`);
  return expectedShape(buildFavoritesMenu(tree));
}

function findByPath(items: MenuItem[], path: string[]): MenuItem {
  let list = items;
  let found: MenuItem | undefined;
  for (const label of path) {
    found = list.find((item) => item.label === label);
    if (!found) throw new Error(`no menu item ${path.join(' > ')}`);
    list = found.submenu ?? [];
  }
  return found!;
}

function flatIds(items: MenuItem[]): string[] {
  return items.flatMap((item) => [item.id, ...flatIds(item.submenu ?? [])]);
}

function collectBookmarkStrings(chrome: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { name?: unknown; url?: unknown; children?: unknown[]; type?: unknown };
    if (n.type === 'url' || n.type === 'folder') {
      if (typeof n.name === 'string' && n.name) out.push(n.name);
      if (typeof n.url === 'string') out.push(n.url);
    }
    for (const child of n.children ?? []) walk(child);
  };
  for (const profile of ['Profile 1', 'Default']) {
    const roots = JSON.parse(readFileSync(join(chrome, profile, 'Bookmarks'), 'utf8')).roots as Record<string, unknown>;
    for (const root of Object.values(roots)) walk(root);
  }
  return out;
}

test('the star shows the last-used profile; a 3-deep click opens a tab; the profile setting switches the tree', async () => {
  const launched = await launch();
  const { app, shell, chrome, logFile } = launched;
  // Read before the test truncates a Bookmarks file.
  const strings = collectBookmarkStrings(chrome);
  try {
    const star = shell.locator('#tabFavorites');
    await expect(star).toHaveAttribute('title', 'Chrome bookmarks');
    await expect(star).toHaveAttribute('aria-label', 'Chrome bookmarks');
    // Far right of the pane segment: right after #tabNew.
    expect(
      await evaluateInShell(app, `document.getElementById('tabNew').nextElementSibling?.id ?? null`),
    ).toBe('tabFavorites');

    await app.evaluate(
      (_e, url: string) => (globalThis as G).__agentworkspace.loadDevinUrl(url),
      `${fixtures.devinUrl}/sessions/A`,
    );
    await expect.poll(async () => (await state(app)).tabs.scope).toBe('A');

    const menu = await openMenu(launched);
    expect(shape(menu)).toEqual(treeOf(chrome, 'Profile 1'));
    // Spot checks that do not depend on buildFavoritesMenu.
    expect(menu.map((item) => item.label)).toEqual(['Example', 'Q&&A Board', 'Work', 'Many', 'Other bookmarks']);
    const many = findByPath(menu, ['Many']).submenu!;
    expect(many).toHaveLength(201);
    expect(many.at(-1)).toMatchObject({ label: '… 50 more', enabled: false });
    expect(flatIds(menu)).toEqual(flatIds(menu).map((_id, i) => `m${i}`));

    const deep = findByPath(menu, ['Work', 'Projects', 'Deep', 'Deep link']);
    const deepUrl = `${fixtures.idpUrl}/page/deep`;
    const reply = await app.evaluate(
      (_e, id: string) => (globalThis as G).__agentworkspace.favoritesMenuClick(id),
      deep.id,
    );
    expect(reply.action).toBe('open');
    await waitForTabCount(app, 1);
    const tab = (await state(app)).tabs.tabs[0]!;
    expect(
      await app.evaluate((_e, id: string) => (globalThis as G).__agentworkspace.tabInfo(id), tab.id),
    ).toMatchObject({ url: deepUrl, originSessionId: 'A' });
    // The invoke resolved when the item was clicked: no menu is open now.
    await expect.poll(() => menuItems(app)).toBeNull();

    // The profile is resolved at click time.
    await evaluateInShell(app, `window.agentworkspace.setSettings({ favorites: { chromeProfile: 'Default' } })`);
    await expect.poll(async () => shape(await openMenu(launched))).toEqual(treeOf(chrome, 'Default'));
    expect(shape(await menuItems(app) ?? [])).toEqual([{ label: 'Default link', enabled: true }]);

    // Chrome mid-write: a partial Bookmarks file keeps the previous tree.
    const full = readFileSync(join(chrome, 'Default', 'Bookmarks'), 'utf8');
    writeFileSync(join(chrome, 'Default', 'Bookmarks'), full.slice(0, Math.floor(full.length / 2)));
    expect(shape(await openMenu(launched))).toEqual([{ label: 'Default link', enabled: true }]);

    // The log never carries bookmark names or URLs — only tab-user-open's opened URL.
    const events = await readEvents(logFile);
    const opened = events.filter((e) => e.event === 'tab-user-open');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ url: deepUrl, detail: { source: 'favorite', target: 'new' } });
    for (const event of events) {
      // The opened bookmark's URL may appear as a record's `url` (tab-user-open and
      // the new tab's own navigation records); no other field may carry it.
      const scrubbed = JSON.stringify(event.url === deepUrl ? { ...event, url: undefined } : event);
      for (const value of strings) {
        expect(scrubbed, `${String(event.event)} leaks a bookmark string`).not.toContain(value);
      }
    }
  } finally {
    await dispose(launched);
  }
});

test('without Chrome the menu is a single disabled "Chrome bookmarks not found"', async () => {
  const launched = await launch({ chrome: false });
  try {
    expect(await openMenu(launched)).toEqual([
      { id: 'm0', label: 'Chrome bookmarks not found', enabled: false },
    ]);
    // A disabled item does nothing and leaves the menu open.
    const reply = await launched.app.evaluate(() => (globalThis as G).__agentworkspace.favoritesMenuClick('m0'));
    expect(reply.action).toBeNull();
    expect(await menuItems(launched.app)).not.toBeNull();
    expect((await state(launched.app)).tabs.tabs).toHaveLength(0);
  } finally {
    await dispose(launched);
  }
});

test('an unlisted configured profile falls back to last used and keeps the setting; unreadable and empty states', async () => {
  const launched = await launch({ settings: { favorites: { chromeProfile: 'Profile 9' } } });
  const { app, chrome } = launched;
  try {
    expect(shape(await openMenu(launched))).toEqual(treeOf(chrome, 'Profile 1'));
    expect(((await state(app)).settings as { favorites?: { chromeProfile?: unknown } }).favorites?.chromeProfile).toBe(
      'Profile 9',
    );

    // Default never read yet: a partial file has no last good tree.
    const file = join(chrome, 'Default', 'Bookmarks');
    const full = readFileSync(file, 'utf8');
    writeFileSync(file, full.slice(0, Math.floor(full.length / 2)));
    await evaluateInShell(app, `window.agentworkspace.setSettings({ favorites: { chromeProfile: 'Default' } })`);
    await expect
      .poll(async () => shape(await openMenu(launched)))
      .toEqual([{ label: "Chrome bookmarks couldn't be read", enabled: false }]);

    writeFileSync(
      file,
      JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [] }, other: { type: 'folder', children: [] } } }),
    );
    await expect
      .poll(async () => shape(await openMenu(launched)))
      .toEqual([{ label: 'No bookmarks', enabled: false }]);
  } finally {
    await dispose(launched);
  }
});
