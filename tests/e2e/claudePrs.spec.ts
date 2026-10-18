import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  CLAUDE_FIXTURE_HOME,
  evaluateInShell,
  launchApp,
  launchWithClaudeFixture,
  shellPage,
} from './helpers';
import type { ClaudeState } from '../../src/shared/ipc';
import type { SessionPr } from '../../src/shared/ipc';

// §3: Claude PR tracking — one funnel records every detected PR URL on the
// registry entry, the PR panel merges Claude rows in, and the title/state
// cache drives pr-completed notifications. Works with no Devin token.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const UA = '11111111-0000-4000-8000-00000000000a';

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    claudeState: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeState()) as Promise<ClaudeState>,
    state: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.state()) as Promise<any>,
    listPrs: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.listPrs()) as Promise<SessionPr[]>,
    prsOpen: (sessionId: string, url: string) =>
      app.evaluate(
        (_e, a: { sessionId: string; url: string }) =>
          (globalThis as any).__devinworkspaces.prsOpen(a.sessionId, a.url),
        { sessionId, url },
      ) as Promise<void>,
    claudeRecordPr: (sessionId: string, url: string) =>
      app.evaluate(
        (_e, a: { sessionId: string; url: string }) =>
          (globalThis as any).__devinworkspaces.claudeRecordPr(a.sessionId, a.url),
        { sessionId, url },
      ) as Promise<void>,
    claudePrs: (sessionId: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.claudePrs(v),
        sessionId,
      ) as Promise<{ url: string; state: string | null }[]>,
    claudeRefreshPrStates: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeRefreshPrStates()) as Promise<void>,
    prTitlesSeed: (url: string, info: { title: string | null; state: string | null }) =>
      app.evaluate(
        (_e, a: { url: string; info: { title: string | null; state: string | null } }) =>
          (globalThis as any).__devinworkspaces.prTitlesSeed(a.url, a.info),
        { url, info },
      ) as Promise<void>,
    notifications: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.notifications()) as Promise<any[]>,
    setSurface: (s: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.setSurface(v),
        s,
      ) as Promise<void>,
    claudeSelect: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.claudeSelect(v),
        id,
      ) as Promise<void>,
    claudeNewSession: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeNewSession()) as Promise<string>,
    claudePrompt: (id: string, text: string) =>
      app.evaluate(
        (_e, a: { id: string; text: string }) =>
          (globalThis as any).__devinworkspaces.claudePrompt(a.id, a.text),
        { id, text },
      ) as Promise<void>,
  };
}

const LAUNCH_ENV = {
  DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
  DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
};

