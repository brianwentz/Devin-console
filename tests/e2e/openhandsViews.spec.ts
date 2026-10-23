// B1 T22: OpenHands hosted views, auth-origin routing, sidebar, rail and menus
// against the fixture servers.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ShellState } from '../../src/shared/ipc';
import { launchApp, readEvents, shellPage, state as publicState } from './helpers';

const state = async (app: ElectronApplication) => (await publicState(app)) as unknown as ShellState;
const ID1 = '0123456789abcdef0123456789abcd01';
const ID2 = '0123456789abcdef0123456789abcd02';
const ID3 = '0123456789abcdef0123456789abcd03';
const FIXTURE_JSON = join(__dirname, '..', 'fixtures', 'openhands-conversations.json');

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
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

// Runs JS inside the active OpenHands view's page.
const inActiveView = async (app: ElectronApplication, expr: string) => {
  const url = (await activeView(app))!.url;
  return app.evaluate(
    async ({ webContents }, [script, target]) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL() === target);
      return wc ? ((await wc.executeJavaScript(script as string)) as unknown) : undefined;
    },
    [expr, url] as [string, string],
  );
};

async function enterOpenHands(app: ElectronApplication) {
  const page = await shellPage(app);
  await page.locator('#openhandsButton').click();
  await expect.poll(async () => (await state(app)).surface).toBe('openhands');
  await expect.poll(async () => (await state(app)).openhands.status).toBe('ready');
  return page;
}

test('rail button -> sidebar rows from the fixture; a row opens its conversation in a pooled view', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohv-'));
  const app = await launch(profile);
  try {
    // Registered at boot, but no view (so no request) until the surface is entered.
    expect(await views(app)).toEqual([]);
    const page = await shellPage(app);
    await expect(page.locator('#openhandsButton')).toHaveCount(1);
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('button[id$="Button"]')].map((b) => b.id),
    );
    expect(order.indexOf('openhandsButton')).toBe(order.indexOf('claudeButton') + 1);

    await enterOpenHands(app);
    const sidebar = page.locator('section[data-sidebar="openhands"]');
    await expect(sidebar).toHaveCount(1);
    await expect(page.locator('#sessionsPanel')).toHaveCount(0);
    await expect(page.locator('#openhandsSessionNew')).toHaveCount(1);
    await expect(page.locator('#openhandsRefresh')).toHaveCount(1);
    await expect(page.locator('#openhandsFilter')).toHaveCount(1);
    await expect(sidebar.locator('[data-session-id][data-status]')).toHaveCount(3);
    await expect(sidebar.locator(`[data-session-id="${ID1}"]`)).toHaveAttribute('data-status', 'running');
    await expect(sidebar.locator('[data-section-name="acme/web"]')).toHaveCount(1);
    // The row without a repository sits in its own section, untitled.
    await expect(sidebar.locator('[data-section-name="No repository"]')).toHaveCount(1);
    await expect(sidebar.locator(`[data-session-id="${ID3}"]`)).toContainText('Untitled conversation');
    await expect(page.locator('#openhandsLogin')).toHaveCount(0);

    // Entering the surface showed the home view, in its own partition.
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    const home = (await activeView(app))!;
    expect(home.url.startsWith(fixtures.openhands.url)).toBe(true);
    const partitions = await app.evaluate(({ webContents, session }, base) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(base));
      return {
        openhands: wc?.session === session.fromPartition('persist:openhands'),
        cloud: wc?.session === session.fromPartition('persist:cloud'),
      };
    }, fixtures.openhands.url);
    expect(partitions).toEqual({ openhands: true, cloud: false });

    // Row click -> conversation view + scope.
    await sidebar.locator(`[data-session-id="${ID1}"]`).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID1);
    await expect
      .poll(async () => (await activeView(app))?.url)
      .toBe(`${fixtures.openhands.url}/conversations/${ID1}`);
    const s = await state(app);
    expect(s.openhandsSessionId).toBe(ID1);
    expect(s.tabs.scope).toBe(`openhands:${ID1}`);
    await expect(sidebar.locator(`[data-session-id="${ID1}"]`)).toHaveAttribute('data-current', 'true');

    // The home view is still pooled; switching back is a hit, no new view.
    expect((await views(app)).map((v) => v.key).sort()).toEqual(['home', ID1].sort());
    await sidebar.locator(`[data-session-id="${ID2}"]`).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID2);
    await sidebar.locator(`[data-session-id="${ID1}"]`).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID1);
    expect(await views(app)).toHaveLength(3);

    // In-app navigation inside the view rekeys it.
    await inActiveView(app, `location.href = '/conversations/${ID3}'`);
    await expect.poll(async () => (await state(app)).openhandsSessionId).toBe(ID3);
    expect((await views(app)).filter((v) => v.key === ID3)).toHaveLength(1);

    // '+' shows the home page (Ctrl+N does the same).
    await page.locator('#openhandsSessionNew').click();
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    expect((await state(app)).openhandsSessionId).toBeNull();
    expect((await state(app)).tabs.scope).toBe('');
    await sidebar.locator(`[data-session-id="${ID2}"]`).click();
    await expect.poll(async () => (await activeView(app))?.key).toBe(ID2);
    await app.evaluate(() => {
      const shell = (globalThis as any).__agentworkspace.getShellWebContents();
      shell.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] });
      shell.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] });
    });
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    expect((await state(app)).surface).toBe('openhands');

    // Leaving the surface shows Cloud again; the Devin view is not touched.
    await page.locator('#cloudButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');

    // Base URL change while another surface is current: every pooled page is
    // dropped (no off-surface reload); re-entering the surface opens home again.
    await hook(app, 'openhandsResetViews');
    await expect.poll(async () => views(app)).toEqual([]);
    await page.locator('#openhandsButton').click();
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
  } finally {
    await quit(app, profile);
  }
});

