import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  launchApp,
  openTab,
  readEvents,
  state,
  waitForEvent,
  waitForTabCount,
  webContentsCount,
} from './helpers';

const PAT = 'test-token-123';
const POLL_MS = 500;

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

type PrLink = {
  sessionId: string;
  sessionTitle: string;
  ref: string;
  title: string | null;
  url: string;
  state: string | null;
};

function hooks(app: ElectronApplication) {
  return {
    setPat: (pat: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__devinworkspaces.setPat(value) as Promise<boolean>, pat),
    clearPat: () => app.evaluate(() => (globalThis as any).__devinworkspaces.clearPat() as Promise<void>),
    hasPat: () => app.evaluate(() => (globalThis as any).__devinworkspaces.hasPat() as boolean),
    pollNow: () => app.evaluate(() => (globalThis as any).__devinworkspaces.pollNow() as Promise<void>),
    listPrs: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.listPrs() as PrLink[]),
    openSessionPr: (sessionId: string, url: string) =>
      app.evaluate(
        (_e, args: { sessionId: string; url: string }) =>
          (globalThis as any).__devinworkspaces.openSessionPr(args.sessionId, args.url),
        { sessionId, url },
      ),
    prsPanelOpen: () => app.evaluate(() => (globalThis as any).__devinworkspaces.prsPanelOpen()),
    prRecords: () =>
      app.evaluate(
        () =>
          (globalThis as any).__devinworkspaces.prRecords() as {
            url: string;
            firstSeenAt: number;
            readAt: number | null;
            dismissedAt: number | null;
          }[],
      ),
    newSession: () => app.evaluate(() => (globalThis as any).__devinworkspaces.newSession()),
    // P6 notification center
    notifications: () => app.evaluate(() => (globalThis as any).__devinworkspaces.notifications()),
    openNotification: (id: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__devinworkspaces.notificationsOpen(value), id),
    pushNotification: (partial: Record<string, unknown>) =>
      app.evaluate((_e, value: Record<string, unknown>) => (globalThis as any).__devinworkspaces.pushNotification(value), partial),
    simulateUpdate: (version: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__devinworkspaces.simulateUpdateDownloaded(value), version),
    simulateUpdateAvailable: (version: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__devinworkspaces.simulateUpdateAvailable(value), version),
    simulateUpdateFocus: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.simulateUpdateFocus()),
    simulateUpdateResume: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.simulateUpdateResume()),
    panelOpen: () => app.evaluate(() => (globalThis as any).__devinworkspaces.panelOpen()),
    identity: () =>
      app.evaluate(
        () =>
          (globalThis as any).__devinworkspaces.identity() as {
            source: 'self' | 'cli' | 'inferred' | 'manual' | null;
            maskedUserId: string | null;
            cliOrgMismatch: boolean;
          },
      ),
    identityReset: () =>
      app.evaluate(() => (globalThis as any).__devinworkspaces.identityReset()),
    childViews: () => app.evaluate(() => (globalThis as any).__devinworkspaces.childViews()),
    loadDevinUrl: (url: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__devinworkspaces.loadDevinUrl(value), url),
    closeTab: (id: string) =>
      app.evaluate((_e, value: string) => (globalThis as any).__devinworkspaces.close(value) as Promise<boolean>, id),
    listScopes: () =>
      app.evaluate(
        () =>
          (globalThis as any).__devinworkspaces.listScopes() as Array<{
            scope: string;
            count: number;
            liveCount: number;
          }>,
      ),
    tabInfo: (id: string) =>
      app.evaluate(
        (_e, value: string) =>
          (globalThis as any).__devinworkspaces.tabInfo(value) as {
            url: string;
            originSessionId: string | null;
            discarded: boolean;
            loading: boolean;
            hasView: boolean;
          } | null,
        id,
      ),
    devinUrl: () =>
      app.evaluate(({ webContents }, prefix: string) =>
        webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))?.getURL(), fixtures.devinUrl),
  };
}

async function launch(profile: string, logFile: string, extraEnv: Record<string, string> = {}) {
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_API_BASE: fixtures.apiUrl,
    DEVIN_WORKSPACES_POLL_MS: String(POLL_MS),
    DEVIN_WORKSPACES_TEST_BANNER_MS: '1500',
    ...extraEnv,
  });
  await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__devinworkspaces))).toBe(true);
  return app;
}

async function quit(app: ElectronApplication, profile: string) {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
}

test.beforeEach(() => {
  fixtures.api.setMode({ kind: 'ok' });
  fixtures.api.setSelf('pat_user');
  fixtures.api.setSessions([]);
  fixtures.api.setIgnoreUserIds(false);
  fixtures.api.clearRequests();
});

// The api fixture also serves the eager Claude /api/oauth/usage fetch — the
// assertions below are about the v3 session poller's traffic only.
const v3Requests = () => fixtures.api.requests().filter((r) => r.path.startsWith('/v3'));

