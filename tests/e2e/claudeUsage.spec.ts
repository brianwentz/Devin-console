// Analytics Claude tab — A2 service e2e: limits fetch through the fixture
// route, token aggregation over the fixture transcripts (A0 totals), stale
// fallback, incremental scanning, month rollover, fake-WSL host buckets.
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { startFixtureServers } from '../fixtures/http';
import {
  CLAUDE_FIXTURE_HOME,
  closeApp,
  shellPage,
  launchApp,
  launchWithClaudeFixture,
  readEvents,
  waitForEvent,
} from './helpers';

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    usage: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeUsageState()) as Promise<{
        status: string;
        accounts: {
          email: string | null;
          hosts: string[];
          limits: { kind: string; label: string; percent: number }[];
          credits: { enabled: boolean } | null;
          stale: boolean;
          error: string | null;
          fetchedAt: string | null;
        }[];
        perToken: boolean;
        month: string;
        tokens: {
          total: { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number };
          byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }>;
          byHost: Record<string, { input: number; messages: number }>;
          byDay: { date: string; byModel: Record<string, number> }[];
          previousMonthTotal: { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number } | null;
        };
      }>,
    refresh: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeUsageRefresh()) as Promise<void>,
  };
}

// A0 usage-a.jsonl + agent-1.jsonl totals plus the pre-existing
// agent-fixture01.jsonl subagent (in 2, out 2, 2 msgs).
const OCT_TOTAL = { input: 1602, output: 452, cacheRead: 6500, cacheWrite: 350, messages: 5 };

// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
});

test('usage: refresh fetches the fixture account + three limits', async () => {
  const fixtures = await startFixtureServers();
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
  });
  const h = hooks(app);
  try {
    await h.refresh();
    const state = await h.usage();
    expect(state.status).toBe('ready');
    expect(state.accounts).toHaveLength(1);
    const account = state.accounts[0]!;
    expect(account.email).toBe('dev@example.com');
    expect(account.hosts).toEqual(['local']);
    expect(account.stale).toBe(false);
    expect(account.limits.map((l) => [l.kind, l.percent])).toEqual([
      ['session', 0],
      ['weekly_all', 10],
      ['weekly_scoped', 0],
    ]);
    expect(account.limits.map((l) => l.label)).toContain('Current week (Fable)');
    expect(account.credits?.enabled).toBe(false);
    expect(account.fetchedAt).toBeTruthy();
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: tokens match the fixture transcript totals (Oct 2026)', async () => {
  const fixtures = await startFixtureServers();
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
  });
  const h = hooks(app);
  try {
    await h.refresh();
    const state = await h.usage();
    expect(state.month).toBe('2026-10');
    expect(state.tokens.total).toEqual(OCT_TOTAL);
    expect(state.tokens.byModel['opus-5-5']).toMatchObject({ input: 1200, messages: 2 });
    expect(state.tokens.byModel['sonnet-5']).toMatchObject({ input: 400, messages: 1 });
    expect(state.tokens.byDay).toHaveLength(4);
    expect(state.tokens.byHost.local).toBeTruthy();
    expect(state.perToken).toBe(false);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: 401 → stale true from the seeded .usage-cache', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-usage-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  // Seed the CLI-side stale cache (the service falls back to it on 401).
  cpSync('tests/fixtures/claude-usage.json', join(claudeHome, '.usage-cache'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
  });
  const h = hooks(app);
  // The fixture route reads FAKE_* env in the test process, not the app's.
  const prevStatus = process.env.FAKE_USAGE_STATUS;
  process.env.FAKE_USAGE_STATUS = '401';
  try {
    await h.refresh();
    const state = await h.usage();
    const account = state.accounts[0]!;
    expect(account.stale).toBe(true);
    expect(account.error).toContain('expired');
    expect(account.limits.map((l) => l.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped']);
    // Stale keeps the cached body's timestamp (the .usage-cache mtime).
    expect(account.fetchedAt).not.toBeNull();
  } finally {
    if (prevStatus === undefined) delete process.env.FAKE_USAGE_STATUS;
    else process.env.FAKE_USAGE_STATUS = prevStatus;
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: incremental scan — unchanged files reuse, appended lines count', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-usage-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
  });
  const h = hooks(app);
  const usageFile = join(
    claudeHome,
    'projects',
    'C--work-alpha',
    'usage-a',
    'usage-a.jsonl',
  );
  try {
    await h.refresh();
    await h.refresh();
    // Second scan: no file changes → changed: 0.
    await waitForEvent(logFile, 'usage-scan');
    const scans = (await readEvents(logFile)).filter((e) => e.event === 'usage-scan');
    expect((scans.at(-1) as any)?.detail.changed).toBe(0);

    // Append one assistant line (new requestId) → next scan picks it up.
    appendFileSync(
      usageFile,
      JSON.stringify({
        type: 'assistant',
        uuid: 'extra-1',
        requestId: 'req-extra-1',
        timestamp: '2026-10-08T10:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'opus-5-5',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
        },
      }) + '\n',
    );
    await h.refresh();
    const state = await h.usage();
    expect(state.tokens.total.input).toBe(OCT_TOTAL.input + 10);
    expect(state.tokens.total.messages).toBe(OCT_TOTAL.messages + 1);
    const after = (await readEvents(logFile)).filter((e) => e.event === 'usage-scan');
    expect((after.at(-1) as any)?.detail.changed).toBe(1);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: TEST_NOW in November → empty month, previousMonthTotal = October', async () => {
  const fixtures = await startFixtureServers();
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_NOW: '2026-11-03T12:00:00.000Z',
  });
  const h = hooks(app);
  try {
    await h.refresh();
    const state = await h.usage();
    expect(state.month).toBe('2026-11');
    expect(state.tokens.total).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      messages: 0,
    });
    expect(state.tokens.previousMonthTotal).toEqual(OCT_TOTAL);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: fake WSL host contributes byHost + joins the same account', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-usage-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  // Fake distro home: <uncRoot>\home\u — its claude dir gets credentials + a
  // transcript with usage so byHost['wsl:Fake'] is populated.
  const wslClaude = join(uncRoot, 'home', 'u', '.claude');
  mkdirSync(join(wslClaude, 'projects', '-home-u-ws'), { recursive: true });
  cpSync(join(CLAUDE_FIXTURE_HOME, '.credentials.json'), join(wslClaude, '.credentials.json'));
  const WSL_ID = '33333333-0000-4000-8000-0000000000w1';
  writeFileSync(
    join(wslClaude, 'projects', '-home-u-ws', `${WSL_ID}.jsonl`),
    JSON.stringify({
      parentUuid: null,
      userType: 'external',
      cwd: '/home/u/ws',
      sessionId: WSL_ID,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'opus-5-5',
        content: [{ type: 'text', text: 'wsl' }],
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
      },
      uuid: `${WSL_ID}-a1`,
      requestId: 'req-wsl-1',
      timestamp: '2026-10-09T10:00:00.000Z',
    }) + '\n',
  );
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
  });
  const h = hooks(app);
  try {
    await h.refresh();
    const state = await h.usage();
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]!.hosts.sort()).toEqual(['local', 'wsl:Fake']);
    expect(state.tokens.byHost['wsl:Fake']).toMatchObject({ input: 7, messages: 1 });
    expect(state.tokens.total.input).toBe(OCT_TOTAL.input + 7);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(uncRoot, { recursive: true, force: true });
    await fixtures.close();
  }
});