test('collapse persists under openhands.collapsedRepos, not sessions.collapsedFolders', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohv-'));
  const app = await launch(profile);
  try {
    const page = await enterOpenHands(app);
    const before = (await state(app)).settings;
    await page.locator('section[data-sidebar="openhands"] [data-section-name="acme/web"]').click();
    await expect
      .poll(async () => (await state(app)).settings.openhands.collapsedRepos)
      .toEqual(['acme/web']);
    const after = (await state(app)).settings;
    expect(after.sessions.collapsedFolders).toEqual(before.sessions.collapsedFolders);
    await expect(
      page.locator(`section[data-sidebar="openhands"] [data-session-id="${ID1}"]`),
    ).toHaveCount(0);
  } finally {
    await quit(app, profile);
  }
});

test('native menus: session items, header items, rename, copy id, open in browser, delete', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohv-'));
  const app = await launch(profile);
  try {
    const page = await enterOpenHands(app);
    const sidebar = page.locator('section[data-sidebar="openhands"]');
    const row = (id: string) => sidebar.locator(`[data-session-id="${id}"]`);
    const ids = async () =>
      (await hook<{ id: string }[]>(app, 'openhandsMenuItems')).map((item) => item.id);

    // Session menu (the invoke stays open until a click).
    await row(ID2).click({ button: 'right' });
    await expect.poll(ids).toEqual(['rename', 'copy-id', 'open-in-browser', 'delete']);
    expect(await hook(app, 'openhandsMenuClick', 'copy-id')).toEqual({ action: null });
    await row(ID2).click({ button: 'right' });
    await expect.poll(ids).toHaveLength(4);
    await hook(app, 'openhandsMenuClick', 'open-in-browser');

    // Rename: the menu answers {action:'rename'}, the shell shows an inline input.
    await row(ID2).click({ button: 'right' });
    await expect.poll(ids).toHaveLength(4);
    expect(await hook(app, 'openhandsMenuClick', 'rename')).toEqual({ action: 'rename' });
    const input = page.locator('#openhandsSessionRenameEdit');
    await expect(input).toHaveCount(1);
    await input.fill('Renamed by the sidebar');
    await input.press('Enter');
    await expect
      .poll(() => fixtures.openhands.mutations().filter((m) => m.op === 'rename').length)
      .toBe(1);
    expect(fixtures.openhands.mutations().find((m) => m.op === 'rename')).toMatchObject({ id: ID2 });
    await expect(page.locator('#openhandsSessionRenameEdit')).toHaveCount(0);
    await expect(row(ID2)).toContainText('Renamed by the sidebar');

    // Delete: confirm is auto-accepted in test mode.
    await row(ID3).click({ button: 'right' });
    await expect.poll(ids).toHaveLength(4);
    await hook(app, 'openhandsMenuClick', 'delete');
    await expect
      .poll(() => fixtures.openhands.mutations().filter((m) => m.op === 'delete').length)
      .toBe(1);
    expect(fixtures.openhands.mutations().find((m) => m.op === 'delete')).toMatchObject({ id: ID3 });
    await expect(row(ID3)).toHaveCount(0);

    // Header menu.
    await page.locator('#openhandsSessionsMenu').click();
    await expect.poll(ids).toEqual(['new-session', 'refresh']);
    await hook(app, 'openhandsMenuClick', 'refresh');

    const recorded = await hook<{ op: string; payload: Record<string, unknown> }[]>(
      app,
      'openhandsMutations',
    );
    expect(recorded.map((m) => m.op)).toEqual(
      expect.arrayContaining(['copy-id', 'open-in-browser', 'rename', 'delete', 'refresh']),
    );
    expect(recorded.find((m) => m.op === 'copy-id')?.payload).toEqual({ id: ID2 });
    expect(JSON.stringify(recorded)).not.toContain('Renamed by the sidebar');

    // No titles in the event log.
    const events = JSON.stringify(await readEvents(join(profile, 'events.jsonl')));
    expect(events).not.toContain('Renamed by the sidebar');
  } finally {
    fixtures.openhands.setConversations(JSON.parse(readFileSync(FIXTURE_JSON, 'utf8')));
    await quit(app, profile);
  }
});

