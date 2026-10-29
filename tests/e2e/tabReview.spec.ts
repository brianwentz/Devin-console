// Tab Review end to end: the tab menu, the review pty (fake pty echoes argv),
// verdict detection (Stop payload, transcript + retries, pty-exit backstop),
// notifications and their link-back, side-effect suppression, the strip and a
// WSL review host. Transcripts are written in the real jsonl shape the SDK
// reads (same encoding as tests/fixtures/fakeClaudeSdk.ts).
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { buildReviewPrompt } from '../../src/core/tabReview';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  CLAUDE_FIXTURE_HOME,
  closeApp,
  evaluateInShell,
  launchApp,
  openTab,
  readEvents,
  shellPage,
  state,
  type PublicState,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const FAKE_PTY = `node ${resolve(__dirname, '../../out/fixtures/fakePty.cjs')}`;
// A fixture Claude session (tests/fixtures/claude-home) used as an origin scope.
const UA = '11111111-0000-4000-8000-00000000000a';
const LOCAL_SESSION = 'local-review-origin-1';

type ReviewRecord = {
  tabId: string;
  sessionId: string;
  hostId: string;
  ptyId: string | null;
  prUrl: string;
  originScope: string;
  status: string;
  terminalOpen: boolean;
};
type Entry = {
  id: string;
  kind: string;
  title: string;
  body: string;
  prUrl?: string | null;
  scope?: string;
  reviewVerdict?: string;
};
type Terminal = { id: string; kind: string; sessionId: string | null; exitCode: number | null };
type MenuItem = { id: string; label: string; enabled: boolean };

interface Launched {
  app: ElectronApplication;
  profile: string;
  claudeHome: string;
  logFile: string;
  reviewsHome: string;
}

async function launchReviewApp(extra: Record<string, string> = {}): Promise<Launched> {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-review-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const reviewsHome = join(profile, 'reviews-home');
  mkdirSync(reviewsHome, { recursive: true });
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: FAKE_PTY,
    AGENT_WORKSPACE_TEST_REVIEWS_HOME: reviewsHome,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    ...extra,
  });
  return { app, profile, claudeHome, logFile, reviewsHome };
}

function call<T>(app: ElectronApplication, fn: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    (_e, p: { fn: string; args: unknown[] }) => (globalThis as any).__agentworkspace[p.fn](...p.args),
    { fn, args },
  ) as Promise<T>;
}

const reviewState = (app: ElectronApplication, tabId: string) =>
  call<ReviewRecord | null>(app, 'reviewState', tabId);
const reviewStatus = async (app: ElectronApplication, tabId: string) =>
  (await reviewState(app, tabId))?.status ?? null;
const notifications = (app: ElectronApplication) => call<Entry[]>(app, 'notifications');
const reviewEntries = async (app: ElectronApplication, prUrl: string) =>
  (await notifications(app)).filter((n) => n.kind === 'review' && n.prUrl === prUrl);
const terminals = (app: ElectronApplication) => call<Terminal[]>(app, 'terminalList');
const postHook = (app: ElectronApplication, event: string, body: unknown) =>
  call<{ ok: boolean; status: number }>(app, 'claudePostHook', event, body);
const shell = (app: ElectronApplication, script: string) => evaluateInShell(app, script);

function readSettings(profile: string): any {
  return JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
}

async function setSettings(app: ElectronApplication, patch: unknown): Promise<void> {
  await shell(app, `window.agentworkspace.setSettings(${JSON.stringify(patch)})`);
}

async function setSurface(app: ElectronApplication, surface: string): Promise<void> {
  await shell(app, `window.agentworkspace.setSurface(${JSON.stringify(surface)})`);
  await expect.poll(async () => (await st(app)).surface).toBe(surface);
}

/** The global scope: the Cloud surface with no Cloud session selected. */
async function toGlobalScope(app: ElectronApplication): Promise<void> {
  await setSurface(app, 'cloud');
  await expect.poll(async () => (await st(app)).tabs.scope ?? '').toBe('');
}

async function toClaudeScope(app: ElectronApplication, id: string): Promise<void> {
  await setSurface(app, 'claude');
  await call(app, 'claudeSelect', id);
  await expect.poll(async () => (await st(app)).tabs.scope).toBe(`claude:${id}`);
}

const st = (app: ElectronApplication) =>
  state(app) as Promise<PublicState & { claudeSessionId: string | null; reviewTerminalHeight: number }>;

const prUrl = (n: number) => `${fixtures.githubUrl}/cloudbeds/testrepo/pull/${n}`;

/** Right-click the tab in the shell and return the described menu. */
async function openTabMenu(app: ElectronApplication, tabId: string): Promise<MenuItem[]> {
  const page = await shellPage(app);
  await page.click(`[data-tab-id="${tabId}"]`, { button: 'right' });
  let items: MenuItem[] | null = null;
  await expect
    .poll(async () => {
      items = await call<MenuItem[] | null>(app, 'tabMenuItems');
      return items !== null;
    })
    .toBe(true);
  return items!;
}

async function menuReview(app: ElectronApplication, tabId: string): Promise<void> {
  const items = await openTabMenu(app, tabId);
  const review = items.find((i) => i.label === 'Review pull request');
  expect(review?.enabled).toBe(true);
  expect(await call<{ action: string | null }>(app, 'tabMenuClick', review!.id)).toEqual({ action: 'review' });
}