test('stores the PAT encrypted, polls with it, notifies in-app on waiting_for_user', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    // No token yet: no API traffic, state reflects it.
    expect((await state(app)).notifications.hasToken).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
    expect(v3Requests().length).toBe(0);

    fixtures.api.setSessions([
      { session_id: 'sess-1', title: 'Fix login bug', status: 'running', status_detail: 'working', updated_at: 10 },
      { session_id: 'sess-2', title: 'Old one', status: 'exit', status_detail: 'finished', updated_at: 5 },
    ]);
    expect(await h.setPat(PAT)).toBe(true);
    expect((await state(app)).notifications.hasToken).toBe(true);

    // The fixture saw the bearer token on /v3/self and the org sessions list.
    await expect
      .poll(() => fixtures.api.requests().some((r) => r.path.startsWith('/v3/organizations/org-fixture/sessions')))
      .toBe(true);
    const requests = v3Requests();
    expect(requests.every((r) => r.authorization === `Bearer ${PAT}`)).toBe(true);
    expect(requests[0]?.path).toBe('/v3/self');
    expect(requests.find((r) => r.path.includes('/sessions'))?.path).toContain('first=100');
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    expect((await state(app)).notifications.unreadCount).toBe(0);

    // Status flips to waiting_for_user -> unread entry + notification-added + badge.
    // sess-other belongs to a different user and is filtered out (user_ids) —
    // it must never produce a notification.
    fixtures.api.setSessions([
      { session_id: 'sess-1', title: 'Fix login bug', status: 'running', status_detail: 'waiting_for_user', updated_at: 11 },
      { session_id: 'sess-2', title: 'Old one', status: 'exit', status_detail: 'finished', updated_at: 5 },
      { session_id: 'sess-other', title: 'Not mine', status: 'running', status_detail: 'waiting_for_user', updated_at: 20, user_id: 'user-other' },
    ]);
    const flippedAt = Date.now();
    await expect
      .poll(async () => (await state(app)).notifications.unreadCount, { timeout: 2000, intervals: [50, 100] })
      .toBe(1);
    const detectedAfterMs = Date.now() - flippedAt;
    expect(detectedAfterMs).toBeLessThan(2000);
    await waitForEvent(logFile, 'notification-added');
    const shown = (await readEvents(logFile)).filter((e) => e.event === 'notification-added');
    expect(shown).toHaveLength(1);
    expect((shown[0]?.detail as any).sessionId).toBe('sess-1');
    expect((shown[0]?.detail as any).kind).toBe('waiting');
    const badges = (await readEvents(logFile)).filter((e) => e.event === 'badge');
    expect((badges.at(-1)?.detail as any).count).toBe(1);
    // The rail badge shows the unread count.
    await expect
      .poll(async () => evaluateInShell(app, `document.getElementById('notificationsBadge')?.textContent`))
      .toBe('1');

    // Same waiting state on later polls does not re-notify.
    await h.pollNow();
    await h.pollNow();
    expect((await readEvents(logFile)).filter((e) => e.event === 'notification-added')).toHaveLength(1);

    // Opening the notification navigates devinView to the session + reads it.
    await evaluateInShell(app, `window.devinworkspaces.setSurface('settings')`);
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    const list = (await h.notifications()) as { id: string; sessionId: string | null; readAt: number | null }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 'sess-1', readAt: null });
    await evaluateInShell(app, `window.devinworkspaces.notificationsOpen('${list[0]!.id}')`);
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
    await expect.poll(() => h.devinUrl()).toBe(`${fixtures.devinUrl}/sessions/sess-1`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('sess-1');
    await expect.poll(async () => (await state(app)).notifications.unreadCount).toBe(0);

    // Session resumes working; unread count unchanged (read entries stay).
    fixtures.api.setSessions([
      { session_id: 'sess-1', title: 'Fix login bug', status: 'running', status_detail: 'working', updated_at: 12 },
    ]);
    await h.pollNow();
    expect((await state(app)).notifications.unreadCount).toBe(0);

    // Secrets at rest: encrypted blob only, no plaintext anywhere on disk or in the log.
    const secretsFile = join(profile, 'secrets.json');
    expect(existsSync(secretsFile)).toBe(true);
    const secrets = JSON.parse(readFileSync(secretsFile, 'utf8')) as { version: number; devinPat?: string };
    expect(secrets.version).toBe(1);
    expect(typeof secrets.devinPat).toBe('string');
    expect(secrets.devinPat).not.toContain(PAT);
    expect(Buffer.from(secrets.devinPat ?? '', 'base64').toString('utf8')).not.toContain(PAT);
    expect(readFileSync(secretsFile, 'utf8')).not.toContain(PAT);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).not.toContain(PAT);
    // ...and the renderer-visible state never carries it.
    expect(JSON.stringify(await state(app))).not.toContain(PAT);
    const shellDump = (await evaluateInShell(
      app,
      `JSON.stringify(Object.keys(window.devinworkspaces)) + document.documentElement.outerHTML`,
    )) as string;
    expect(shellDump).not.toContain(PAT);

    // Clear removes the file and stops polling.
    await h.clearPat();
    expect(await h.hasPat()).toBe(false);
    expect(existsSync(secretsFile)).toBe(false);
    fixtures.api.clearRequests();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    expect(v3Requests().length).toBe(0);
  } finally {
    await quit(app, profile);
  }
});

