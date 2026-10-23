// B1 T24: OpenHands end-to-end flows (login, API key, partition isolation,
// auth-origin hop, shortcuts, base-URL change, server-side deletes) against the
// fixture servers. Per-surface mechanics (rows, menus, views) live in
// openhandsViews.spec.ts; the runtime gate in openhandsRuntime.spec.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ShellState } from '../../src/shared/ipc';
import {
  evaluateInShell,
  launchApp,
  readEvents,
  setInputValue,
  shellPage,
  state as publicState,
} from './helpers';

const state = async (app: ElectronApplication) => (await publicState(app)) as unknown as ShellState;
const ID1 = '0123456789abcdef0123456789abcd01';
const ID2 = '0123456789abcdef0123456789abcd02';
const ID3 = '0123456789abcdef0123456789abcd03';
const ALT1 = 'fedcba9876543210fedcba9876543a01';
const ALT2 = 'fedcba9876543210fedcba9876543a02';
const FIXTURE_JSON = join(__dirname, '..', 'fixtures', 'openhands-conversations.json');
const ALIAS = 'https://alt.openhands.test';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

// Every test mutates shared fixture data: put it all back.
test.afterEach(() => {
  fixtures.openhands.setConversations(JSON.parse(readFileSync(FIXTURE_JSON, 'utf8')));
  fixtures.openhands.requireAuth('none');
  fixtures.openhands.setLoginRedirect(false);
  fixtures.openhands.setStatus('delete', 0);
  fixtures.openhandsAlt.setConversations(JSON.parse(readFileSync(FIXTURE_JSON, 'utf8')));
});

async function launch(profile: string, extraEnv: Record<string, string> = {}) {
  const app = await launchApp(profile, join(profile, 'events.jsonl'), join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    ...extraEnv,
  });
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return app;
}

async function quit(app: ElectronApplication, profile: string): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const hook = <T>(app: ElectronApplication, name: string, ...args: unknown[]) =>
  app.evaluate(
    async (_electron, [n, a]) => (globalThis as any).__agentworkspace[n as string](...(a as unknown[])) as T,
    [name, args] as [string, unknown[]],
  );

type ViewInfo = { key: string; url: string; active: boolean; loads: number; loading: boolean };
const views = (app: ElectronApplication) => hook<ViewInfo[]>(app, 'openhandsViewsInfo');
const activeView = async (app: ElectronApplication) => (await views(app)).find((v) => v.active);

const inActiveView = async (app: ElectronApplication, expr: string) => {
  // The view's url is empty until its first navigation commits.
  await expect.poll(async () => (await activeView(app))?.url).toMatch(/^http/);
  const url = (await activeView(app))!.url;
  return app.evaluate(
    async ({ webContents }, [script, target]) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL() === target);
      return wc ? ((await wc.executeJavaScript(script as string)) as unknown) : undefined;
    },
    [expr, url] as [string, string],
  );
};

const shell = (app: ElectronApplication, expr: string) => evaluateInShell(app, expr);
const attr = (app: ElectronApplication, id: string, name: string) =>
  shell(app, `document.getElementById('${id}')?.getAttribute('${name}') ?? null`);

async function clickRail(app: ElectronApplication) {
  const page = await shellPage(app);
  await page.locator('#openhandsButton').click();
  await expect.poll(async () => (await state(app)).surface).toBe('openhands');
  return page;
}

async function openSettingsTab(app: ElectronApplication) {
  await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
  await expect.poll(async () => shell(app, `Boolean(document.getElementById('settingsTabs'))`)).toBe(true);
  await shell(app, `document.querySelector('[data-settings-tab="openhands"]').click()`);
  await expect
    .poll(async () => shell(app, `Boolean(document.getElementById('openhandsApiKeyInput'))`))
    .toBe(true);
}

const cookieNames = (app: ElectronApplication, partition: string) =>
  app.evaluate(
    async ({ session }, name) => (await session.fromPartition(name).cookies.get({})).map((c) => c.name),
    partition,
  );

const altRow = (id: string, title: string, repo: string) => ({
  id,
  title,
  selected_repository: repo,
  git_provider: 'github',
  sandbox_status: 'RUNNING',
  execution_status: 'finished',
  created_at: '2026-10-21T09:00:00Z',
  updated_at: '2026-10-21T10:00:00Z',
});