async function startReview(app: ElectronApplication, tabId: string): Promise<ReviewRecord> {
  expect(await call<{ ok: boolean }>(app, 'reviewStart', tabId)).toEqual({ ok: true });
  const record = await reviewState(app, tabId);
  expect(record?.status).toBe('reviewing');
  expect(record?.ptyId).toBeTruthy();
  return record!;
}

/** The tab's close button in the strip (tabs:close → close + layout). */
async function closeTabUi(app: ElectronApplication, tabId: string): Promise<void> {
  const page = await shellPage(app);
  await page.click(`[data-tab-id="${tabId}"] .closeMark`);
  await expect.poll(async () => (await st(app)).tabs.tabs.some((t) => t.id === tabId)).toBe(false);
}

const dotOf = (app: ElectronApplication, tabId: string) =>
  shell(app, `document.querySelector('[data-tab-id="${tabId}"] .reviewDot')?.getAttribute('data-review') ?? null`);
const stripVisible = (app: ElectronApplication) =>
  shell(
    app,
    `(() => { const el = document.getElementById('reviewTerminal'); return !!el && getComputedStyle(el).display !== 'none'; })()`,
  );

// The SDK's project dir encoding (C:\work\alpha → C--work-alpha).
const encodeDir = (cwd: string) => cwd.replace(/[:\\/]/g, '-');

/** Real-shaped transcript: the user prompt (which echoes the marker template),
 * then — when given — one assistant message. Returns the file path. */