// ux3 S7: `withConfigDir` swaps process.env.CLAUDE_CONFIG_DIR to the distro's
// store while an SDK call runs. The scanner resolves the local host through
// hosts().configDir(), which must answer from the value captured at startup —
// otherwise a scan racing the swap reads the WSL store as `local` (observed:
// 2,148 `local:` cache keys carrying Linux-home paths, byHost.local identical
// to the distro's).
test('usage: scan racing a withConfigDir swap keeps local and wsl stores apart', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-usage-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  const wslClaude = join(uncRoot, 'home', 'u', '.claude');
  const WSL_PROJECT = '-home-u-race';
  mkdirSync(join(wslClaude, 'projects', WSL_PROJECT), { recursive: true });
  cpSync(join(CLAUDE_FIXTURE_HOME, '.credentials.json'), join(wslClaude, '.credentials.json'));
  const WSL_ID = '44444444-0000-4000-8000-0000000000w2';
  writeFileSync(
    join(wslClaude, 'projects', WSL_PROJECT, `${WSL_ID}.jsonl`),
    JSON.stringify({
      parentUuid: null,
      userType: 'external',
      cwd: '/home/u/race',
      sessionId: WSL_ID,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'opus-5-5',
        content: [{ type: 'text', text: 'wsl' }],
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
      },
      uuid: `${WSL_ID}-a1`,
      requestId: 'req-wsl-race-1',
      timestamp: '2026-10-09T10:00:00.000Z',
    }) + '\n',
  );
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
  });
  const h = hooks(app);
  try {
    // Baseline pass (also materialises the wsl host entry for hostById).
    await h.refresh();
    // Hold the distro's CLAUDE_CONFIG_DIR swap open, then scan while it is
    // active. The hold resolves after the scan has finished.
    const hold = app.evaluate(
      (_electron, ms) => (globalThis as any).__devinworkspaces.withConfigDirHold('wsl:Fake', ms),
      8_000,
    ) as Promise<{ envDuring: string | null; localDuring: string }>;
    await expect
      .poll(() => app.evaluate(() => process.env.CLAUDE_CONFIG_DIR ?? null), { timeout: 5_000 })
      .toBe(wslClaude);
    await h.refresh();
    const state = await h.usage();
    const during = await hold;
    // The swap was really active (the SDK would have seen the distro store).
    expect(during.envDuring).toBe(wslClaude);

    // Each host's bucket equals the totals of its own seeded files (pre-fix:
    // byHost.local === byHost['wsl:Fake'] — the local store was never read).
    expect(state.tokens.byHost.local).not.toEqual(state.tokens.byHost['wsl:Fake']);
    expect(state.tokens.byHost.local).toMatchObject({
      input: OCT_TOTAL.input,
      messages: OCT_TOTAL.messages,
    });
    expect(state.tokens.byHost['wsl:Fake']).toMatchObject({ input: 7, messages: 1 });
    expect(state.tokens.total.input).toBe(OCT_TOTAL.input + 7);

    // The registry kept answering with the startup value throughout, and the
    // swap was restored afterwards.
    expect(during.localDuring).toBe(claudeHome);
    expect(await app.evaluate(() => process.env.CLAUDE_CONFIG_DIR ?? null)).toBe(claudeHome);

    // No local: cache key points into the distro's store.
    const cache = JSON.parse(
      readFileSync(join(profile, 'claude-usage-cache.json'), 'utf8'),
    ) as { files: Record<string, unknown> };
    const keys = Object.keys(cache.files);
    const localKeys = keys.filter((k) => k.startsWith('local:'));
    expect(localKeys.length).toBeGreaterThan(0);
    expect(localKeys.filter((k) => k.includes(WSL_PROJECT))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('wsl:Fake:') && k.includes(WSL_PROJECT))).toHaveLength(1);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(uncRoot, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: a poisoned local: cache key is pruned on the next scan', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-usage-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  // A pre-fix cache: a local: key carrying a Linux-home project path.
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'claude-usage-cache.json'),
    JSON.stringify({
      version: 1,
      files: {
        'local:\\-home-u-ws\\poisoned.jsonl': { size: 1, mtime: 1, offset: 1, buckets: {} },
      },
      accounts: {},
    }),
  );
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
  });
  const h = hooks(app);
  try {
    await h.refresh();
    await waitForEvent(logFile, 'usage-cache-pruned');
    const pruned = (await readEvents(logFile)).filter((e) => e.event === 'usage-cache-pruned');
    expect((pruned[0] as any)?.detail.count).toBe(1);
    const cache = JSON.parse(
      readFileSync(join(profile, 'claude-usage-cache.json'), 'utf8'),
    ) as { files: Record<string, unknown> };
    expect(Object.keys(cache.files).some((k) => k.includes('-home-u-ws'))).toBe(false);
    expect(Object.keys(cache.files).length).toBeGreaterThan(0);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    await fixtures.close();
  }
});