test('cookie login: login-required until /login is loaded in the OpenHands view, then web-session', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile);
  try {
    fixtures.openhands.requireAuth('cookie');
    const page = await clickRail(app);
    await expect.poll(async () => (await state(app)).openhands.connection).toBe('login-required');
    await expect(page.locator('#openhandsLogin')).toBeVisible();
    await openSettingsTab(app);
    await expect
      .poll(async () => attr(app, 'openhandsConnectionStatus', 'data-status'))
      .toBe('login-required');

    const surface = await clickRail(app);
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    await inActiveView(app, `location.href = '/login'`);
    await expect.poll(async () => cookieNames(app, 'persist:openhands')).toContain('openhands_auth');
    await hook(app, 'openhandsRefresh');
    await expect.poll(async () => (await state(app)).openhands.sessions.length).toBe(3);
    expect((await state(app)).openhands.connection).toBe('web-session');
    await expect(surface.locator('#openhandsLogin')).toHaveCount(0);
    await openSettingsTab(app);
    await expect
      .poll(async () => attr(app, 'openhandsConnectionStatus', 'data-status'))
      .toBe('web-session');
  } finally {
    await quit(app, profile);
  }
});

test('API key saved in Settings goes out as a bearer token and never leaks', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile);
  const KEY = 'OH-E2E-KEY-5-abcdef';
  try {
    fixtures.openhands.requireAuth('bearer');
    await openSettingsTab(app);
    await setInputValue(app, 'openhandsApiKeyInput', KEY);
    await shell(app, `document.getElementById('openhandsApiKeySave').click()`);
    await expect.poll(async () => (await state(app)).openhandsApiKeySet).toBe(true);
    await expect.poll(() => fixtures.openhands.lastAuthHeader()).toBe(`Bearer ${KEY}`);
    await expect.poll(async () => attr(app, 'openhandsConnectionStatus', 'data-status')).toBe('api-key');
    await expect.poll(async () => (await state(app)).openhands.sessions.length).toBe(3);

    // The persisted cache is written after the first live list.
    const cacheFile = join(profile, 'openhands-cache.json');
    await expect.poll(() => existsSync(cacheFile)).toBe(true);
    const leaks = [KEY, 'SAK-fixture-secret'];
    const haystacks = [
      JSON.stringify(await state(app)),
      readFileSync(cacheFile, 'utf8'),
      JSON.stringify(await readEvents(logFile)),
    ];
    for (const text of haystacks) for (const leak of leaks) expect(text).not.toContain(leak);
  } finally {
    await quit(app, profile);
  }
});

test('partition isolation: the login cookie stays in persist:openhands; the view is sandboxed with no shell or node globals', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile);
  try {
    await clickRail(app);
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    await inActiveView(app, `location.href = '/login'`);
    // Positive control first, then the absence in the Devin partition.
    await expect.poll(async () => cookieNames(app, 'persist:openhands')).toContain('openhands_auth');
    expect(await cookieNames(app, 'persist:cloud')).not.toContain('openhands_auth');

    // Electron 44 reports `preload` as '' in getLastWebPreferences, so the
    // preload path itself cannot be read back; assert the hardening flags and
    // that the page sees none of the shell's / node's globals.
    const probe = await app.evaluate(async ({ webContents, session }, base) => {
      const wc = webContents
        .getAllWebContents()
        .find((c) => c.getURL().startsWith(base) && c.session === session.fromPartition('persist:openhands'));
      if (!wc) return null;
      const p = (wc as any).getLastWebPreferences() as Record<string, unknown>;
      const globals = (await wc.executeJavaScript(
        `({ shellApi: typeof window.agentworkspace, nodeRequire: typeof require, nodeProcess: typeof process })`,
      )) as Record<string, string>;
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
        ...globals,
      };
    }, fixtures.openhands.url);
    expect(probe).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      shellApi: 'undefined',
      nodeRequire: 'undefined',
      nodeProcess: 'undefined',
    });
  } finally {
    await quit(app, profile);
  }
});

test('the auth-origin login hop ends on /login inside the OpenHands view, no tab opened', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile);
  try {
    fixtures.openhands.setLoginRedirect(true);
    await clickRail(app);
    await expect
      .poll(async () => (await activeView(app))?.url)
      .toBe(`${fixtures.openhands.url}/login`);
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect((await views(app)).every((v) => v.url.startsWith(fixtures.openhands.url))).toBe(true);
  } finally {
    await quit(app, profile);
  }
});

test('Ctrl+Shift+S toggles the sessions column on the OpenHands surface, both ways', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile);
  const press = () =>
    app.evaluate(() => {
      const shellContents = (globalThis as any).__agentworkspace.getShellWebContents();
      const modifiers = ['control', 'shift'];
      shellContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers });
      shellContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers });
    });
  try {
    await clickRail(app);
    expect((await state(app)).sessionsOpen).toBe(true);
    await press();
    await expect.poll(async () => (await state(app)).sessionsOpen).toBe(false);
    await expect.poll(async () => (await state(app)).settings.sessions.open).toBe(false);
    await press();
    await expect.poll(async () => (await state(app)).sessionsOpen).toBe(true);
    expect((await state(app)).surface).toBe('openhands');
  } finally {
    await quit(app, profile);
  }
});