test('surfaces 401 as authError and honours 429 Retry-After', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    fixtures.api.setSessions([{ session_id: 'sess-1', status: 'running', status_detail: 'working', updated_at: 1 }]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    expect((await state(app)).notifications.authError).toBe(false);

    // 401 -> authError true; recovery when the API accepts the token again.
    fixtures.api.setMode({ kind: 'status', status: 401 });
    await expect.poll(async () => (await state(app)).notifications.authError).toBe(true);
    expect((await state(app)).notifications.lastError).toBe('unauthorized');
    const authEvents = (await readEvents(logFile)).filter(
      (e) => e.event === 'poll-error' && (e.detail as any).kind === 'auth',
    );
    expect(authEvents.length).toBeGreaterThan(0);
    fixtures.api.setMode({ kind: 'ok' });
    await h.pollNow();
    await expect.poll(async () => (await state(app)).notifications.authError).toBe(false);

    // 429 with Retry-After: 2 -> the next request is not before 2s later.
    fixtures.api.clearRequests();
    fixtures.api.setMode({ kind: 'status', status: 429, retryAfter: '2', once: true });
    await expect.poll(() => v3Requests().length).toBeGreaterThanOrEqual(1);
    const limitedAt = v3Requests()[0]!.ts;
    await expect.poll(() => v3Requests().length, { timeout: 6000 }).toBeGreaterThanOrEqual(2);
    const nextAt = v3Requests()[1]!.ts;
    expect(nextAt - limitedAt).toBeGreaterThanOrEqual(1900);
    const rateEvents = (await readEvents(logFile)).filter(
      (e) => e.event === 'poll-error' && (e.detail as any).kind === 'rateLimited',
    );
    expect((rateEvents[0]?.detail as any).retryAfterMs).toBe(2000);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('lists open PRs across my sessions with GitHub titles and opens them in their session', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const longTitle = 'A very long pull request title that keeps on going past sixty-four chars';
  fixtures.github.setPrTitle(42, 'Fix widget alignment');
  fixtures.github.setPrTitle(43, longTitle);
  try {
    const pr42 = `${fixtures.githubUrl}/acme/widgets/pull/42`;
    const pr43 = `${fixtures.githubUrl}/acme/widgets/pull/43`;
    const pr44 = `${fixtures.githubUrl}/acme/widgets/pull/44`;
    const pr7 = `${fixtures.githubUrl}/acme/widgets/pull/7`;
    const pr99 = `${fixtures.githubUrl}/acme/widgets/pull/99`;
    fixtures.api.setSessions([
      {
        session_id: 'sess-pr',
        title: 'PR session',
        status: 'running',
        status_detail: 'working',
        updated_at: 3,
        pull_requests: [
          { pr_url: pr42, pr_state: 'open' },
          { pr_url: pr43, pr_state: null },
          { pr_url: pr44, pr_state: 'merged' },
        ],
      },
      {
        session_id: 'sess-two',
        title: 'Second session',
        status: 'running',
        status_detail: 'working',
        updated_at: 2,
        pull_requests: [{ pr_url: pr7, pr_state: 'open' }],
      },
      // Another user's session: filtered out by user_ids, never listed.
      {
        session_id: 'sess-other',
        title: 'Not mine',
        status: 'running',
        status_detail: 'working',
        updated_at: 9,
        user_id: 'user-other',
        pull_requests: [{ pr_url: pr99, pr_state: 'open' }],
      },
    ]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();

    // The sessions request carries user_ids=user-fixture.
    expect(
      fixtures.api
        .requests()
        .some((r) => r.path.includes('/sessions') && r.path.includes('user_ids=user-fixture')),
    ).toBe(true);

    // Open PRs across my sessions, ordered by session updated_at desc (#44
    // merged and sess-other's #99 are excluded). Works with no current session.
    const prs = await h.listPrs();
    expect(prs).toMatchObject([
      { sessionId: 'sess-pr', sessionTitle: 'PR session', ref: 'acme/widgets#42', url: pr42, state: 'open' },
      { sessionId: 'sess-pr', sessionTitle: 'PR session', ref: 'acme/widgets#43', url: pr43, state: null },
      { sessionId: 'sess-two', sessionTitle: 'Second session', ref: 'acme/widgets#7', url: pr7, state: 'open' },
    ]);
    expect(prs.some((pr) => pr.sessionId === 'sess-other')).toBe(false);
    await expect.poll(async () => (await state(app)).notifications.openPrCount).toBe(3);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('prQuickOpen'))`))
      .toBe(true);
    // The IPC path returns the same list the menu is built from.
    const viaIpc = (await evaluateInShell(app, `window.devinworkspaces.listPrs()`)) as unknown[];
    expect(viaIpc).toHaveLength(3);

    // GitHub titles resolve via the pr-title fetch (menu truncation is
    // unit-tested — `title` itself is never truncated).
    await expect
      .poll(async () => (await h.listPrs()).find((pr) => pr.url === pr42)?.title)
      .toBe('Fix widget alignment');
    await expect
      .poll(async () => (await h.listPrs()).find((pr) => pr.url === pr43)?.title)
      .toBe(longTitle);

    // Opening a PR for another session switches the devin view to it (its
    // scope's tabs come along) and opens the PR as the active tab.
    await h.loadDevinUrl(`${fixtures.devinUrl}/sessions/sess-pr`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('sess-pr');
    await h.openSessionPr('sess-two', pr7);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('sess-two');
    expect((await state(app)).surface).toBe('cloud');
    await expect.poll(async () => (await state(app)).tabs.scope).toBe('sess-two');
    await expect.poll(async () => {
      const tabs = (await state(app)).tabs;
      const tab = tabs.tabs.find((t) => t.url === pr7);
      return tab && tabs.activeId === tab.id;
    }).toBe(true);
    const prOpen = (await readEvents(logFile)).filter((e) => e.event === 'pr-open');
    expect(prOpen.at(-1)?.url).toBe(pr7);
    expect((prOpen.at(-1)?.detail as any).sessionId).toBe('sess-two');

    // PR panel: every PR is unread from first observation; the badge counts
    // unread, the panel lists the same rows.
    await expect.poll(async () => (await state(app)).notifications.unreadPrCount).toBe(3);
    // Opening one panel closes the other.
    await evaluateInShell(app, `window.devinworkspaces.notificationsPanel(true)`);
    await expect.poll(() => h.panelOpen()).toBe(true);
    await evaluateInShell(app, `window.devinworkspaces.prsPanel(true)`);
    await expect.poll(() => h.prsPanelOpen()).toBe(true);
    await expect.poll(() => h.panelOpen()).toBe(false);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('prsPanel'))`))
      .toBe(true);
    await expect
      .poll(
        async () =>
          evaluateInShell(
            app,
            `document.querySelectorAll('#prsPanel [data-pr-url][data-unread]').length`,
          ),
      )
      .toBe(3);

    // Per-row mark-read: pr42 loses data-unread, unread count drops, pr-read logged.
    await evaluateInShell(
      app,
      `document.querySelector('[data-pr-url="${pr42}"] input[type="checkbox"]').click()`,
    );
    await expect
      .poll(async () =>
        evaluateInShell(
          app,
          `document.querySelector('[data-pr-url="${pr42}"]')?.hasAttribute('data-unread')`,
        ),
      )
      .toBe(false);
    await expect.poll(async () => (await state(app)).notifications.unreadPrCount).toBe(2);
    await waitForEvent(logFile, 'pr-read');

    // Per-row dismiss: pr43 leaves the list but stays remembered in prs.json
    // (dismissedAt) so it never comes back while open.
    await evaluateInShell(
      app,
      `document.querySelector('[data-pr-url="${pr43}"] button[aria-label="Delete"]').click()`,
    );
    await expect.poll(async () => (await state(app)).notifications.openPrCount).toBe(2);
    await waitForEvent(logFile, 'pr-dismiss');
    await expect
      .poll(() => {
        if (!existsSync(join(profile, 'prs.json'))) return null;
        const stored = JSON.parse(readFileSync(join(profile, 'prs.json'), 'utf8')) as {
          url: string;
          dismissedAt: number | null;
        }[];
        return stored.find((record) => record.url === pr43)?.dismissedAt ?? null;
      })
      .not.toBeNull();
    await h.pollNow();
    await expect
      .poll(async () =>
        evaluateInShell(
          app,
          `Boolean(document.querySelector('[data-pr-url="${pr43}"]'))`,
        ),
      )
      .toBe(false);

    // Mark all read: no badge, but the rail button stays while PRs remain.
    await evaluateInShell(app, `document.getElementById('prsMarkAllRead').click()`);
    await expect.poll(async () => (await state(app)).notifications.unreadPrCount).toBe(0);
    await expect
      .poll(async () =>
        evaluateInShell(
          app,
          `document.querySelector('#prQuickOpen span') === null`,
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('prQuickOpen'))`))
      .toBe(true);

    // Clear all dismisses everything: the rail button disappears.
    await evaluateInShell(app, `document.getElementById('prsClearAll').click()`);
    await expect.poll(async () => (await state(app)).notifications.openPrCount).toBe(0);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('prQuickOpen'))`))
      .toBe(false);

    // Once a dismissed PR leaves the open list its record is dropped.
    fixtures.api.setSessions([
      {
        session_id: 'sess-pr',
        title: 'PR session',
        status: 'running',
        status_detail: 'working',
        updated_at: 3,
        pull_requests: [
          { pr_url: pr42, pr_state: 'open' },
          { pr_url: pr43, pr_state: 'merged' },
        ],
      },
    ]);
    await h.pollNow();
    await expect
      .poll(async () => (await h.prRecords()).some((record) => record.url === pr43))
      .toBe(false);
    await evaluateInShell(app, `window.devinworkspaces.prsPanel(false)`);
    await expect.poll(() => h.prsPanelOpen()).toBe(false);

    // Ctrl+N: back to the tenant's create surface (root) on the Cloud surface.
    await evaluateInShell(app, `window.devinworkspaces.setSurface('settings')`);
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await h.newSession();
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
    await expect.poll(() => h.devinUrl()).toBe(`${fixtures.devinUrl}/`);
    await waitForEvent(logFile, 'new-session');
  } finally {
    await quit(app, profile);
  }
});