test('usage: two accounts render as two gauge blocks (per-host account files)', async () => {
  const fixtures = await startFixtureServers();
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-usage-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  const wslClaude = join(uncRoot, 'home', 'u', '.claude');
  mkdirSync(join(wslClaude, 'projects'), { recursive: true });
  cpSync(join(CLAUDE_FIXTURE_HOME, '.credentials.json'), join(wslClaude, '.credentials.json'));
  // The fake distro is signed into a different account (per-host seam).
  const wslAccountFile = join(profile, 'wsl-account.json');
  writeFileSync(
    wslAccountFile,
    JSON.stringify({
      oauthAccount: { emailAddress: 'personal@outlook.com', organizationName: 'Personal Org' },
    }),
  );
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_NOW: '2026-10-15T12:00:00.000Z',
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
    DEVIN_WORKSPACES_TEST_CLAUDE_ACCOUNT_FILE: `tests/fixtures/claude-account.json;wsl:Fake=${wslAccountFile}`,
  });
  const h = hooks(app);
  try {
    await h.refresh();
    const state = await h.usage();
    expect(state.accounts).toHaveLength(2);
    const emails = state.accounts.map((a) => a.email).sort();
    expect(emails).toEqual(['dev@example.com', 'personal@outlook.com']);
    const personal = state.accounts.find((a) => a.email === 'personal@outlook.com')!;
    expect(personal.hosts).toEqual(['wsl:Fake']);
    expect(personal.limits).toHaveLength(3);

    // DOM: one gauge block per account, each with its own header.
    const shell = await shellPage(app);
    await shell.locator('#analyticsButton').click();
    await shell.locator('#analyticsTab-claude').click();
    const blocks = shell.locator('[data-usage-account]');
    await expect.poll(async () => blocks.count()).toBe(2);
    await expect(blocks.nth(0)).toContainText('dev@example.com');
    await expect(blocks.nth(1)).toContainText('personal@outlook.com');
    await expect.poll(async () => blocks.nth(0).locator('[data-gauge-kind]').count()).toBe(3);
    await expect.poll(async () => blocks.nth(1).locator('[data-gauge-kind]').count()).toBe(3);
    await expect(blocks.nth(1)).toContainText('Personal Org');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(uncRoot, { recursive: true, force: true });
    await fixtures.close();
  }
});