test('changing the base URL in Settings drops every pooled view; the surface then lists only the new origin', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile, {
    AGENT_WORKSPACE_TEST_OPENHANDS_URL_MAP: `${ALIAS}=${fixtures.openhandsAlt.url}`,
  });
  try {
    fixtures.openhandsAlt.setConversations([
      altRow(ALT1, 'Alt one', 'alt/repo'),
      altRow(ALT2, 'Alt two', 'alt/repo'),
    ]);
    const page = await clickRail(app);
    await expect.poll(async () => (await state(app)).openhands.sessions.length).toBe(3);
    const sidebar = page.locator('section[data-sidebar="openhands"]');
    await sidebar.locator(`[data-session-id="${ID1}"]`).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID1);

    await openSettingsTab(app);
    await setInputValue(app, 'openhandsBaseUrlInput', ALIAS);
    await shell(app, `document.querySelector('[data-settings-tab="general"]').click()`);
    await expect.poll(async () => (await state(app)).settings.openhands.baseUrl).toBe(ALIAS);
    // Off the OpenHands surface: nothing is reloaded on the new origin.
    await expect.poll(async () => views(app)).toEqual([]);
    expect((await state(app)).openhandsSessionId).toBeNull();

    await clickRail(app);
    await expect
      .poll(async () => (await state(app)).openhands.sessions.map((s) => s.id).sort())
      .toEqual([ALT1, ALT2]);
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    await expect
      .poll(async () => (await activeView(app))?.url.startsWith(fixtures.openhandsAlt.url))
      .toBe(true);
    const rows = await sidebar
      .locator('[data-session-id]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')));
    expect(rows.sort()).toEqual([ALT1, ALT2]);
    for (const id of [ID1, ID2, ID3]) expect(rows).not.toContain(id);
  } finally {
    await quit(app, profile);
  }
});

test('a conversation deleted server-side disappears after a full refresh', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile);
  try {
    const page = await clickRail(app);
    const sidebar = page.locator('section[data-sidebar="openhands"]');
    await expect(sidebar.locator('[data-session-id]')).toHaveCount(3);
    const all = JSON.parse(readFileSync(FIXTURE_JSON, 'utf8')) as { id: string }[];
    fixtures.openhands.setConversations(all.filter((c) => c.id !== ID2));
    await hook(app, 'openhandsRefresh');
    await expect(sidebar.locator('[data-session-id]')).toHaveCount(2);
    await expect(sidebar.locator(`[data-session-id="${ID2}"]`)).toHaveCount(0);
  } finally {
    await quit(app, profile);
  }
});

test('deleting the open conversation drops its view and falls back to home; a failed delete changes nothing', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-oh-'));
  const app = await launch(profile);
  try {
    const page = await clickRail(app);
    const sidebar = page.locator('section[data-sidebar="openhands"]');
    const row = (id: string) => sidebar.locator(`[data-session-id="${id}"]`);
    const ids = async () => (await hook<{ id: string }[]>(app, 'openhandsMenuItems')).map((i) => i.id);
    const deleteViaMenu = async (id: string) => {
      await row(id).click({ button: 'right' });
      await expect.poll(ids).toContain('delete');
      await hook(app, 'openhandsMenuClick', 'delete');
    };

    await expect(row(ID1)).toHaveCount(1);
    await row(ID1).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID1);
    await row(ID2).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID2);
    await row(ID1).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID1);

    // HTTP failure: pool, scope and rows stay as they were.
    fixtures.openhands.setStatus('delete', 500);
    await deleteViaMenu(ID1);
    await expect.poll(async () => (await state(app)).openhands.lastError?.op).toBe('delete');
    expect((await views(app)).map((v) => v.key).sort()).toEqual(['home', ID1, ID2].sort());
    expect((await activeView(app))?.key).toBe(ID1);
    expect((await state(app)).openhandsSessionId).toBe(ID1);
    fixtures.openhands.setStatus('delete', 0);

    // Success: the background view of another conversation is untouched.
    await deleteViaMenu(ID1);
    await expect.poll(async () => (await views(app)).some((v) => v.key === ID1)).toBe(false);
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    const s = await state(app);
    expect(s.openhandsSessionId).toBeNull();
    expect(s.tabs.scope).toBe('');
    expect(s.surface).toBe('openhands');
    expect((await views(app)).map((v) => v.key).sort()).toEqual(['home', ID2].sort());
    await expect(row(ID1)).toHaveCount(0);

    // Deleting a conversation whose view is only pooled leaves the active view alone.
    await row(ID2).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID2);
    await page.locator('#openhandsSessionNew').click();
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    await deleteViaMenu(ID2);
    await expect.poll(async () => (await views(app)).map((v) => v.key)).toEqual(['home']);
    expect((await activeView(app))?.key).toBe('home');
  } finally {
    await quit(app, profile);
  }
});
