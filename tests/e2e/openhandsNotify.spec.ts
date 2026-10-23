// B2 T26: OpenHands status-transition notifications, PR panel rows from
// `pr_number`, the finished-conversation event scan and PR auto-open, against
// the OpenHands fixture server.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ShellState } from '../../src/shared/ipc';
import { evaluateInShell, launchApp, readEvents, shellPage, state as publicState } from './helpers';

const state = async (app: ElectronApplication) => (await publicState(app)) as unknown as ShellState;
const ID1 = '0123456789abcdef0123456789abcd01';
const ID2 = '0123456789abcdef0123456789abcd02';
const ID3 = '0123456789abcdef0123456789abcd03';
const PR7 = 'https://github.com/o/r/pull/7';
const PR9 = 'https://github.com/o/r/pull/9';
const EVENT_TEXT = 'SECRET-EVENT-TEXT';
const TITLE = 'Ship the PR flow';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const conv = (id: string, execution: string, updated: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id === ID1 ? TITLE : `Conversation ${id.slice(-2)}`,
  selected_repository: 'o/r',
  git_provider: 'github',
  sandbox_status: 'RUNNING',
  execution_status: execution,
  created_at: '2026-10-20T09:00:00Z',
  updated_at: updated,
  ...extra,
});

const hook = <T>(app: ElectronApplication, name: string, ...args: unknown[]) =>
  app.evaluate(
    async (_electron, [n, a]) => (globalThis as any).__agentworkspace[n as string](...(a as unknown[])) as T,
    [name, args] as [string, unknown[]],
  );

type Entry = { id: string; kind: string; source?: string; sessionId: string | null; prUrl?: string | null };
const entries = (app: ElectronApplication) =>
  hook<Entry[]>(app, 'notifications').then((all) => all.filter((n) => n.source === 'openhands'));
const scopeCount = async (app: ElectronApplication, scope: string) =>
  ((await hook<{ scope: string; count: number }[]>(app, 'listScopes')).find((s) => s.scope === scope)?.count ?? 0);
type ViewInfo = { key: string; active: boolean };
const activeKey = async (app: ElectronApplication) =>
  (await hook<ViewInfo[]>(app, 'openhandsViewsInfo')).find((v) => v.active)?.key;

test('transitions notify, PRs reach the panel, a finished conversation’s PR auto-opens in its scope', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohn-'));
  const logFile = join(profile, 'events.jsonl');
  fixtures.openhands.setConversations([
    conv(ID1, 'running', '2026-10-20T10:00:00Z', { pr_number: [7] }),
    conv(ID2, 'running', '2026-10-20T10:00:00Z'),
    conv(ID3, 'running', '2026-10-20T10:00:00Z'),
  ]);
  fixtures.openhands.setEvents(ID1, [
    { id: 'e1', kind: 'MessageEvent', source: 'agent', text: `Opened ${PR9} ${EVENT_TEXT}` },
    { id: 'e2', kind: 'ObservationEvent', observation: 'done' },
  ]);
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    // `finished` is off by default (like Claude): opt in; auto-open stays on.
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ notifications: { kinds: { finished: true } }, prs: { autoOpenTabs: true } })`,
    );
    await expect.poll(async () => (await state(app)).settings.notifications.kinds.finished).toBe(true);

    const page = await shellPage(app);
    await page.locator('#openhandsButton').click();
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
    // Baseline list: no entries, the pr_number PR is listed but never auto-opened.
    await hook(app, 'openhandsRefresh');
    await expect.poll(async () => (await state(app)).openhands.sessions.length).toBe(3);
    expect(await entries(app)).toEqual([]);
    await expect.poll(async () => (await state(app)).notifications.openPrCount).toBe(1);
    expect(await scopeCount(app, `openhands:${ID1}`)).toBe(0);

    // PR panel row for pull/7, marked as an OpenHands PR.
    await evaluateInShell(app, `window.agentworkspace.prsPanel(true)`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `document.querySelector('#prsPanel [data-pr-url="${PR7}"]')?.getAttribute('data-source') ?? null`),
      )
      .toBe('openhands');
    await evaluateInShell(app, `window.agentworkspace.prsPanel(false)`);

    // running -> finished / waiting_for_confirmation / paused.
    fixtures.openhands.setConversations([
      conv(ID1, 'finished', '2026-10-21T10:00:00Z', { pr_number: [7] }),
      conv(ID2, 'waiting_for_confirmation', '2026-10-21T10:00:00Z'),
      conv(ID3, 'paused', '2026-10-21T10:00:00Z'),
    ]);
    await hook(app, 'openhandsRefresh');
    await expect.poll(async () => (await entries(app)).map((e) => `${e.kind}:${e.sessionId}`).sort()).toEqual([
      `finished:${ID1}`,
      `waiting:${ID2}`,
    ]);

    // The finished conversation's events carry PR 9: a lazy background tab in openhands:<ID1>.
    await expect.poll(async () => scopeCount(app, `openhands:${ID1}`)).toBe(1);
    await expect.poll(async () => (await state(app)).notifications.openPrCount).toBe(2);
    const searches = fixtures.openhands.requests().filter((r) => r.path.includes('/events/search'));
    expect(searches).toHaveLength(1);
    const searchUrl = new URL(searches[0]!.path, fixtures.openhands.url);
    expect(searchUrl.pathname).toBe(`/api/v1/conversation/${ID1}/events/search`);
    expect(searchUrl.searchParams.get('limit')).toBe('100');
    expect(searchUrl.searchParams.get('sort_order')).toBe('TIMESTAMP_DESC');

    // Opening the finished notification lands on that conversation; its scope shows PR 9.
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('cloud'));
    const finished = (await entries(app)).find((e) => e.kind === 'finished')!;
    await hook(app, 'notificationsOpen', finished.id);
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
    await expect.poll(async () => activeKey(app)).toBe(ID1);
    expect((await state(app)).openhandsSessionId).toBe(ID1);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe(`openhands:${ID1}`);
    expect((await state(app)).tabs.tabs.map((t) => t.url)).toEqual([PR9]);

    // Opening pull/7 from the PR panel opens it in the same scope on the OpenHands surface.
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('cloud'));
    await evaluateInShell(app, `window.agentworkspace.prsOpen(${JSON.stringify(ID1)}, ${JSON.stringify(PR7)})`);
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
    await expect.poll(async () => (await state(app)).tabs.tabs.map((t) => t.url).sort()).toEqual([PR7, PR9]);
    expect((await state(app)).tabs.scope).toBe(`openhands:${ID1}`);

    const events = await readEvents(logFile);
    const scans = events.filter((e) => e.event === 'openhands-events-scan');
    expect(scans.map((e) => e.detail)).toEqual([{ count: 2, prs: 1 }]);
    const autoOpened = events.filter((e) => e.event === 'pr-auto-open');
    expect(autoOpened.map((e) => (e.detail as { source?: string }).source)).toEqual(['openhands-poll']);
    const text = JSON.stringify(events);
    expect(text).not.toContain(EVENT_TEXT);
    expect(text).not.toContain(TITLE);
  } finally {
    fixtures.openhands.setEvents(ID1, []);
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