// The "resolution failed entirely" case: service-user token, CLI
// unauthenticated (exit 1), no sessions observed, no manual override.
test('shows nothing for a service-user token when no identity resolves', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, {
    DEVIN_WORKSPACES_TEST_AUTH_STATUS_CMD: 'node out/fixtures/fakeAuthStatus.cjs',
    FAKE_AUTH_STATUS_EXIT: '1',
  });
  const h = hooks(app);
  try {
    fixtures.api.setSelf('service_user');
    fixtures.api.setSessions([
      {
        session_id: 'sess-pr',
        title: 'PR session',
        status: 'running',
        status_detail: 'waiting_for_user',
        updated_at: 3,
        pull_requests: [{ pr_url: `${fixtures.githubUrl}/acme/widgets/pull/42`, pr_state: 'open' }],
      },
    ]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.noUserIdentity).toBe(true);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    expect((await state(app)).notifications.openPrCount).toBe(0);
    expect(await h.listPrs()).toEqual([]);
    // No sessions list request was ever made — only /v3/self.
    expect(fixtures.api.requests().every((r) => !r.path.includes('/sessions'))).toBe(true);
    expect(fixtures.api.requests().some((r) => r.path === '/v3/self')).toBe(true);
    // The service-user state is surfaced as a single 'identity' notification.
    expect((await state(app)).notifications.unreadCount).toBe(1);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('prQuickOpen'))`))
      .toBe(false);

    // The Settings surface explains the empty state.
    await evaluateInShell(app, `window.devinworkspaces.setSurface('settings')`);
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await evaluateInShell(app, `document.querySelector('[data-settings-tab="notifications"]').click()`);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('patNoUser'))`))
      .toBe(true);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('prunes persisted notifications from other users on identity resolution', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const seed = (id: string, sessionId: string, ownerUserId?: string) => ({
    id,
    kind: 'waiting',
    sessionId,
    sessionTitle: sessionId,
    title: `title-${id}`,
    body: 'body',
    createdAt: 1,
    readAt: null,
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
  });
  writeFileSync(
    join(profile, 'notifications.json'),
    JSON.stringify([
      seed('n-legacy', 'sess-legacy'),
      seed('n-foreign', 'sess-other', 'user-other'),
      seed('n-own', 'sess-own', 'user-fixture'),
    ]),
  );
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    const list = (await h.notifications()) as { sessionId: string | null }[];
    expect(list.map((entry) => entry.sessionId)).toEqual(['sess-own']);
    expect((await state(app)).notifications.unreadCount).toBe(1);
    const pruned = (await readEvents(logFile)).filter((e) => e.event === 'notifications-pruned');
    expect(pruned).toHaveLength(1);
    expect((pruned[0]!.detail as { removed: number; hasOwner: boolean }).removed).toBe(2);
    expect((pruned[0]!.detail as { removed: number; hasOwner: boolean }).hasOwner).toBe(true);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('service-user token prunes leftovers and surfaces an identity notification', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(
    join(profile, 'notifications.json'),
    JSON.stringify([
      {
        id: 'n-legacy',
        kind: 'waiting',
        sessionId: 'sess-legacy',
        sessionTitle: 'sess-legacy',
        title: 'title-n-legacy',
        body: 'body',
        createdAt: 1,
        readAt: null,
      },
    ]),
  );
  const app = await launch(profile, logFile, {
    DEVIN_WORKSPACES_TEST_AUTH_STATUS_CMD: 'node out/fixtures/fakeAuthStatus.cjs',
    FAKE_AUTH_STATUS_EXIT: '1',
  });
  const h = hooks(app);
  try {
    fixtures.api.setSelf('service_user');
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.noUserIdentity).toBe(true);
    await expect.poll(async () => ((await h.notifications()) as { kind: string }[]).length).toBe(1);
    const list = (await h.notifications()) as {
      kind: string;
      sessionId: string | null;
      ownerUserId?: string | null;
    }[];
    expect(list[0]!.kind).toBe('identity');
    expect(list[0]!.sessionId).toBeNull();
    expect(list[0]!.ownerUserId).toBeNull();
    // Identity entries are runtime-only — never persisted to notifications.json.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stored = JSON.parse(readFileSync(join(profile, 'notifications.json'), 'utf8')) as unknown[];
    expect(stored).toHaveLength(0);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('auto-opens a lazy background tab in the session scope when a session gains a PR (F1)', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const events = async (name: string) => (await readEvents(logFile)).filter((e) => e.event === name);
  // pollNow() is a no-op while a scheduled poll is in flight, so wait until one
  // more successful `poll` event has been logged (whichever poll produced it).
  const pollOnce = async () => {
    const before = (await events('poll')).length;
    await h.pollNow();
    await expect.poll(async () => (await events('poll')).length).toBeGreaterThan(before);
  };
  const existingPr = `${fixtures.githubUrl}/acme/widgets/pull/1`;
  const newPr = `${fixtures.githubUrl}/acme/widgets/pull/2`;
  const laterPr = `${fixtures.githubUrl}/acme/widgets/pull/3`;
  const session = (prs: string[]) => ({
    session_id: 'sess-pr',
    title: 'PR session',
    status: 'running',
    status_detail: 'working',
    updated_at: 3,
    pull_requests: prs.map((pr_url) => ({ pr_url, pr_state: 'open' })),
  });
  try {
    // A GLOBAL-scope tab the user already has: the visible strip must not change.
    const globalTab = await openTab(app, `${fixtures.githubUrl}/page/global`);
    await waitForTabCount(app, 1);
    expect((await state(app)).tabs.activeId).toBe(globalTab);
    const webContentsBefore = await webContentsCount(app);

    // (1) First poll with a session that already has a PR: baseline, nothing opens.
    fixtures.api.setSessions([session([existingPr])]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    await pollOnce();
    expect(await events('pr-auto-open')).toHaveLength(0);
    expect((await events('tab-open')).filter((e) => (e.detail as any).lazy)).toHaveLength(0);
    let current = await state(app);
    expect(current.tabs.tabs.map((tab) => tab.id)).toEqual([globalTab]);
    expect(current.tabs.hiddenTabCount).toBe(0);

    // (2) The session gains a PR -> one lazy tab in its scope; visible strip untouched.
    fixtures.api.setSessions([session([existingPr, newPr])]);
    await pollOnce();
    await waitForEvent(logFile, 'pr-auto-open');
    const autoOpened = await events('pr-auto-open');
    expect(autoOpened).toHaveLength(1);
    expect(autoOpened[0]?.url).toBe(newPr);
    expect((autoOpened[0]?.detail as any).sessionId).toBe('sess-pr');
    const lazyOpens = (await events('tab-open')).filter((e) => (e.detail as any).lazy === true);
    expect(lazyOpens).toHaveLength(1);
    expect(lazyOpens[0]?.url).toBe(newPr);
    expect((lazyOpens[0]?.detail as any).originSessionId).toBe('sess-pr');
    expect((lazyOpens[0]?.detail as any).background).toBe(true);
    const prTabId = (lazyOpens[0]?.detail as any).id as string;
    current = await state(app);
    expect(current.tabs.activeId).toBe(globalTab);
    expect(current.tabs.tabs.map((tab) => tab.id)).toEqual([globalTab]);
    expect(current.tabs.hiddenTabCount).toBe(1);
    // Lazy placeholder: discarded, scoped to the session, and no webContents was created.
    expect(await h.tabInfo(prTabId)).toEqual({
      url: newPr,
      originSessionId: 'sess-pr',
      discarded: true,
      loading: false,
      hasView: false,
    });
    expect(await webContentsCount(app)).toBe(webContentsBefore);
    expect(await h.listScopes()).toContainEqual(
      expect.objectContaining({ scope: 'sess-pr', count: 1, liveCount: 0 }),
    );

    // Viewing the session shows the tab in its strip (activation loads it).
    await h.loadDevinUrl(`${fixtures.devinUrl}/sessions/sess-pr`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('sess-pr');
    await expect.poll(async () => (await state(app)).tabs.scope).toBe('sess-pr');
    await expect.poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.id)).toEqual([prTabId]);
    current = await state(app);
    expect(current.tabs.tabs[0]?.url).toBe(newPr);
    expect(current.tabs.tabs[0]?.originSessionId).toBe('sess-pr');
    expect(current.tabs.activeId).toBe(prTabId);
    await expect.poll(async () => (await h.tabInfo(prTabId))?.hasView).toBe(true);

    // Same PR list on the next poll -> no duplicate, no re-open.
    await pollOnce();
    expect(await events('pr-auto-open')).toHaveLength(1);
    expect((await state(app)).tabs.tabs).toHaveLength(1);

    // (3) User closes it; later polls (same PR still listed) do not reopen it.
    expect(await h.closeTab(prTabId)).toBe(true);
    await waitForTabCount(app, 0);
    await pollOnce();
    await pollOnce();
    expect(await events('pr-auto-open')).toHaveLength(1);
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect(await h.tabInfo(prTabId)).toBeNull();

    // (4) Toggle off via the settings IPC. The flag is read per poll — no
    // restart, polls keep running, and a new PR still opens nothing.
    await evaluateInShell(app, `window.devinworkspaces.setSettings({ prs: { autoOpenTabs: false } })`);
    await expect.poll(async () => (await state(app)).settings.prs).toEqual({ autoOpenTabs: false });
    fixtures.api.setSessions([session([existingPr, newPr, laterPr])]);
    await pollOnce();
    await pollOnce();
    expect(await events('pr-auto-open')).toHaveLength(1);
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect((await state(app)).tabs.hiddenTabCount).toBe(1); // only the GLOBAL tab
    expect(await h.listScopes()).not.toContainEqual(expect.objectContaining({ scope: 'sess-pr' }));

    // Toggle back on: the poller kept running, so laterPr is already in the
    // baseline — still nothing opens until a genuinely new PR arrives.
    await evaluateInShell(app, `window.devinworkspaces.setSettings({ prs: { autoOpenTabs: true } })`);
    await expect.poll(async () => (await state(app)).settings.prs).toEqual({ autoOpenTabs: true });
    await pollOnce();
    expect(await events('pr-auto-open')).toHaveLength(1);
    const fourthPr = `${fixtures.githubUrl}/acme/widgets/pull/4`;
    fixtures.api.setSessions([session([existingPr, newPr, laterPr, fourthPr])]);
    await pollOnce();
    await expect.poll(async () => (await events('pr-auto-open')).length).toBe(2);
    expect((await events('pr-auto-open'))[1]?.url).toBe(fourthPr);
    // The visible scope is sess-pr and had no tabs, so this one is the scope's
    // active tab: it must render (view created, not discarded) rather than show
    // an active-but-empty pane.
    const fourthOpen = (await events('tab-open')).find((e) => e.url === fourthPr);
    expect((fourthOpen?.detail as any).lazy).toBe(true);
    const fourthId = (fourthOpen?.detail as any).id as string;
    await expect.poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.url)).toEqual([fourthPr]);
    current = await state(app);
    expect(current.tabs.activeId).toBe(fourthId);
    expect(current.tabs.tabs[0]?.discarded ?? false).toBe(false);
    expect(current.tabs.hiddenTabCount).toBe(1); // the GLOBAL tab
    await expect.poll(async () => (await h.tabInfo(fourthId))?.hasView).toBe(true);
    expect((await h.tabInfo(fourthId))?.discarded).toBe(false);
    expect(await webContentsCount(app)).toBe(webContentsBefore + 1);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('notification panel: badge, banner, open/read/delete, update entry, restart persistence', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notifcenter-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const shell = async (expr: string) => evaluateInShell(app, expr);
  try {
    // Waiting notification via the poller.
    fixtures.api.setSessions([
      { session_id: 'sess-1', title: 'Fix login bug', status: 'running', status_detail: 'working', updated_at: 1 },
    ]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    fixtures.api.setSessions([
      { session_id: 'sess-1', title: 'Fix login bug', status: 'running', status_detail: 'waiting_for_user', updated_at: 2 },
    ]);
    await waitForEvent(logFile, 'notification-added');
    await expect
      .poll(async () => shell(`document.getElementById('notificationsBadge')?.textContent`))
      .toBe('1');

    // Banner appears in the title bar, then auto-hides (test-shortened).
    await expect
      .poll(async () => shell(`document.getElementById('notificationBanner')?.textContent`))
      .toContain('Fix login bug');
    await expect
      .poll(async () => shell(`Boolean(document.getElementById('notificationBanner'))`), { timeout: 6000 })
      .toBe(false);

    // Panel open: unread entry bold; the shell view is raised over hosted views.
    await evaluateInShell(app, `window.devinworkspaces.notificationsPanel(true)`);
    await expect.poll(async () => shell(`Boolean(document.getElementById('notificationsPanel'))`)).toBe(true);
    expect(await h.panelOpen()).toBe(true);
    const views = (await h.childViews()) as { url: string }[];
    expect(views.at(-1)?.url).toContain('app://shell/');
    await expect
      .poll(async () => shell(`document.querySelector('[data-notification-id]')?.hasAttribute('data-unread')`))
      .toBe(true);

    // Checkbox marks read without navigating; badge drops to hidden.
    await shell(
      `document.querySelector('[data-notification-id] input[aria-label="Mark as read"]').click()`,
    );
    await expect.poll(async () => (await state(app)).notifications.unreadCount).toBe(0);
    await expect
      .poll(async () => shell(`Boolean(document.getElementById('notificationsBadge'))`))
      .toBe(false);
    await expect.poll(async () => shell(`Boolean(document.getElementById('notificationsPanel'))`)).toBe(true); // still open

    // Push a blocked + update entries; body click opens the session notification.
    // The blocked entry supersedes the read waiting one for the same session.
    await h.pushNotification({ kind: 'blocked', sessionId: 'sess-1', sessionTitle: 'Fix login bug', title: 'Fix login bug', body: 'Blocked — needs your input' });
    await h.simulateUpdate('9.9.9');
    await expect.poll(async () => (await h.notifications()).then ? 0 : ((await h.notifications()) as any[]).length).toBe(2);
    const entries = (await h.notifications()) as { id: string; kind: string; title: string }[];
    expect(entries.find((e) => e.kind === 'update')?.title).toBe('Update v9.9.9 ready');
    const blocked = entries.find((e) => e.kind === 'blocked')!;
    // Click the blocked item body → devin navigates to the session, panel closes.
    await shell(`document.querySelector('[data-notification-id="${blocked.id}"] > button').click()`);
    await expect.poll(async () => (await state(app)).notifications.panelOpen).toBe(false);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('sess-1');
    await expect.poll(async () => (await h.tabInfo?.(blocked.id) ?? null)).toBeDefined();
    // hosted views get input again — shell back at index 0
    const viewsAfter = (await h.childViews()) as { url: string }[];
    expect(viewsAfter[0]?.url).toContain('app://shell/');

    // Update entry: clicking logs update-install (test mode, no quit).
    await evaluateInShell(app, `window.devinworkspaces.notificationsPanel(true)`);
    const upd = ((await h.notifications()) as { id: string; kind: string }[]).find((e) => e.kind === 'update')!;
    await evaluateInShell(app, `window.devinworkspaces.notificationsOpen('${upd.id}')`);
    await waitForEvent(logFile, 'update-install');
    await expect.poll(async () => ((await h.notifications()) as any[]).filter((e) => e.kind === 'update').length).toBe(0);

    // Mark all read / clear all via panel buttons. The waiting pushes use
    // distinct sessions so neither supersedes the blocked entry or each other.
    await h.pushNotification({ kind: 'waiting', sessionId: 'sess-2', sessionTitle: 's', title: 'w1', body: 'b' });
    await h.pushNotification({ kind: 'waiting', sessionId: 'sess-3', sessionTitle: 's', title: 'w2', body: 'b2' });
    await evaluateInShell(app, `window.devinworkspaces.notificationsPanel(true)`);
    await expect.poll(async () => shell(`document.querySelectorAll('[data-notification-id]').length`)).toBe(3);
    await shell(`document.getElementById('markAllRead').click()`);
    await expect.poll(async () => (await state(app)).notifications.unreadCount).toBe(0);
    // Trash one entry; clear-all empties the rest.
    const rest = (await h.notifications()) as { id: string }[];
    await shell(`document.querySelector('[data-notification-id="${rest[0]!.id}"] [aria-label="Delete"]').click()`);
    await expect.poll(async () => ((await h.notifications()) as any[]).length).toBe(2);
    await shell(`document.getElementById('clearAll').click()`);
    await expect.poll(async () => ((await h.notifications()) as any[]).length).toBe(0);
    await expect.poll(async () => shell(`document.getElementById('markAllRead').disabled`)).toBe(true);

    // Push two entries that must survive restart, plus one update entry that
    // must not (runtime-only kind). Wait past the 300 ms debounced save.
    await h.pushNotification({ kind: 'waiting', sessionId: 'sess-1', ownerUserId: 'user-fixture', sessionTitle: 's1', title: 'Persist me 1', body: 'b' });
    await h.pushNotification({ kind: 'blocked', sessionId: 'sess-2', ownerUserId: 'user-fixture', sessionTitle: 's1', title: 'Persist me 2', body: 'b' });
    await h.simulateUpdate('9.9.8');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close().catch(() => undefined);
    const app2 = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
      DEVIN_WORKSPACES_API_BASE: fixtures.apiUrl,
      DEVIN_WORKSPACES_POLL_MS: String(POLL_MS),
      DEVIN_WORKSPACES_TEST_BANNER_MS: '1500',
    });
    try {
      await expect.poll(async () => app2.evaluate(() => Boolean((globalThis as any).__devinworkspaces))).toBe(true);
      const restored = (await app2.evaluate(() => (globalThis as any).__devinworkspaces.notifications())) as { kind: string; title: string }[];
      expect(restored.map((e) => e.title)).toEqual(['Persist me 2', 'Persist me 1']);
      expect(restored.some((e) => e.kind === 'update')).toBe(false);
    } finally {
      await quit(app2, profile);
    }
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a pr-completed supersedes the pr-opened entry for the same PR', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-supersede-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const prUrl = `${fixtures.githubUrl}/acme/widgets/pull/42`;
  const sess = (prs: { pr_url: string; pr_state: string | null }[]) => ({
    session_id: 'sess-pr',
    title: 'PR session',
    status: 'running',
    status_detail: 'working',
    updated_at: 3,
    pull_requests: prs,
  });
  try {
    // Baseline: the session exists with no PRs.
    fixtures.api.setSessions([sess([])]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    await h.pollNow();

    // A new PR appears → pr-opened.
    fixtures.api.setSessions([sess([{ pr_url: prUrl, pr_state: 'open' }])]);
    await h.pollNow();
    await expect
      .poll(async () =>
        ((await h.notifications()) as { kind: string; prUrl?: string }[]).filter(
          (e) => e.prUrl === prUrl,
        ).length,
      )
      .toBe(1);
    let entries = (await h.notifications()) as { kind: string; prUrl?: string }[];
    expect(entries.find((e) => e.prUrl === prUrl)?.kind).toBe('pr-opened');

    // The same PR merges → pr-completed replaces the pr-opened entry.
    fixtures.api.setSessions([sess([{ pr_url: prUrl, pr_state: 'merged' }])]);
    await h.pollNow();
    await expect.poll(async () => {
      entries = (await h.notifications()) as { kind: string; prUrl?: string }[];
      return entries.filter((e) => e.prUrl === prUrl).map((e) => e.kind).join(',');
    }).toBe('pr-completed');
    const forPr = ((await h.notifications()) as { kind: string; prUrl?: string; readAt: number | null }[]).filter(
      (e) => e.prUrl === prUrl,
    );
    expect(forPr).toHaveLength(1);
    expect(forPr[0]).toMatchObject({ kind: 'pr-completed', readAt: null });
    const superseded = (await readEvents(logFile)).filter((e) => e.event === 'notification-superseded');
    expect(superseded.length).toBeGreaterThanOrEqual(1);
    expect((superseded.at(-1)?.detail as { kind: string; count: number }).count).toBe(1);
    expect((superseded.at(-1)?.detail as { kind: string; count: number }).kind).toBe('pr-completed');
  } finally {
    await quit(app, profile);
  }
});

test('settings shows the app version and an Update now button', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-update-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const shell = async (expr: string) => evaluateInShell(app, expr);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  try {
    expect((await state(app)).update).toEqual({
      version: pkg.version,
      available: null,
      downloaded: null,
      releasesUrl: 'https://github.com/brianwentz/devin-workspace/releases',
      enabled: true,
      checking: false,
      lastCheckedAt: null,
      error: null,
    });

    // Switch to the settings surface; the About block renders the version.
    await app.evaluate(() => (globalThis as any).__devinworkspaces.setSurface('settings'));
    await shell(`document.querySelector('[data-settings-tab="updates"]').click()`);
    await expect
      .poll(async () => shell(`document.getElementById('appVersion')?.textContent`))
      .toBe(pkg.version);
    await expect
      .poll(async () => shell(`document.getElementById('updateStatus')?.getAttribute('data-update-state')`))
      .toBe('none');

    // Opening the tab fires a 'settings' check; lastCheckedAt becomes a timestamp.
    await waitForEvent(logFile, 'update-check');
    await expect.poll(async () => (await state(app)).update.lastCheckedAt).not.toBeNull();
    expect(typeof (await state(app)).update.lastCheckedAt).toBe('string');
    await expect
      .poll(async () =>
        shell(`(document.getElementById('updateLastChecked')?.textContent ?? '').startsWith('Last checked')`),
      )
      .toBe(true);

    // "Check now" sends a 'manual' check (never throttled).
    await shell(`document.getElementById('updateCheckNow').click()`);
    await expect
      .poll(
        async () =>
          (await readEvents(logFile)).filter(
            (entry) =>
              entry.event === 'update-check' &&
              (entry.detail as { source?: string })?.source === 'manual',
          ).length,
      )
      .toBe(1);

    // Focus and resume within their throttle windows are skipped. The
    // simulated manual check settles on a 0-timeout — wait for it or the
    // focus check lands in the in-flight gate instead of the throttle.
    await expect.poll(async () => (await state(app)).update.checking).toBe(false);
    await h.simulateUpdateFocus();
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some(
          (entry) =>
            entry.event === 'update-check-skipped' &&
            (entry.detail as { source?: string; reason?: string })?.source === 'focus' &&
            (entry.detail as { reason?: string })?.reason === 'throttled',
        ),
      )
      .toBe(true);
    await h.simulateUpdateResume();
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some(
          (entry) =>
            entry.event === 'update-check-skipped' &&
            (entry.detail as { source?: string; reason?: string })?.source === 'resume' &&
            (entry.detail as { reason?: string })?.reason === 'throttled',
        ),
      )
      .toBe(true);

    // Update available: downloading state, no Update now button yet.
    await h.simulateUpdateAvailable('9.9.9');
    await expect.poll(async () => (await state(app)).update.available).toBe('9.9.9');
    expect((await state(app)).update.downloaded).toBeNull();
    await expect
      .poll(async () => shell(`Boolean(document.querySelector('#updateStatus[data-update-state="downloading"]'))`))
      .toBe(true);
    expect(await shell(`Boolean(document.getElementById('updateNow'))`)).toBe(false);

    // Downloaded: ready state with the Update now button.
    await h.simulateUpdate('9.9.9');
    await expect.poll(async () => (await state(app)).update.downloaded).toBe('9.9.9');
    await expect
      .poll(async () => shell(`Boolean(document.querySelector('#updateStatus[data-update-state="ready"]'))`))
      .toBe(true);
    await expect.poll(async () => shell(`Boolean(document.getElementById('updateNow'))`)).toBe(true);
    // Check-now row is hidden once an update is downloaded.
    expect(await shell(`Boolean(document.getElementById('updateCheckNow'))`)).toBe(false);

    // Click installs (test mode: logs update-install, removes the update entry).
    await shell(`document.getElementById('updateNow').click()`);
    await waitForEvent(logFile, 'update-install');
    await expect
      .poll(async () => ((await h.notifications()) as { kind: string }[]).filter((e) => e.kind === 'update').length)
      .toBe(0);
  } catch (error) {
    console.log(
      `[update-debug]\n${(await readEvents(logFile))
        .filter((e) => (e.event as string).includes('update'))
        .map((e) => JSON.stringify(e))
        .join('\n')}`,
    );
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('focus and resume trigger an update check when none has run yet', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-upcheck-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  try {
    // First resume check runs (test mode simulates the check — no network).
    await h.simulateUpdateResume();
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some(
          (entry) =>
            entry.event === 'update-check' &&
            (entry.detail as { source?: string })?.source === 'resume',
        ),
      )
      .toBe(true);
    // Wait for the simulated check to settle so focus hits the throttle, not in-flight.
    await expect.poll(async () => (await state(app)).update.checking).toBe(false);
    // Focus inside the 1 h throttle window is skipped.
    await h.simulateUpdateFocus();
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some(
          (entry) =>
            entry.event === 'update-check-skipped' &&
            (entry.detail as { source?: string; reason?: string })?.source === 'focus' &&
            (entry.detail as { reason?: string })?.reason === 'throttled',
        ),
      )
      .toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('service-user token resolves the user from the Devin CLI sign-in', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-identity-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, {
    DEVIN_WORKSPACES_TEST_AUTH_STATUS_CMD: 'node out/fixtures/fakeAuthStatus.cjs',
  });
  const h = hooks(app);
  try {
    fixtures.api.setSelf('service_user');
    fixtures.api.setSessions([
      {
        session_id: 'sess-mine',
        title: 'Mine',
        status: 'running',
        status_detail: 'working',
        updated_at: 3,
        user_id: 'user-fixture',
        pull_requests: [{ pr_url: `${fixtures.githubUrl}/acme/widgets/pull/42`, pr_state: 'open' }],
      },
      { session_id: 'sess-other', title: 'Not mine', status: 'running', updated_at: 5, user_id: 'user-other' },
    ]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.identity.source).toBe('cli');
    expect((await state(app)).notifications.noUserIdentity).toBe(false);
    expect(await h.identity()).toMatchObject({
      source: 'cli',
      maskedUserId: 'user-…xture',
      cliOrgMismatch: false,
    });

    // Only the CLI user's session is listed; the request carried the filter.
    const prs = await h.listPrs();
    expect(prs.map((pr) => pr.sessionId)).toEqual(['sess-mine']);
    await expect.poll(async () => (await state(app)).notifications.openPrCount).toBe(1);
    expect(
      fixtures.api.requests().some((r) => r.path.includes('user_ids=user-fixture')),
    ).toBe(true);

    // Settings shows the resolved (masked) identity.
    await evaluateInShell(app, `window.devinworkspaces.setSurface('settings')`);
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await evaluateInShell(app, `document.querySelector('[data-settings-tab="notifications"]').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `document.getElementById('identityStatus')?.getAttribute('data-identity-source')`),
      )
      .toBe('cli');
    const statusText = (await evaluateInShell(
      app,
      `document.getElementById('identityStatus')?.textContent`,
    )) as string;
    expect(statusText).toContain('user-…xture');
    expect(statusText).toContain('CLI');

    // The log records the resolution but never the raw user id or the token.
    const resolves = (await readEvents(logFile)).filter((e) => e.event === 'identity-resolve');
    expect(
      resolves.some(
        (e) => (e.detail as any).source === 'cli' && (e.detail as any).ok === true,
      ),
    ).toBe(true);
    const logText = readFileSync(logFile, 'utf8');
    expect(logText).not.toContain('user-fixture');
    expect(logText).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('service-user token infers the user from an observed session', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-identity-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, {
    DEVIN_WORKSPACES_TEST_AUTH_STATUS_CMD: 'node out/fixtures/fakeAuthStatus.cjs',
    FAKE_AUTH_STATUS_EXIT: '1',
  });
  const h = hooks(app);
  try {
    fixtures.api.setSelf('service_user');
    fixtures.api.setSessions([
      {
        session_id: 'sess-mine',
        title: 'Mine',
        status: 'running',
        status_detail: 'working',
        updated_at: 3,
        created_at: new Date().toISOString(),
        user_id: 'user-fixture',
      },
    ]);
    // Navigate before the token exists: the session the devin view is already
    // on when the first poll runs must still be observed (pendingSessionId).
    await h.loadDevinUrl(`${fixtures.devinUrl}/sessions/sess-mine`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('sess-mine');
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.identity.source).toBe('inferred');
    expect((await state(app)).notifications.noUserIdentity).toBe(false);
    expect((await h.identity()).maskedUserId).toBe('user-…xture');
    const observed = (await readEvents(logFile)).filter((e) => e.event === 'identity-observe');
    expect(observed.some((e) => (e.detail as any).accepted === true)).toBe(true);
    expect(
      fixtures.api.requests().some((r) => r.path.includes('user_ids=user-fixture')),
    ).toBe(true);

    // Reset clears the persisted identity and re-runs resolution — the devin
    // view is still on sess-mine, so the restart re-observes it and infers
    // the same user again.
    await h.identityReset();
    await waitForEvent(logFile, 'identity-reset');
    await expect.poll(async () => (await h.identity()).source).toBe('inferred');
    const observedAfter = (await readEvents(logFile)).filter((e) => e.event === 'identity-observe');
    expect(
      observedAfter.filter((e) => (e.detail as any).accepted === true).length,
    ).toBeGreaterThanOrEqual(2);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('an unconfirmed CLI identity is rejected and the manual override wins', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-identity-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, {
    DEVIN_WORKSPACES_TEST_AUTH_STATUS_CMD: 'node out/fixtures/fakeAuthStatus.cjs',
    FAKE_AUTH_STATUS_USER_ID: 'user-ghost',
  });
  const h = hooks(app);
  try {
    fixtures.api.setSelf('service_user');
    // The list ignores user_ids here, so the confirmation sees a non-empty
    // page with no session owned by user-ghost -> rejected.
    fixtures.api.setIgnoreUserIds(true);
    fixtures.api.setSessions([
      { session_id: 'sess-fixture', title: 'Mine', status: 'running', updated_at: 3, user_id: 'user-fixture' },
    ]);
    await h.setPat(PAT);
    await waitForEvent(logFile, 'identity-rejected');
    const rejected = (await readEvents(logFile)).filter((e) => e.event === 'identity-rejected');
    expect((rejected[0]?.detail as any).source).toBe('cli');
    await expect.poll(async () => (await state(app)).notifications.noUserIdentity).toBe(true);
    expect((await h.identity()).source).toBeNull();

    // The manual override resolves and confirms against the same page.
    await evaluateInShell(
      app,
      `window.devinworkspaces.setSettings({ notifications: { userId: 'user-fixture' } })`,
    );
    await expect.poll(async () => (await state(app)).notifications.identity.source).toBe('manual');
    expect((await state(app)).notifications.noUserIdentity).toBe(false);
    expect(
      fixtures.api.requests().some((r) => r.path.includes('user_ids=user-fixture')),
    ).toBe(true);
    expect((await h.identity()).maskedUserId).toBe('user-…xture');
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('a rejected token raises an auth notification and a rail warning; focus re-polls', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const pollErrors = async () => (await readEvents(logFile)).filter((e) => e.event === 'poll-error');
  try {
    fixtures.api.setSessions([
      { session_id: 'sess-1', status: 'running', status_detail: 'working', updated_at: 1 },
    ]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    expect((await state(app)).notifications.authError).toBe(false);

    fixtures.api.setMode({ kind: 'status', status: 403 });
    await expect.poll(async () => (await state(app)).notifications.authError).toBe(true);
    expect((await state(app)).notifications.lastError).toBe('forbidden');

    // Exactly one 'auth' entry, even across repeated poll errors.
    await expect.poll(async () => (await pollErrors()).length).toBeGreaterThanOrEqual(2);
    const entries = (await h.notifications()) as {
      kind: string;
      sessionId: string | null;
      title: string;
      body: string;
    }[];
    const authEntries = entries.filter((e) => e.kind === 'auth');
    expect(authEntries).toHaveLength(1);
    expect(authEntries[0]?.sessionId).toBeNull();
    expect(authEntries[0]?.title).toBe('Devin API token rejected');
    expect(authEntries[0]?.body).not.toContain(PAT);

    // The rail bell shows the amber warning dot.
    await expect
      .poll(async () => evaluateInShell(app, `document.getElementById('pollerWarning')?.getAttribute('title')`))
      .toBe('Devin API token rejected — open Settings');

    // Restarting (same token) clears the cached org id, so the next poll fails
    // inside /v3/self — every poll-error since is tagged op 'self'.
    await h.setPat(PAT);
    const before = (await pollErrors()).length;
    await expect.poll(async () => (await pollErrors()).length).toBeGreaterThan(before);
    const since = (await pollErrors()).slice(before);
    expect(since.length).toBeGreaterThan(0);
    expect(since.every((e) => (e.detail as any).op === 'self')).toBe(true);

    // Recovery via the focus re-poll: ok mode + a focus event drops the
    // backoff and clears authError + the rail warning.
    fixtures.api.setMode({ kind: 'ok' });
    await app.evaluate(({ BaseWindow }) => {
      for (const win of BaseWindow.getAllWindows()) win.emit('focus');
    });
    await waitForEvent(logFile, 'notifier-focus-poll');
    await expect.poll(async () => (await state(app)).notifications.authError).toBe(false);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('pollerWarning'))`))
      .toBe(false);
    expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
  } finally {
    await quit(app, profile);
  }
});