test('login / API-key hints follow the connection state', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohv-'));
  const app = await launch(profile);
  try {
    fixtures.openhands.requireAuth('bearer');
    const page = await shellPage(app);
    await page.locator('#openhandsButton').click();
    // No key + a server that wants a bearer token -> the cookie path is refused.
    await expect.poll(async () => (await state(app)).openhands.connection).toBe('login-required');
    await expect(page.locator('#openhandsLogin')).toHaveCount(1);
    await page.locator('#openhandsLogin').click();
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');

    fixtures.openhands.setStatus('search', 401);
    await hook(app, 'secretsSetOpenHands', 'WRONG-KEY');
    await hook(app, 'openhandsRefresh');
    await expect.poll(async () => (await state(app)).openhands.connection).toBe('api-key-rejected');
    await expect(page.locator('#openhandsApiKeyHint')).toHaveCount(1);
    await expect(page.locator('#openhandsLogin')).toHaveCount(0);
    await page.locator('#openhandsApiKeyHint').click();
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await expect(page.locator('#settingsPanel-openhands')).toHaveCount(1);
  } finally {
    fixtures.openhands.setStatus('search', 0);
    fixtures.openhands.requireAuth('none');
    await quit(app, profile);
  }
});

test('auth origins keep an OpenHands login hop in place; other GitHub links open a tab', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohv-'));
  const app = await launch(profile, {
    AGENT_WORKSPACE_TEST_OPENHANDS_AUTH_ORIGIN: `${fixtures.openhands.authOrigin},${fixtures.githubUrl}/login`,
  });
  try {
    await enterOpenHands(app);
    await expect.poll(async () => (await activeView(app))?.key).toBe('home');
    await expect.poll(async () => (await activeView(app))?.loading).toBe(false);

    // A non-auth GitHub link from the view splits off into a tab.
    await inActiveView(app, `location.href = '${fixtures.githubUrl}/page/not-auth'`);
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(1);
    expect((await activeView(app))!.url.startsWith(fixtures.openhands.url)).toBe(true);

    // The IdP hop stays in the OpenHands view (and creates no tab).
    await inActiveView(app, `location.href = '${fixtures.githubUrl}/login/oauth/authorize?x=1'`);
    await expect
      .poll(async () => (await activeView(app))?.url)
      .toContain(`${fixtures.githubUrl}/login/oauth/authorize`);
    expect((await state(app)).tabs.tabs.length).toBe(1);
    const events = await readEvents(join(profile, 'events.jsonl'));
    expect(
      events.some(
        (e) =>
          e.event === 'will-navigate' &&
          e.decision === 'allow-in-view' &&
          String(e.url).includes('/login/oauth/authorize'),
      ),
    ).toBe(true);
  } finally {
    await quit(app, profile);
  }
});