test('recordPr lands in the PR panel + sidebar badge', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, LAUNCH_ENV);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/42`;
    await h.claudeRecordPr(UA, url);
    await expect
      .poll(async () => (await h.listPrs()).filter((p) => p.source === 'claude').length)
      .toBe(1);
    const pr = (await h.listPrs()).find((p) => p.url === url);
    expect(pr?.sessionId).toBe(UA);
    expect(pr?.sessionTitle).toBe('Alpha custom');
    expect(pr?.readAt).toBe(null);
    await expect
      .poll(async () => (await h.state()).notifications.unreadPrCount)
      .toBe(1);
    // Sidebar badge counts open (unknown state counts as open).
    const row = (await h.claudeState()).sessions.find((s) => s.id === UA);
    expect(row?.prs.open).toBe(1);
    // Panel row carries source + session title.
    const shell = await shellPage(app);
    await evaluateInShell(app, 'window.devinworkspaces.prsPanel(true)');
    await expect(
      shell.locator(`[data-pr-url="${url}"][data-source="claude"]`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      shell.locator(`[data-pr-url="${url}"][data-source="claude"]`),
    ).toContainText('Alpha custom');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('opening a Claude PR row selects the session on the claude surface + hidden tab', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, LAUNCH_ENV);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/43`;
    await h.claudeRecordPr(UA, url);
    await expect
      .poll(async () => (await h.listPrs()).filter((p) => p.source === 'claude').length)
      .toBe(1);
    await h.prsOpen(UA, url);
    await expect.poll(async () => (await h.state()).surface).toBe('claude');
    await expect.poll(async () => (await h.state()).claudeSessionId).toBe(UA);
    // The PR opens as the active tab of the session's claude:<id> scope.
    await expect
      .poll(async () =>
        ((await h.state()).tabs.tabs as { url: string }[]).some((t) => t.url === url),
      )
      .toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('merged state drops the row, badges merged, one pr-completed notification', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, LAUNCH_ENV);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/44`;
    await h.claudeRecordPr(UA, url);
    await expect
      .poll(async () => (await h.listPrs()).filter((p) => p.source === 'claude').length)
      .toBe(1);
    // Seed 'merged' — the cache-change subscription flips the registry state.
    await h.prTitlesSeed(url, { title: 'T', state: 'merged' });
    await h.claudeRefreshPrStates();
    await expect
      .poll(async () => (await h.claudePrs(UA)).find((p) => p.url === url)?.state)
      .toBe('merged');
    await expect
      .poll(async () => (await h.listPrs()).filter((p) => p.url === url).length)
      .toBe(0);
    const row = (await h.claudeState()).sessions.find((s) => s.id === UA);
    expect(row?.prs.merged).toBe(1);
    expect(row?.prs.open).toBe(0);
    await expect
      .poll(
        async () =>
          (await h.notifications()).filter(
            (n) => n.kind === 'pr-completed' && n.source === 'claude',
          ).length,
      )
      .toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('merged state persists across relaunch with no second notification', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures, LAUNCH_ENV);
  const h = hooks(app);
  const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/45`;
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.claudeRecordPr(UA, url);
    await h.prTitlesSeed(url, { title: 'T', state: 'merged' });
    await expect
      .poll(async () => (await h.claudePrs(UA)).find((p) => p.url === url)?.state)
      .toBe('merged');
    await expect
      .poll(
        async () =>
          (await h.notifications()).filter(
            (n) => n.kind === 'pr-completed' && n.source === 'claude',
          ).length,
      )
      .toBe(1);
    // Registry save is debounced (200 ms) — poll the file, not a fixed read.
    await expect
      .poll(() => {
        const persisted = JSON.parse(
          readFileSync(join(profile, 'claude-sessions.json'), 'utf8'),
        ) as any;
        return persisted.entries[UA].prs.find((p: any) => p.url === url)?.state;
      })
      .toBe('merged');
  } finally {
    await app.close().catch(() => undefined);
  }

  const app2 = await launchApp(
    profile,
    join(profile, 'events2.jsonl'),
    join(profile, 'downloads'),
    fixtures,
    { CLAUDE_CONFIG_DIR: claudeHome, ...LAUNCH_ENV },
  );
  const h2 = hooks(app2);
  try {
    await expect.poll(async () => (await h2.claudeState()).status).toBe('ready');
    await h2.prTitlesSeed(url, { title: 'T', state: 'merged' });
    await h2.claudeRefreshPrStates();
    // completedAt was already stamped — no second notification after relaunch.
    await h2.claudeRefreshPrStates();
    await new Promise((r) => setTimeout(r, 400));
    expect(
      (await h2.notifications()).filter(
        (n) => n.kind === 'pr-completed' && n.source === 'claude',
      ).length,
    ).toBe(1);
    // A merged PR stays out of the open list.
    expect((await h2.listPrs()).filter((p) => p.url === url).length).toBe(0);
  } finally {
    await app2.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('chat echo with a PR link records + auto-opens the tab', async () => {
  const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/46`;
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    ...LAUNCH_ENV,
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
    FAKE_CLAUDE_PR_URL: url,
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const id = await h.claudeNewSession();
    await h.claudePrompt(id, 'open a pr');
    await expect
      .poll(async () => (await h.claudePrs(id)).find((p) => p.url === url)?.url)
      .toBe(url);
    await expect
      .poll(async () => (await h.state()).tabs.hiddenTabCount)
      .toBe(1);
    const events = readFileSync(join(profile, 'events.jsonl'), 'utf8');
    expect(events).toContain('"event":"pr-auto-open"');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('legacy prUrls registry migrates to prs entries on load', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/47`;
  writeFileSync(
    join(profile, 'claude-sessions.json'),
    JSON.stringify({
      version: 1,
      folders: [],
      entries: {
        [UA]: {
          id: UA,
          folder: null,
          pinned: false,
          archived: false,
          archivedAt: null,
          unarchivedAt: null,
          removed: false,
          removedAt: null,
          lastOpenedAt: null,
          prUrls: [url],
        },
      },
    }),
  );
  const app = await launchApp(
    profile,
    join(profile, 'events.jsonl'),
    join(profile, 'downloads'),
    fixtures,
    { CLAUDE_CONFIG_DIR: claudeHome, ...LAUNCH_ENV },
  );
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect
      .poll(async () => (await h.claudePrs(UA)).find((p) => p.url === url)?.url)
      .toBe(url);
    // Unknown state counts as open — it shows in the panel.
    await expect
      .poll(async () => (await h.listPrs()).filter((p) => p.url === url).length)
      .toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

// Phase 6 #5: when the page fetch yields no state and `gh` is on PATH (the
// test override stands in), `gh pr view` fills title + state.
test('gh fallback fills state when the page fetch cannot', async () => {
  const FAKE_GH = resolve(__dirname, '../../out/fixtures/fakeGh.cjs');
  const url = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/48`;
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    ...LAUNCH_ENV,
    DEVIN_WORKSPACES_TEST_GH_CMD: `node ${FAKE_GH}`,
    FAKE_GH_JSON: JSON.stringify({ state: 'MERGED', isDraft: false, title: 'Via gh' }),
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.claudeRecordPr(UA, url);
    await h.claudeRefreshPrStates();
    await expect
      .poll(async () => (await h.claudePrs(UA)).find((p) => p.url === url)?.state)
      .toBe('merged');
    await expect
      .poll(
        async () =>
          (await h.notifications()).filter(
            (n) => n.kind === 'pr-completed' && n.source === 'claude',
          ).length,
      )
      .toBe(1);
    const events = readFileSync(join(profile, 'events.jsonl'), 'utf8');
    expect(events).toContain('"via":"gh"');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