test('catches up PRs that appeared while the poller was down, across a restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-notify-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const h = hooks(app);
  const events = async (name: string) => (await readEvents(logFile)).filter((e) => e.event === name);
  const prA = `${fixtures.githubUrl}/acme/widgets/pull/11`;
  const prB = `${fixtures.githubUrl}/acme/widgets/pull/12`;
  const session = (prs: string[]) => ({
    session_id: 'sess-1',
    title: 'PR session',
    status: 'running',
    status_detail: 'working',
    updated_at: 3,
    pull_requests: prs.map((pr_url) => ({ pr_url, pr_state: 'open' })),
  });
  try {
    fixtures.api.setSessions([session([prA])]);
    await h.setPat(PAT);
    await expect.poll(async () => (await state(app)).notifications.lastPollAt).not.toBeNull();
    // Baseline poll with an empty ledger: nothing opens for A. One more
    // successful poll makes sure A is recorded in the ledger.
    await expect.poll(async () => (await events('poll')).length).toBeGreaterThanOrEqual(2);
    expect(await events('pr-auto-open')).toHaveLength(0);
    expect(existsSync(join(profile, 'pr-ledger.json'))).toBe(true);

    // The API goes down; B appears on the session while unreachable.
    fixtures.api.setMode({ kind: 'status', status: 403 });
    fixtures.api.setSessions([session([prA, prB])]);
    await expect.poll(async () => (await pollErrorsCount())).toBeGreaterThanOrEqual(1);
    async function pollErrorsCount() {
      return (await events('poll-error')).length;
    }

    // Quit and relaunch with the same profile (ledger persisted). The first
    // poll after restart is a baseline again — B opens as a catch-up, A does
    // not.
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    fixtures.api.setMode({ kind: 'ok' });
    const app2 = await launch(profile, logFile);
    try {
      await waitForEvent(logFile, 'pr-catch-up');
      const opens = await events('pr-auto-open');
      const forB = opens.filter((e) => e.url === prB);
      expect(forB).toHaveLength(1);
      expect((forB[0]?.detail as any).catchUp).toBe(true);
      expect((forB[0]?.detail as any).sessionId).toBe('sess-1');
      expect(opens.filter((e) => e.url === prA)).toHaveLength(0);
      const catchUps = await events('pr-catch-up');
      expect(catchUps).toHaveLength(1);
      expect((catchUps[0]?.detail as any).count).toBe(1);
      expect(existsSync(join(profile, 'pr-ledger.json'))).toBe(true);
      expect(readFileSync(logFile, 'utf8')).not.toContain(PAT);
    } finally {
      await app2.close().catch(() => undefined);
    }
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