function writeTranscript(
  projectsRoot: string,
  cwd: string,
  sessionId: string,
  prompt: string,
  assistantText: string | null,
): { file: string; userUuid: string } {
  const dir = join(projectsRoot, encodeDir(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  const userUuid = randomUUID();
  const base = { isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.312', gitBranch: 'main' };
  writeFileSync(
    file,
    `${JSON.stringify({
      ...base,
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: prompt },
      uuid: userUuid,
      timestamp: new Date().toISOString(),
    })}\n`,
  );
  if (assistantText !== null) appendAssistant(file, cwd, sessionId, userUuid, assistantText);
  return { file, userUuid };
}

function appendAssistant(file: string, cwd: string, sessionId: string, parentUuid: string, text: string): void {
  appendFileSync(
    file,
    `${JSON.stringify({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: '2.1.312',
      gitBranch: 'main',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    })}\n`,
  );
}

/** The pty's output as text: ConPTY wraps a long line as `\r\n ESC[r;cH <last
 * char again>`, so the wrap (and the repeated char) is dropped, then any
 * remaining escape sequence. */
async function ptyText(app: ElectronApplication, ptyId: string): Promise<string> {
  const raw = await call<string>(app, 'terminalRead', ptyId);
  // eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
  return raw.replace(/\r\n\x1b\[\d+;\d+H[\s\S]/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Cases 1–7 share one app (each uses its own PR numbers and tabs). A failed
// case restarts the worker, so the next case gets a fresh launch.
test.describe('tab review (local host)', () => {
  let ctx: Launched;
  let reviewsDir: string;

  test.beforeAll(async () => {
    ctx = await launchReviewApp();
    reviewsDir = join(ctx.reviewsHome, '.agent-workspace', 'reviews');
    await expect.poll(async () => (await call<{ status: string }>(ctx.app, 'claudeState')).status).toBe('ready');
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app);
  });

  const local = (sessionId: string, text: string | null, url: string) =>
    writeTranscript(join(ctx.claudeHome, 'projects'), reviewsDir, sessionId, buildReviewPrompt(url), text);

  test('1. menu: enabled for a PR, disabled otherwise, no-claude refusal spawns nothing', async () => {
    const { app } = ctx;
    await toGlobalScope(app);
    const pr = await openTab(app, prUrl(101));
    const plain = await openTab(app, `${fixtures.githubUrl}/page/review-plain`);

    const prItems = await openTabMenu(app, pr);
    expect(prItems.map((i) => [i.label, i.enabled])).toEqual([
      ['Copy address', true],
      ['Review pull request', true],
    ]);
    const plainItems = await openTabMenu(app, plain);
    expect(plainItems.find((i) => i.label === 'Review pull request')?.enabled).toBe(false);

    await setSettings(app, { claude: { path: join(ctx.profile, 'missing', 'claude.exe') } });
    await expect.poll(() => readSettings(ctx.profile).claude?.path ?? null).toContain('missing');
    const before = (await terminals(app)).length;
    const items = await openTabMenu(app, pr);
    const review = items.find((i) => i.label === 'Review pull request')!;
    expect(await call(app, 'tabMenuClick', review.id)).toEqual({ action: 'review' });
    expect(await call(app, 'lastReviewRefusal')).toBe('no-claude');
    expect(await reviewState(app, pr)).toBeNull();
    expect((await terminals(app)).length).toBe(before);
    expect(await dotOf(app, pr)).toBeNull();

    await setSettings(app, { claude: { path: null } });
    await expect.poll(() => readSettings(ctx.profile).claude?.path ?? null).toBeNull();
    await call(app, 'close', pr);
    await call(app, 'close', plain);
  });

  test('2. start: pty argv, strip + dot, Reviews workspace, no PR side effects', async () => {
    const { app, logFile } = ctx;
    await toGlobalScope(app);
    const url = prUrl(102);
    const tab = await openTab(app, url);
    // Every tab in every scope: an auto-open would land in the hidden claude:<review id> scope.
    const allTabs = async () => {
      const tabs = (await st(app)).tabs;
      return tabs.tabs.length + tabs.hiddenTabCount;
    };
    const tabCount = await allTabs();

    await menuReview(app, tab);
    expect(await call(app, 'lastReviewRefusal')).toBeNull();
    const record = (await reviewState(app, tab))!;
    expect(record.status).toBe('reviewing');
    expect(record.hostId).toBe('local');
    expect(record.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const ptyId = record.ptyId!;
    // The fake pty prints its argv, then the env line.
    await expect.poll(() => ptyText(app, ptyId)).toContain('env:AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN=set');
    const echo = await ptyText(app, ptyId);
    expect(echo).toContain(`--session-id ${record.sessionId}`);
    expect(echo).toContain(`/cb:review ${url}`);
    expect(echo).toContain('AW_REVIEW_VERDICT: approved | changes | discussion');
    // The review pty is a claude-kind pty owned by the review session id.
    expect((await terminals(app)).find((t) => t.id === ptyId)).toMatchObject({
      kind: 'claude',
      sessionId: record.sessionId,
    });

    await expect.poll(() => stripVisible(app)).toBe(true);
    await expect.poll(() => dotOf(app, tab)).toBe('reviewing');
    await expect
      .poll(() => shell(app, `document.getElementById('reviewTerminalStatus')?.getAttribute('data-review')`))
      .toBe('reviewing');
    expect(await shell(app, `document.getElementById('reviewTerminalLabel')?.textContent`)).toBe(
      'Review cloudbeds/testrepo#102',
    );
    // Local host: the hook listener is reachable, so no warning.
    expect(await shell(app, `Boolean(document.getElementById('reviewTerminalHooksWarning'))`)).toBe(false);

    // The Reviews workspace: created on disk, pinned first with its label.
    expect(existsSync(reviewsDir)).toBe(true);
    await expect.poll(() => readSettings(ctx.profile).claude?.workspaces?.[0]).toBe(reviewsDir);
    expect(readSettings(ctx.profile).claude.workspaceLabels[reviewsDir]).toBe('Reviews');

    // Review Focus 4: the PR URL in the prompt/pty echo and a hook's prUrls
    // never record a Claude PR, open a tab or raise pr-opened.
    expect(
      (
        await postHook(app, 'PostToolUse', {
          session_id: record.sessionId,
          tool_name: 'Bash',
          tool_input: { command: 'gh pr create --fill' },
          tool_response: `Created PR ${prUrl(199)}`,
          cwd: reviewsDir,
        })
      ).ok,
    ).toBe(true);
    // Hook handling is synchronous once the POST is answered; 1.5 s also covers
    // the 150 ms prTitles debounce and a lazy tab open.
    await sleep(1_500);
    expect(await call<unknown[]>(app, 'claudePrs', record.sessionId)).toEqual([]);
    expect(await allTabs()).toBe(tabCount);
    expect((await readEvents(logFile)).filter((e) => e.event === 'pr-auto-open')).toEqual([]);
    expect((await notifications(app)).filter((n) => n.kind === 'pr-opened')).toEqual([]);

    await closeTabUi(app, tab);
    await expect.poll(async () => (await terminals(app)).some((t) => t.id === ptyId)).toBe(false);
    expect(await reviewState(app, tab)).toBeNull();
  });

  const VERDICTS = [
    { n: 103, text: 'Found two bugs.\n\nAW_REVIEW_VERDICT: changes', verdict: 'changes', title: 'Review: changes requested' },
    { n: 104, text: 'All good.\n\n**AW_REVIEW_VERDICT: approved**', verdict: 'approved', title: 'Review: approved' },
    { n: 105, text: 'Open questions.\nAW_REVIEW_VERDICT: discussion', verdict: 'discussion', title: 'Review: needs discussion' },
    {
      n: 106,
      text: '## Summary\n\n**Overall Assessment:** Changes Requested\n\nSee the inline notes.',
      verdict: 'changes',
      title: 'Review: changes requested',
    },
  ] as const;

  test('3. verdict from the transcript, the Stop payload, and the retry', async () => {
    const { app } = ctx;
    await toGlobalScope(app);
    // `transcript`: a jsonl exists, so the session shows in the Claude sidebar.
    const finished: Array<{ tab: string; sessionId: string; transcript: boolean }> = [];

    for (const v of VERDICTS) {
      const url = prUrl(v.n);
      const tab = await openTab(app, url);
      const { sessionId } = await startReview(app, tab);
      local(sessionId, v.text, url);
      expect((await postHook(app, 'Stop', { session_id: sessionId })).ok).toBe(true);
      await expect.poll(() => reviewStatus(app, tab), { message: `PR ${v.n}` }).toBe(v.verdict);
      await expect.poll(() => dotOf(app, tab)).toBe(v.verdict);
      await expect.poll(async () => (await reviewEntries(app, url)).length).toBe(1);
      const [entry] = await reviewEntries(app, url);
      expect(entry).toMatchObject({
        title: v.title,
        body: `cloudbeds/testrepo#${v.n}`,
        reviewVerdict: v.verdict,
        scope: '',
      });
      finished.push({ tab, sessionId, transcript: true });
    }

    // Payload path: last_assistant_message wins; no transcript exists at all.
    {
      const url = prUrl(107);
      const tab = await openTab(app, url);
      const { sessionId } = await startReview(app, tab);
      await postHook(app, 'Stop', {
        session_id: sessionId,
        last_assistant_message: 'Reviewed.\nAW_REVIEW_VERDICT: approved',
      });
      await expect.poll(() => reviewStatus(app, tab)).toBe('approved');
      await expect.poll(async () => (await reviewEntries(app, url))[0]?.title).toBe('Review: approved');
      finished.push({ tab, sessionId, transcript: false });
    }

    // A payload string without a verdict is final for that Stop: the
    // transcript (which has a marker) is not read.
    {
      const url = prUrl(108);
      const tab = await openTab(app, url);
      const { sessionId } = await startReview(app, tab);
      local(sessionId, 'AW_REVIEW_VERDICT: approved', url);
      await postHook(app, 'Stop', { session_id: sessionId, last_assistant_message: 'Still working on it.' });
      // Past the last transcript re-read (7 s after the Stop): none was scheduled.
      await sleep(8_000);
      expect(await reviewStatus(app, tab)).toBe('reviewing');
      expect(await reviewEntries(app, url)).toEqual([]);
      expect(
        (await readEvents(ctx.logFile)).filter(
          (e) => e.event === 'review-verdict' && (e.detail as { sessionId?: string }).sessionId === sessionId,
        ),
      ).toEqual([]);
      await call(app, 'close', tab);
    }

    // Review Focus 1: only the user prompt (which carries the multi-value
    // marker template) → no verdict; the marker landing within 3 s is picked
    // up by the 1/3/7 s re-reads.
    {
      const url = prUrl(109);
      const tab = await openTab(app, url);
      const { sessionId } = await startReview(app, tab);
      const { file, userUuid } = local(sessionId, null, url);
      await postHook(app, 'Stop', { session_id: sessionId });
      // 1.5 s: past the immediate read and the 1 s re-read, before the 3 s one.
      await sleep(1_500);
      expect(await reviewStatus(app, tab)).toBe('reviewing');
      expect(await dotOf(app, tab)).toBe('reviewing');
      appendAssistant(file, reviewsDir, sessionId, userUuid, 'Done.\nAW_REVIEW_VERDICT: discussion');
      await expect.poll(() => reviewStatus(app, tab), { timeout: 8_000 }).toBe('discussion');
      await expect.poll(async () => (await reviewEntries(app, url))[0]?.title).toBe('Review: needs discussion');
      finished.push({ tab, sessionId, transcript: true });
    }

    // F15: the review sessions are listed under the Reviews section.
    await setSurface(app, 'claude');
    await call(app, 'claudeSelect', null);
    for (const { sessionId } of finished.filter((f) => f.transcript)) {
      await expect
        .poll(() =>
          shell(
            app,
            `(() => {
              const sec = [...document.querySelectorAll('[data-section-name]')]
                .find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(reviewsDir)})?.closest('div.mb-px');
              return sec ? !!sec.querySelector('[data-session-id="${sessionId}"]') : false;
            })()`,
          ),
        )
        .toBe(true);
    }
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(reviewsDir)})?.querySelector('[data-section-label]')?.textContent ?? ''`,
      ),
    ).toBe('Reviews');

    await toGlobalScope(app);
    for (const { tab } of finished) await call(app, 'close', tab);
  });

  test('4. a Stop for another session id is ignored; pty exit is the backstop', async () => {
    const { app } = ctx;
    await toGlobalScope(app);
    await setSettings(app, { notifications: { kinds: { finished: true } } });

    const urlA = prUrl(111);
    const tabA = await openTab(app, urlA);
    const a = await startReview(app, tabA);
    const before = (await notifications(app)).length;
    const ignoredStops = async () =>
      (await readEvents(ctx.logFile)).filter((e) => {
        const detail = e.detail as { event?: string; reason?: string } | undefined;
        return e.event === 'claude-hook-ignored' && detail?.event === 'Stop' && detail.reason === 'hooks-off';
      }).length;
    const ignoredBefore = await ignoredStops();
    // /clear or /resume inside the review pty → Stop under a new session id.
    // With claude.hooksEnabled off (the default) the listener drops it: no
    // open claude pty owns that id. The hooks-on path (a generic Stop for the
    // new id) is the known deferred gap in the ledger (Task 5 minor).
    await postHook(app, 'Stop', { session_id: randomUUID(), cwd: reviewsDir });
    await expect.poll(ignoredStops).toBe(ignoredBefore + 1);
    // 1.5 s: past the review's own 1 s re-read point, had the Stop reached it.
    await sleep(1_500);
    expect(await reviewStatus(app, tabA)).toBe('reviewing');
    expect((await notifications(app)).length).toBe(before);
    expect((await notifications(app)).filter((n) => n.kind === 'finished')).toEqual([]);
    // The exit reads the original transcript once: none → ended, no entry.
    expect(await call(app, 'reviewPtyExit', tabA)).toBe(true);
    await expect.poll(() => reviewStatus(app, tabA)).toBe('ended');
    expect((await reviewState(app, tabA))?.ptyId).toBeNull();
    await expect.poll(() => dotOf(app, tabA)).toBe('ended');
    await sleep(500);
    expect(await reviewEntries(app, urlA)).toEqual([]);
    expect((await terminals(app)).some((t) => t.id === a.ptyId)).toBe(false);

    const urlB = prUrl(112);
    const tabB = await openTab(app, urlB);
    const b = await startReview(app, tabB);
    local(b.sessionId, 'Needs work.\nAW_REVIEW_VERDICT: changes', urlB);
    expect(await call(app, 'reviewPtyExit', tabB)).toBe(true);
    await expect.poll(() => reviewStatus(app, tabB)).toBe('changes');
    await expect.poll(async () => (await reviewEntries(app, urlB))[0]?.title).toBe('Review: changes requested');

    await setSettings(app, { notifications: { kinds: { finished: false } } });
    await call(app, 'close', tabA);
    await call(app, 'close', tabB);
  });

  async function clickPanelRow(app: ElectronApplication, id: string): Promise<void> {
    await shell(app, `window.agentworkspace.notificationsPanel(true)`);
    await expect
      .poll(() => shell(app, `Boolean(document.querySelector('[data-notification-id="${id}"] > button'))`))
      .toBe(true);
    await shell(app, `document.querySelector('[data-notification-id="${id}"] > button').click()`);
  }

  test('5. link-back to the claude and local scopes; chat on a running review is refused', async () => {
    const { app } = ctx;

    // Claude scope.
    await toClaudeScope(app, UA);
    const urlC = prUrl(121);
    const tabC = await openTab(app, urlC);
    expect((await st(app)).tabs.tabs.find((t) => t.id === tabC)?.originSessionId).toBe(`claude:${UA}`);
    const c = await startReview(app, tabC);

    // F11: the running review session cannot be opened or prompted in chat.
    await call(app, 'claudeSelect', c.sessionId);
    await expect
      .poll(async () => (await call<{ lastError: { message: string } | null }>(app, 'claudeState')).lastError?.message)
      .toBe('A review is running in this session');
    expect((await st(app)).claudeSessionId).toBe(UA);
    await expect(call(app, 'claudePrompt', c.sessionId, 'hello')).rejects.toThrow(
      'A review is running in this session',
    );

    await postHook(app, 'Stop', { session_id: c.sessionId, last_assistant_message: 'AW_REVIEW_VERDICT: approved' });
    await expect.poll(async () => (await reviewEntries(app, urlC)).length).toBe(1);
    const [entryC] = await reviewEntries(app, urlC);
    expect(entryC!.scope).toBe(`claude:${UA}`);
    // Another tab in that scope takes focus; then leave the scope and close the pane.
    const otherC = await openTab(app, `${fixtures.githubUrl}/page/review-other-c`);
    expect((await st(app)).tabs.activeId).toBe(otherC);
    await call(app, 'claudeSelect', null);
    await toGlobalScope(app);
    await call(app, 'setPaneOpen', false);
    await expect.poll(async () => (await st(app)).paneOpen).toBe(false);

    await clickPanelRow(app, entryC!.id);
    await expect.poll(async () => (await st(app)).surface).toBe('claude');
    await expect.poll(async () => (await st(app)).claudeSessionId).toBe(UA);
    await expect.poll(async () => (await st(app)).tabs.activeId).toBe(tabC);
    expect((await st(app)).paneOpen).toBe(true);
    await shell(app, `window.agentworkspace.notificationsPanel(false)`);

    // Devin Local scope.
    await setSurface(app, 'local');
    await shell(app, `window.agentworkspace.localActiveSession(${JSON.stringify(LOCAL_SESSION)})`);
    await expect.poll(async () => (await st(app)).tabs.scope).toBe(`local:${LOCAL_SESSION}`);
    const urlL = prUrl(122);
    const tabL = await openTab(app, urlL);
    expect((await st(app)).tabs.tabs.find((t) => t.id === tabL)?.originSessionId).toBe(`local:${LOCAL_SESSION}`);
    const l = await startReview(app, tabL);
    await postHook(app, 'Stop', { session_id: l.sessionId, last_assistant_message: 'AW_REVIEW_VERDICT: changes' });
    await expect.poll(async () => (await reviewEntries(app, urlL)).length).toBe(1);
    const [entryL] = await reviewEntries(app, urlL);
    expect(entryL!.scope).toBe(`local:${LOCAL_SESSION}`);
    const otherL = await openTab(app, `${fixtures.githubUrl}/page/review-other-l`);
    expect((await st(app)).tabs.activeId).toBe(otherL);
    await shell(app, `window.agentworkspace.localActiveSession(null)`);
    await toGlobalScope(app);
    await call(app, 'setPaneOpen', false);
    await expect.poll(async () => (await st(app)).paneOpen).toBe(false);

    await clickPanelRow(app, entryL!.id);
    await expect.poll(async () => (await st(app)).surface).toBe('local');
    await expect.poll(async () => (await st(app)).localSessionId).toBe(LOCAL_SESSION);
    await expect.poll(async () => (await st(app)).tabs.activeId).toBe(tabL);
    expect((await st(app)).paneOpen).toBe(true);
    await shell(app, `window.agentworkspace.notificationsPanel(false)`);

    // After the verdict the review session may be opened: its idle pty (claude
    // still running) is ended first, so chat is the only writer.
    const cRecord = await reviewState(app, tabC);
    expect(cRecord?.status).toBe('approved');
    const cPty = cRecord!.ptyId!;
    expect(cPty).toBeTruthy();
    expect((await terminals(app)).some((t) => t.id === cPty)).toBe(true);
    await call(app, 'claudeSelect', c.sessionId);
    await expect.poll(async () => (await st(app)).claudeSessionId).toBe(c.sessionId);
    await expect.poll(async () => (await terminals(app)).some((t) => t.id === cPty)).toBe(false);
    expect((await reviewState(app, tabC))?.ptyId).toBeNull();
    expect((await reviewState(app, tabC))?.status).toBe('approved');
    await call(app, 'claudeSelect', null);

    for (const id of [tabC, otherC, tabL, otherL]) await call(app, 'close', id);
    await shell(app, `window.agentworkspace.localActiveSession(null)`);
    await call(app, 'claudeSelect', null);
    await toGlobalScope(app);
  });

  test('6. the same PR reviewed from two scopes: independent dots, one notification', async () => {
    const { app } = ctx;
    const url = prUrl(131);
    await toGlobalScope(app);
    const tabA = await openTab(app, url);
    const a = await startReview(app, tabA);
    await expect.poll(() => stripVisible(app)).toBe(true);

    // Away to the claude scope: the strip hides, the pty keeps running.
    await toClaudeScope(app, UA);
    const tabB = await openTab(app, url);
    expect(tabB).not.toBe(tabA);
    await expect.poll(() => stripVisible(app)).toBe(false);
    expect((await terminals(app)).some((t) => t.id === a.ptyId && t.exitCode === null)).toBe(true);
    const b = await startReview(app, tabB);
    expect(b.sessionId).not.toBe(a.sessionId);
    await expect.poll(() => stripVisible(app)).toBe(true);
    await expect.poll(() => dotOf(app, tabB)).toBe('reviewing');

    // Back: still reviewing, strip shown again for A.
    await call(app, 'claudeSelect', null);
    await toGlobalScope(app);
    await expect.poll(async () => (await st(app)).tabs.activeId).toBe(tabA);
    await expect.poll(() => stripVisible(app)).toBe(true);
    expect(await shell(app, `document.getElementById('reviewTerminal')?.getAttribute('data-tab-id')`)).toBe(tabA);
    expect(await reviewStatus(app, tabA)).toBe('reviewing');
    expect(await dotOf(app, tabA)).toBe('reviewing');

    await postHook(app, 'Stop', { session_id: a.sessionId, last_assistant_message: 'AW_REVIEW_VERDICT: approved' });
    await expect.poll(() => reviewStatus(app, tabA)).toBe('approved');
    expect(await reviewStatus(app, tabB)).toBe('reviewing');
    await postHook(app, 'Stop', { session_id: b.sessionId, last_assistant_message: 'AW_REVIEW_VERDICT: changes' });
    await expect.poll(() => reviewStatus(app, tabB)).toBe('changes');
    expect(await reviewStatus(app, tabA)).toBe('approved');
    await expect.poll(() => dotOf(app, tabA)).toBe('approved');

    // The second verdict supersedes the first entry and points at scope B.
    await expect.poll(async () => (await reviewEntries(app, url)).map((e) => [e.scope, e.title])).toEqual([
      [`claude:${UA}`, 'Review: changes requested'],
    ]);
    // Opening it lands on scope B, with B's tab active.
    const [entry] = await reviewEntries(app, url);
    await clickPanelRow(app, entry!.id);
    await expect.poll(async () => (await st(app)).tabs.scope).toBe(`claude:${UA}`);
    expect((await st(app)).surface).toBe('claude');
    expect((await st(app)).claudeSessionId).toBe(UA);
    await expect.poll(async () => (await st(app)).tabs.activeId).toBe(tabB);
    await shell(app, `window.agentworkspace.notificationsPanel(false)`);

    await call(app, 'close', tabA);
    await call(app, 'close', tabB);
    await call(app, 'claudeSelect', null);
    await toGlobalScope(app);
  });

  test('7. strip: resize, tab switch, close while reviewing and after a verdict, tab close', async () => {
    const { app } = ctx;
    await toGlobalScope(app);
    const url = prUrl(141);
    const tab = await openTab(app, url);
    const plain = await openTab(app, `${fixtures.githubUrl}/page/review-strip-plain`);
    await call(app, 'activate', tab);
    const first = await startReview(app, tab);
    await expect.poll(() => stripVisible(app)).toBe(true);

    // Drag the 'r' splitter up by 100 px → a taller strip, persisted.
    const page = await shellPage(app);
    const before = (await st(app)).reviewTerminalHeight;
    const box = await page.locator('#reviewSplitter').boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 100, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await st(app)).reviewTerminalHeight).toBeGreaterThan(before + 90);
    const height = (await st(app)).reviewTerminalHeight;
    expect(height).toBeLessThanOrEqual(before + 110);
    await expect.poll(() => readSettings(ctx.profile).layout?.reviewTerminalHeight).toBe(height);

    // Switching tabs hides the strip; switching back shows it.
    await call(app, 'activate', plain);
    await expect.poll(() => stripVisible(app)).toBe(false);
    await call(app, 'activate', tab);
    await expect.poll(() => stripVisible(app)).toBe(true);

    // Close while reviewing: confirm, then the pty goes and the dot is ended.
    await page.click('#reviewTerminalClose');
    await expect(page.locator('#reviewTerminalCloseConfirm')).toBeVisible();
    expect(await reviewStatus(app, tab)).toBe('reviewing');
    await page.click('#reviewTerminalCloseConfirmYes');
    await expect.poll(() => reviewStatus(app, tab)).toBe('ended');
    await expect.poll(async () => (await terminals(app)).some((t) => t.id === first.ptyId)).toBe(false);
    await expect.poll(() => dotOf(app, tab)).toBe('ended');
    await expect.poll(() => stripVisible(app)).toBe(false);

    // Re-run from the menu, verdict, then close: no confirm, the dot stays.
    const items = await openTabMenu(app, tab);
    const rerun = items.find((i) => i.label === 'Re-run review');
    expect(rerun?.enabled).toBe(true);
    expect(await call(app, 'tabMenuClick', rerun!.id)).toEqual({ action: 'rerun' });
    const second = (await reviewState(app, tab))!;
    expect(second.status).toBe('reviewing');
    expect(second.sessionId).not.toBe(first.sessionId);
    await expect.poll(() => stripVisible(app)).toBe(true);
    await postHook(app, 'Stop', { session_id: second.sessionId, last_assistant_message: 'AW_REVIEW_VERDICT: approved' });
    await expect.poll(() => reviewStatus(app, tab)).toBe('approved');
    await expect.poll(() => shell(app, `document.getElementById('reviewTerminalStatus')?.getAttribute('data-review')`)).toBe(
      'approved',
    );
    await page.click('#reviewTerminalClose');
    await expect.poll(() => stripVisible(app)).toBe(false);
    expect(await page.locator('#reviewTerminalCloseConfirm').count()).toBe(0);
    expect(await reviewStatus(app, tab)).toBe('approved');
    expect(await dotOf(app, tab)).toBe('approved');
    // A verdict leaves claude running: the pty survives the strip close.
    expect((await terminals(app)).some((t) => t.id === second.ptyId)).toBe(true);
    // The pty is alive and its strip closed: the menu offers it back beside Re-run.
    const after = await openTabMenu(app, tab);
    expect(after.map((i) => i.label)).toEqual(['Copy address', 'Re-run review', 'Show review terminal']);
    const show = after.find((i) => i.label === 'Show review terminal')!;
    expect(await call(app, 'tabMenuClick', show.id)).toEqual({ action: 'show-review' });
    await expect.poll(() => stripVisible(app)).toBe(true);
    expect((await reviewState(app, tab))?.ptyId).toBe(second.ptyId);
    expect(await shell(app, `document.getElementById('reviewTerminal')?.getAttribute('data-tab-id')`)).toBe(tab);
    expect(await reviewStatus(app, tab)).toBe('approved');
    // Shown again: no Show item.
    expect((await openTabMenu(app, tab)).map((i) => i.label)).toEqual(['Copy address', 'Re-run review']);

    // Closing the tab ends its pty and drops the record.
    await closeTabUi(app, tab);
    await expect.poll(async () => (await terminals(app)).some((t) => t.id === second.ptyId)).toBe(false);
    expect(await reviewState(app, tab)).toBeNull();
    await call(app, 'close', plain);

    // K10: no review-* record (refused, workspace, start, verdict, ended,
    // open, terminal) carries a PR URL or the reviews cwd.
    const reviewLogs = (await readEvents(ctx.logFile)).filter((e) => String(e.event).startsWith('review-'));
    expect(new Set(reviewLogs.map((e) => e.event))).toEqual(
      new Set([
        'review-refused',
        'review-workspace',
        'review-start',
        'review-verdict',
        'review-ended',
        'review-open',
        'review-terminal',
      ]),
    );
    for (const record of reviewLogs) {
      const text = JSON.stringify(record);
      expect(text).not.toContain('/pull/');
      expect(text).not.toContain(fixtures.githubUrl);
      expect(text).not.toContain('reviews-home');
      expect(text).not.toContain('.agent-workspace');
    }
  });
});

// --- Case 8: a WSL review host (fake wsl.exe + the real helper bundle).
test('8. WSL host: workspace in the distro, --cd, verdict over the channel, hooks warning, refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-review-wsl-'));
  const ctx = await launchReviewApp({
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_ROOT: root,
    AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS: '300',
  });
  const { app } = ctx;
  const HOST = 'wsl:Fake';
  const LINUX_REVIEWS = '/home/u/.agent-workspace/reviews';
  try {
    await expect
      .poll(async () => (await call<{ state: string } | null>(app, 'hostChannelState', HOST))?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    await expect
      .poll(async () => (await call<{ claude: { path: string | null } } | null>(app, 'hostStatus', HOST))?.claude.path)
      .toBeTruthy();

    await setSettings(app, { review: { host: HOST } });
    await expect.poll(() => readSettings(ctx.profile).review?.host).toBe(HOST);
    await toGlobalScope(app);
    const url = prUrl(151);
    const tab = await openTab(app, url);
    const record = await startReview(app, tab);
    expect(record.hostId).toBe(HOST);

    expect(existsSync(join(root, 'home', 'u', '.agent-workspace', 'reviews'))).toBe(true);
    await expect.poll(() => ptyText(app, record.ptyId!)).toContain('env:AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN=');
    const echo = await ptyText(app, record.ptyId!);
    expect(echo).toContain(`--cd ${LINUX_REVIEWS}`);
    expect(echo).toContain(`--session-id ${record.sessionId}`);
    expect(echo).toContain(`/cb:review ${url}`);
    // FAKE_WSL_HOOKS unset → the hook listener is unreachable from the distro.
    await expect.poll(() => stripVisible(app)).toBe(true);
    await expect
      .poll(() => shell(app, `Boolean(document.getElementById('reviewTerminalHooksWarning'))`))
      .toBe(true);

    writeTranscript(
      join(root, 'home', 'u', '.claude', 'projects'),
      LINUX_REVIEWS,
      record.sessionId,
      buildReviewPrompt(url),
      'Reviewed in the distro.\nAW_REVIEW_VERDICT: approved',
    );
    await postHook(app, 'Stop', { session_id: record.sessionId });
    await expect.poll(() => reviewStatus(app, tab)).toBe('approved');
    await expect.poll(async () => (await reviewEntries(app, url))[0]?.title).toBe('Review: approved');
    expect(
      (await readEvents(ctx.logFile))
        .filter((e) => e.event === 'review-verdict')
        .map((e) => (e.detail as { via: string }).via),
    ).toEqual(['marker']);

    // A distro that is not there refuses — never a silent fallback to this PC.
    await setSettings(app, { review: { host: 'wsl:Missing' } });
    await expect.poll(() => readSettings(ctx.profile).review?.host).toBe('wsl:Missing');
    const other = await openTab(app, prUrl(152));
    const items = await openTabMenu(app, other);
    const review = items.find((i) => i.label === 'Review pull request')!;
    expect(await call(app, 'tabMenuClick', review.id)).toEqual({ action: 'review' });
    expect(await call(app, 'lastReviewRefusal')).toBe('distro-unavailable');
    expect(await reviewState(app, other)).toBeNull();

    expect(await call<number>(app, 'remoteFsViolations')).toBe(0);
  } finally {
    await closeApp(ctx.app);
  }
});

// --- Case 9: the review distro is Stopped (e.g. after a reboot). The review is
// a user action, so it starts the distro (explicit probe + mkdir) instead of
// refusing "not ready" forever. The fake cannot boot a distro, so the table is
// flipped to Running the way the real one would flip once wsl.exe -d starts it.
test('9. WSL host: a Stopped review distro is started by the review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-review-wsl-stopped-'));
  const distros = join(root, 'distros.txt');
  writeFileSync(distros, 'Fake:Stopped:default');
  const ctx = await launchReviewApp({
    FAKE_WSL_DISTROS_FILE: distros,
    FAKE_WSL_ROOT: root,
    AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS: '300',
  });
  const { app } = ctx;
  const HOST = 'wsl:Fake';
  const hostStatus = () =>
    call<{ state: string; home: string | null; hooks: string } | null>(app, 'hostStatus', HOST);
  try {
    await expect.poll(async () => (await hostStatus())?.state, { timeout: 30_000 }).toBe('stopped');
    // Never probed (no implicit work on a Stopped distro) → no home, no helper.
    expect((await hostStatus())?.home ?? null).toBeNull();
    expect(await call(app, 'hostChannelState', HOST)).toBeNull();

    await setSettings(app, { review: { host: HOST } });
    await expect.poll(() => readSettings(ctx.profile).review?.host).toBe(HOST);
    await toGlobalScope(app);
    const url = prUrl(161);
    const tab = await openTab(app, url);
    writeFileSync(distros, 'Fake:Running:default');
    const record = await startReview(app, tab);
    expect(record.hostId).toBe(HOST);
    expect(existsSync(join(root, 'home', 'u', '.agent-workspace', 'reviews'))).toBe(true);
    await expect.poll(() => ptyText(app, record.ptyId!)).toContain('--cd /home/u/.agent-workspace/reviews');
    // The start's probe settled the hook reachability (FAKE_WSL_HOOKS unset →
    // unreachable): the strip shows the warning from the probe result.
    await expect.poll(async () => (await hostStatus())?.hooks).toBe('unreachable');
    await expect.poll(() => stripVisible(app)).toBe(true);
    await expect
      .poll(() => shell(app, `Boolean(document.getElementById('reviewTerminalHooksWarning'))`))
      .toBe(true);
    // The re-read table flips the distro to Running; its helper comes up.
    await expect
      .poll(async () => (await call<{ state: string } | null>(app, 'hostChannelState', HOST))?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    expect((await readEvents(ctx.logFile)).some((e) => e.event === 'review-refused')).toBe(false);
    expect(await call<number>(app, 'remoteFsViolations')).toBe(0);
  } finally {
    await closeApp(ctx.app);
  }
});
