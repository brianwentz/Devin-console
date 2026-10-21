import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ElectronApplication } from 'playwright';
import {
  CLAUDE_FIXTURE_HOME,
  closeApp,
  evaluateInShell,
  launchApp,
  launchWithClaudeFixture,
  readEvents,
  shellPage,
  state,
} from './helpers';

// Exec hosts (§3.8): the fake wsl.exe stands in for WSL — enumeration,
// probing, env capture and the wsl-shaped pty argv all run for real.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test('a running fake distro is enumerated, probed and env-captured', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_ENV_MARKER: '1',
  });
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');
    const host = (await state(app)).hosts.find((h) => h.id === 'wsl:Fake');
    expect(host).toBeTruthy();
    expect(host?.shellEnv?.ok).toBe(true);
    expect(host?.shellEnv?.count).toBeGreaterThan(0);
    expect(host?.claude.path).toBeTruthy();
    expect(host?.shell).toBe('/bin/bash');
    // Node version rides the interactive-login env-capture spawn.
    expect(host?.node).toBe('22.12.0');
    // Every wsl.exe call is counted: enumeration, probe and env capture all logged.
    const kinds = new Set(
      (await readEvents(join(profile, 'events.jsonl')))
        .filter((e) => e.event === 'host-exec')
        .map((e) => (e.detail as { kind: string }).kind),
    );
    expect([...kinds]).toEqual(expect.arrayContaining(['enum', 'probe', 'env']));
    const keys = (await app.evaluate(() =>
      (globalThis as any).__agentworkspace.hostShellEnvKeys('wsl:Fake'),
    )) as string[];
    expect(keys).toContain('FAKE_WSL_MARKER');
  } finally {
    await closeApp(app);
  }
});

test('node is null (unknown) when the distro has no node', async () => {
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_NO_NODE: '1',
  });
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    const host = (await state(app)).hosts.find((h) => h.id === 'wsl:Fake');
    expect(host?.shellEnv?.ok).toBe(true);
    expect(host?.node).toBeNull();
  } finally {
    await closeApp(app);
  }
});

test('read paths never re-enumerate: repeated status reads add no wsl -l -v', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
  });
  const logFile = join(profile, 'events.jsonl');
  const enums = async () =>
    (await readEvents(logFile)).filter(
      (e) => e.event === 'host-exec' && (e.detail as { kind?: string } | undefined)?.kind === 'enum',
    ).length;
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    // Let startup work (usage, agents, sessions) settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const startup = await enums();
    expect(startup).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 25; i++) {
      await app.evaluate(() => (globalThis as any).__agentworkspace.hosts());
      await state(app);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await enums()).toBe(startup);
  } finally {
    await closeApp(app);
  }
});

test('a session created under the UNC root runs on the wsl host', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: `node ${join(process.cwd(), 'out/fixtures/fakePty.cjs')}`,
  });
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');

    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__agentworkspace.claudeNewSession(cwd),
      `${uncRoot}\\home\\u\\proj`,
    )) as string | null;
    expect(id).toBeTruthy();

    const chat = (await app.evaluate(() =>
      (globalThis as any).__agentworkspace.claudeChatState(),
    )) as { sessions: Record<string, { host: string; cwd: string }> };
    expect(chat.sessions[id!]?.host).toBe('wsl:Fake');
    expect(chat.sessions[id!]?.cwd).toBe('/home/u/proj');

    const opened = (await app.evaluate(
      (_e, sessionId: string) =>
        (globalThis as any).__agentworkspace.claudeTerminalOpen(sessionId),
      id!,
    )) as { ok: boolean; id?: string };
    expect(opened.ok).toBe(true);
    const terminalId = opened.id!;
    const read = () =>
      app.evaluate(
        (_e, tid: string) => (globalThis as any).__agentworkspace.terminalRead(tid),
        terminalId,
      ) as Promise<string>;
    await expect.poll(read).toContain('-d Fake --cd /home/u/proj -e /bin/bash -ilc');
    await expect.poll(read).toContain('/home/u/.local/bin/claude');
  } finally {
    await closeApp(app);
  }
});

test('settings hosts block lists the distro; the checkbox disables it', async () => {
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_NO_CLAUDE: '1',
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const shell = await shellPage(app);
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');
    // The per-host problem text belongs to Settings, never the Claude column.
    await expect
      .poll(async () => {
        await app.evaluate(() => (globalThis as any).__agentworkspace.claudeRefresh());
        const snap = (await app.evaluate(() =>
          (globalThis as any).__agentworkspace.claudeState(),
        )) as { hostErrors?: Record<string, string> };
        return snap.hostErrors?.['wsl:Fake'] ?? '';
      }, { timeout: 30_000 })
      .toContain('Claude Code not found');
    await shell.locator('#claudeButton').click();
    await expect(shell.locator('[data-sidebar="claude"]')).toBeVisible({ timeout: 10_000 });
    await expect(shell.locator('[data-sidebar="claude"] [data-host-error]')).toHaveCount(0);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const row = shell.locator('[data-host-id="wsl:Fake"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator('[data-host-state]')).toHaveText('ready');
    await expect(row.locator('[data-host-facts]')).toContainText('shell env');
    await expect(row.locator('[data-host-error]')).toContainText('Claude Code not found', {
      timeout: 15_000,
    });

    await row.locator('[data-host-enabled]').click();
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state)
      .toBe('disabled');
    const wslDistros = (
      (await state(app)).settings as { hosts?: { wslDistros?: string[] | null } }
    ).hosts?.wslDistros;
    expect(wslDistros ?? []).not.toContain('Fake');
  } finally {
    await closeApp(app);
  }
});

test('a local workspace under the UNC root spawns the agent inside the distro', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const spawnLog = join(uncRoot, 'spawn.log');
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
    FAKE_WSL_SPAWN_LOG: spawnLog,
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: `node ${join(process.cwd(), 'out/fixtures/fakeAcpAgent.cjs')}`,
    FAKE_WSL_DEVIN_CMD: `node ${join(process.cwd(), 'out/fixtures/fakeAcpAgent.cjs')}`,
  });
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');
    const added = await app.evaluate(
      (_e, path: string) => (globalThis as any).__agentworkspace.localAddWorkspace(path),
      `${uncRoot}\\home\\u\\ws`,
    );
    expect(added).toBeTruthy();
    await expect
      .poll(
        () => {
          if (!existsSync(spawnLog)) return null;
          return readFileSync(spawnLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { argv: string[]; cwd: string | null })
            .find((entry) => entry.argv.includes('acp'));
        },
        { timeout: 15_000 },
      )
      .toMatchObject({ cwd: '/home/u/ws' });
  } finally {
    await closeApp(app);
  }
});

test('terminal-owned wsl session reloads history on transcript change', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: `node ${join(process.cwd(), 'out/fixtures/fakePty.cjs')}`,
  });
  const shell = await shellPage(app);
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__agentworkspace.claudeNewSession(cwd),
      `${uncRoot}\\home\\u\\proj`,
    )) as string;
    const opened = (await app.evaluate(
      (_e, sessionId: string) =>
        (globalThis as any).__agentworkspace.claudeTerminalOpen(sessionId),
      id,
    )) as { ok: boolean };
    expect(opened.ok).toBe(true);
    await app.evaluate(
      (_e, sessionId: string) => (globalThis as any).__agentworkspace.claudeSelect(sessionId),
      id,
    );

    // Write the transcript inside the distro — the helper watch reports it
    // (projects/ did not exist yet: its 5 s root retry) and the terminal-owned
    // chat reloads over store.messages.
    const projectDir = join(uncRoot, 'home', 'u', '.claude', 'projects', '-home-u-proj');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${id}.jsonl`),
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: 'wsl transcript line' },
        uuid: 'f6f6f6f6-0000-4000-8000-000000000001',
        timestamp: new Date().toISOString(),
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/home/u/proj',
        sessionId: id,
        version: '2.1.302',
        gitBranch: 'main',
      }) + '\n',
    );
    await expect(shell.locator('#messageList')).toContainText('wsl transcript line', {
      timeout: 15_000,
    });
  } finally {
    await closeApp(app);
  }
});

test('a local transcript change re-lists only the local host', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
  });
  const logFile = join(profile, 'events.jsonl');
  const lists = async (source: string) =>
    (await readEvents(logFile))
      .filter(
        (e) =>
          e.event === 'claude-list' &&
          (e.detail as { source?: string } | undefined)?.source === source,
      )
      .map((e) => e.detail as { listedHosts?: number; skippedHosts?: string[] });
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    // WSL work is gated on the helper channel (fsReady), which lands after the probe.
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.helper?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    // Positive control: a full refresh lists both hosts.
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeRefresh());
    await expect
      .poll(async () => (await lists('test')).at(-1)?.listedHosts, { timeout: 10_000 })
      .toBe(2);
    const before = (await lists('watch')).length;
    const id = '22222222-0000-4000-8000-0000000000aa';
    writeFileSync(
      join(claudeHome, 'projects', 'C--work-alpha', `${id}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'local line' },
        uuid: '22222222-0000-4000-8000-0000000000ab',
        timestamp: new Date().toISOString(),
        cwd: 'C:\\work\\alpha',
        sessionId: id,
      }) + '\n',
    );
    await expect.poll(async () => (await lists('watch')).length, { timeout: 10_000 }).toBeGreaterThan(before);
    const watchList = (await lists('watch')).at(-1)!;
    expect(watchList.listedHosts).toBe(1);
    expect(watchList.skippedHosts).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

// --- background work must stop when a distro is not usable ---------------------

const hostExecs = async (logFile: string, host: string, kind?: string) =>
  (await readEvents(logFile)).filter((e) => {
    if (e.event !== 'host-exec') return false;
    const detail = e.detail as { host?: string; kind?: string } | undefined;
    return detail?.host === host && (kind === undefined || detail.kind === kind);
  }).length;

// `claude-agents` passes for one host (agents run inside the helper now, so
// they no longer show up as host-exec).
const agentPolls = async (logFile: string, host: string) =>
  (await readEvents(logFile)).filter(
    (e) => e.event === 'claude-agents' && (e.detail as { host?: string } | undefined)?.host === host,
  ).length;
const channelEvents = async (logFile: string, host: string) =>
  (await readEvents(logFile)).filter((e) => {
    const detail = e.detail as { host?: string; mode?: string; events?: number } | undefined;
    if (detail?.host !== host) return false;
    if (e.event === 'claude-patch') return true;
    return e.event === 'claude-watch' && detail.mode === 'channel' && (detail.events ?? 0) > 0;
  }).length;

let lineSeq = 0;
const transcriptLine = (id: string, cwd: string, text: string): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `f7f7f7f7-0000-4000-8000-${String(++lineSeq).padStart(12, '0')}`,
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: id,
    version: '2.1.302',
    gitBranch: 'main',
  }) + '\n';

test('disabling a distro stops its agents poll and store watch', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const projects = join(uncRoot, 'home', 'u', '.claude', 'projects');
  mkdirSync(join(projects, '-home-u-proj'), { recursive: true });
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
  });
  const logFile = join(profile, 'events.jsonl');
  const shell = await shellPage(app);
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    // Positive control: the agents poller runs `claude agents` in the helper.
    await expect.poll(() => agentPolls(logFile, 'wsl:Fake'), { timeout: 30_000 }).toBeGreaterThan(1);

    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const row = shell.locator('[data-host-id="wsl:Fake"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('[data-host-enabled]').click();
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state)
      .toBe('disabled');
    // Let an in-flight poll finish before taking the baseline.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const execs = await hostExecs(logFile, 'wsl:Fake');
    const polls = await agentPolls(logFile, 'wsl:Fake');
    const watches = await channelEvents(logFile, 'wsl:Fake');
    // A live helper watch would report this new external session.
    const id = '33333333-0000-4000-8000-0000000000aa';
    mkdirSync(join(projects, '-home-u-other'), { recursive: true });
    writeFileSync(
      join(projects, '-home-u-other', `${id}.jsonl`),
      transcriptLine(id, '/home/u/other', 'x'),
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await hostExecs(logFile, 'wsl:Fake')).toBe(execs);
    expect(await agentPolls(logFile, 'wsl:Fake')).toBe(polls);
    expect(await channelEvents(logFile, 'wsl:Fake')).toBe(watches);
  } finally {
    await closeApp(app);
  }
});

test('a stopped default distro is never probed, env-captured or exec-ed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const spawnLog = join(root, 'spawn.log');
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Stopped:default',
    FAKE_WSL_SPAWN_LOG: spawnLog,
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
  });
  const logFile = join(profile, 'events.jsonl');
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('stopped');
    // Several agents-poll intervals.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await hostExecs(logFile, 'wsl:Fake')).toBe(0);
    const dInvocations = existsSync(spawnLog)
      ? readFileSync(spawnLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .filter((line) => (JSON.parse(line) as { argv: string[] }).argv[1] === 'Fake')
      : [];
    expect(dInvocations).toEqual([]);
    expect((await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state).toBe('stopped');
  } finally {
    await closeApp(app);
  }
});

test('the agents poller skips a distro without claude', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_NO_CLAUDE: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
  });
  const logFile = join(profile, 'events.jsonl');
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    expect((await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.claude.path).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    // The one `exec` is the helper deploy; no poll ran `claude agents`.
    const deploys = (await readEvents(logFile)).filter((e) => e.event === 'host-helper-deploy').length;
    expect(await hostExecs(logFile, 'wsl:Fake', 'exec')).toBe(deploys);
    expect(await agentPolls(logFile, 'wsl:Fake')).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test('the helper watch surfaces a new external session and a transcript append as patches', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const projects = join(uncRoot, 'home', 'u', '.claude', 'projects');
  const existing = '44444444-0000-4000-8000-0000000000aa';
  mkdirSync(join(projects, '-home-u-proj'), { recursive: true });
  const existingFile = join(projects, '-home-u-proj', `${existing}.jsonl`);
  writeFileSync(existingFile, transcriptLine(existing, '/home/u/proj', 'first'));
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
  });
  const logFile = join(profile, 'events.jsonl');
  const lists = async () => (await readEvents(logFile)).filter((e) => e.event === 'claude-list').length;
  const patches = async () =>
    (await readEvents(logFile)).filter(
      (e) => e.event === 'claude-patch' && (e.detail as { host?: string }).host === 'wsl:Fake',
    ).length;
  const sessions = async () =>
    (
      (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeState())) as {
        sessions: { id: string; title: string }[];
      }
    ).sessions;
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('ready');
    await expect.poll(async () => (await sessions()).map((s) => s.id), { timeout: 30_000 }).toContain(existing);
    // Let the start-up lists settle.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const listsBefore = await lists();

    // (1) a new session in a new project dir.
    const before = await patches();
    const fresh = '44444444-0000-4000-8000-0000000000bb';
    mkdirSync(join(projects, '-home-u-other'), { recursive: true });
    writeFileSync(join(projects, '-home-u-other', `${fresh}.jsonl`), transcriptLine(fresh, '/home/u/other', 'new'));
    await expect.poll(async () => (await sessions()).map((s) => s.id), { timeout: 15_000 }).toContain(fresh);
    expect(await patches()).toBeGreaterThan(before);

    // (2) an append to an existing transcript (a rename line changes its title).
    appendFileSync(
      existingFile,
      `${JSON.stringify({ type: 'custom-title', customTitle: 'Appended title', sessionId: existing })}\n`,
    );
    await expect
      .poll(async () => (await sessions()).find((s) => s.id === existing)?.title, { timeout: 15_000 })
      .toBe('Appended title');
    // Neither change re-listed any host.
    expect(await lists()).toBe(listsBefore);
  } finally {
    await closeApp(app);
  }
});

// --- iteration 3: gh fallback, hooks opt-out, mid-run stop, autostart, envCaptureDisabled ---

const spawnLines = (spawnLog: string): string[][] =>
  existsSync(spawnLog)
    ? readFileSync(spawnLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    : [];

const hostState = async (app: ElectronApplication) =>
  (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state;

// Launch with a pre-seeded settings.json (autostart / overrides are read at start).
async function launchSeeded(settings: Record<string, unknown>, env: Record<string, string>) {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    ...env,
  });
  return { app, profile, logFile };
}

test('a distro that stops mid-run gets no background work after the next tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const distros = join(root, 'distros.txt');
  writeFileSync(distros, 'Fake:Running:default');
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS_FILE: distros,
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
    AGENT_WORKSPACE_TEST_ENUM_FRESH_MS: '500',
    AGENT_WORKSPACE_TEST_ENUM_BACKOFF_MS: '300',
  });
  const logFile = join(profile, 'events.jsonl');
  const work = async () =>
    (await hostExecs(logFile, 'wsl:Fake', 'probe')) +
    (await hostExecs(logFile, 'wsl:Fake', 'env')) +
    (await hostExecs(logFile, 'wsl:Fake', 'exec')) +
    (await hostExecs(logFile, 'wsl:Fake', 'helper')) +
    (await agentPolls(logFile, 'wsl:Fake'));
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('ready');
    await expect.poll(() => agentPolls(logFile, 'wsl:Fake'), { timeout: 30_000 }).toBeGreaterThan(1);
    // `wsl --terminate Fake` / a VM crash: the helper dies with the distro.
    writeFileSync(distros, 'Fake:Stopped:default');
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), 'wsl:Fake');
    // The agents tick itself never re-lists (it rides the channel); the
    // periodic / focus re-list notices the stop.
    // Re-triggered per attempt: one list may land inside a failure backoff.
    await expect
      .poll(
        async () => {
          await app.evaluate(() => (globalThis as any).__agentworkspace.hostEnumerateIfStale());
          return hostState(app);
        },
        { timeout: 15_000 },
      )
      .toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const baseline = await work();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await work()).toBe(baseline);
  } finally {
    await closeApp(app);
  }
});

test('the gh PR-state fallback never runs in a stopped distro', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const distros = join(uncRoot, 'distros.txt');
  const spawnLog = join(uncRoot, 'spawn.log');
  writeFileSync(distros, 'Fake:Running:default');
  const projects = join(uncRoot, 'home', 'u', '.claude', 'projects');
  const sessionId = '55555555-0000-4000-8000-0000000000aa';
  mkdirSync(join(projects, '-home-u-proj'), { recursive: true });
  writeFileSync(
    join(projects, '-home-u-proj', `${sessionId}.jsonl`),
    transcriptLine(sessionId, '/home/u/proj', 'pr session'),
  );
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS_FILE: distros,
    FAKE_WSL_SPAWN_LOG: spawnLog,
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_ENUM_FRESH_MS: '300',
    AGENT_WORKSPACE_TEST_ENUM_BACKOFF_MS: '300',
  });
  const logFile = join(profile, 'events.jsonl');
  const ghRuns = () =>
    spawnLines(spawnLog).filter((argv) => argv.includes('gh') && argv.includes('pr')).length;
  const prTitleEvents = async () =>
    (await readEvents(logFile)).filter((e) => e.event === 'pr-title').length;
  const sessionIds = async () =>
    (
      (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeState())) as {
        sessions: { id: string }[];
      }
    ).sessions.map((s) => s.id);
  const record = (url: string) =>
    app.evaluate(
      (_e, a: { id: string; url: string }) =>
        (globalThis as any).__agentworkspace.claudeRecordPr(a.id, a.url),
      { id: sessionId, url },
    );
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('ready');
    await expect.poll(sessionIds, { timeout: 15_000 }).toContain(sessionId);
    // The gh fallback uses the registry entry's host: a first PR creates the
    // entry (host 'local'), the next re-list stamps the store row's host.
    await record(`${fixtures.githubUrl}/o/r/pull/100`);
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeRefresh());
    // Positive control: a fixture PR page carries no state, so it falls back to the distro's gh.
    await record(`${fixtures.githubUrl}/o/r/pull/1`);
    await expect.poll(ghRuns, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(prTitleEvents, { timeout: 15_000 }).toBeGreaterThan(0);

    writeFileSync(distros, 'Fake:Stopped:default');
    // A background PR-state refresh re-reads the enumeration; it never probes.
    // (The periodic re-list stands in when the refresh itself reaches no gh.)
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeRefreshPrStates());
    // Re-triggered per attempt: one list may land inside a failure backoff.
    await expect
      .poll(
        async () => {
          await app.evaluate(() => (globalThis as any).__agentworkspace.hostEnumerateIfStale());
          return hostState(app);
        },
        { timeout: 15_000 },
      )
      .toBe('stopped');
    const gh = ghRuns();
    const execs = await hostExecs(logFile, 'wsl:Fake');
    const titles = await prTitleEvents();
    await record(`${fixtures.githubUrl}/o/r/pull/2`);
    await expect.poll(prTitleEvents, { timeout: 15_000 }).toBeGreaterThan(titles);
    expect(ghRuns()).toBe(gh);
    expect(await hostExecs(logFile, 'wsl:Fake')).toBe(execs);
  } finally {
    await closeApp(app);
  }
});

test('turning hooks off removes our block from a disabled, running distro', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const claudeDir = join(uncRoot, 'home', 'u', '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsFile = join(claudeDir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ keepMe: true }, null, 2));
  // The UNC root is a different dir: a Windows-side write would land there.
  const otherUnc = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: otherUnc,
    FAKE_WSL_ROOT: uncRoot,
  });
  const logFile = join(profile, 'events.jsonl');
  const shell = await shellPage(app);
  const ours = () => readFileSync(settingsFile, 'utf8').includes('/agent-workspace/hook/');
  const helper = () =>
    app.evaluate(() => (globalThis as any).__agentworkspace.hostChannelState('wsl:Fake')?.state ?? null);
  try {
    await expect.poll(helper, { timeout: 30_000 }).toBe('ready');
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ claude: { hooksEnabled: true } })`,
    );
    await expect.poll(ours, { timeout: 15_000 }).toBe(true);

    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const row = shell.locator('[data-host-id="wsl:Fake"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('[data-host-enabled]').click();
    await expect.poll(() => hostState(app)).toBe('disabled');
    // The disabled distro's helper channel is stopped...
    await expect.poll(helper, { timeout: 10_000 }).not.toBe('ready');

    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ claude: { hooksEnabled: false } })`,
    );
    // ...so the opt-out runs the deployed helper once in --apply-hooks-off mode:
    // our block embeds the bearer token and must go everywhere.
    await expect.poll(ours, { timeout: 15_000 }).toBe(false);
    expect(readFileSync(settingsFile, 'utf8')).toContain('keepMe');
    const offs = (await readEvents(logFile)).filter((e) => e.event === 'host-hooks-off');
    expect(offs.map((e) => e.detail)).toEqual([{ host: 'wsl:Fake', ok: true, code: 0 }]);
    expect(existsSync(join(otherUnc, 'home', 'u', '.claude', 'settings.json'))).toBe(false);
    // Still disabled, and the one-shot run did not restart the channel.
    expect(await hostState(app)).toBe('disabled');
    expect(await helper()).not.toBe('ready');
  } finally {
    await closeApp(app);
  }
});

test('a failing hooks-off one-shot backs off: repeated status changes do not re-run it', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const claudeDir = join(uncRoot, 'home', 'u', '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsFile = join(claudeDir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ keepMe: true }, null, 2));
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
  });
  const logFile = join(profile, 'events.jsonl');
  const shell = await shellPage(app);
  const offs = async () =>
    (await readEvents(logFile))
      .filter((e) => e.event === 'host-hooks-off')
      .map((e) => (e.detail as { ok: boolean }).ok);
  const helper = () =>
    app.evaluate(() => (globalThis as any).__agentworkspace.hostChannelState('wsl:Fake')?.state ?? null);
  try {
    await expect.poll(helper, { timeout: 30_000 }).toBe('ready');
    await evaluateInShell(app, `window.agentworkspace.setSettings({ claude: { hooksEnabled: true } })`);
    await expect
      .poll(() => readFileSync(settingsFile, 'utf8').includes('/agent-workspace/hook/'), { timeout: 15_000 })
      .toBe(true);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const row = shell.locator('[data-host-id="wsl:Fake"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('[data-host-enabled]').click();
    await expect.poll(() => hostState(app)).toBe('disabled');
    // Hand-broken file: every removal run exits 1.
    writeFileSync(settingsFile, '{ not json');
    await evaluateInShell(app, `window.agentworkspace.setSettings({ claude: { hooksEnabled: false } })`);
    await expect.poll(offs, { timeout: 15_000 }).toEqual([false]);
    // Status-driven applies (what every host status change runs) inside the
    // 60 s backoff spawn nothing more.
    for (let i = 0; i < 5; i++) {
      await app.evaluate(() => (globalThis as any).__agentworkspace.claudeApplyHooks());
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await offs()).toEqual([false]);
    // A hooks setting change resets the backoff: the next opt-out runs again.
    writeFileSync(settingsFile, JSON.stringify({ keepMe: true }, null, 2));
    await evaluateInShell(app, `window.agentworkspace.setSettings({ claude: { hooksEnabled: true } })`);
    await evaluateInShell(app, `window.agentworkspace.setSettings({ claude: { hooksEnabled: false } })`);
    await expect.poll(offs, { timeout: 15_000 }).toEqual([false, true]);
  } finally {
    await closeApp(app);
  }
});

test('Devin Local autostart skips a workspace on a stopped distro', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const spawnLog = join(uncRoot, 'spawn.log');
  const workspace = `${uncRoot}\\home\\u\\ws`;
  const fakeAgent = `node ${join(process.cwd(), 'out/fixtures/fakeAcpAgent.cjs')}`;
  const { app, logFile } = await launchSeeded(
    { workspaces: [workspace] },
    {
      FAKE_WSL_DISTROS: 'Fake:Stopped:default',
      FAKE_WSL_SPAWN_LOG: spawnLog,
      AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
      FAKE_WSL_ROOT: uncRoot,
      AGENT_WORKSPACE_LOCAL_AGENT_CMD: fakeAgent,
      FAKE_WSL_DEVIN_CMD: fakeAgent,
    },
  );
  const autostart = async () =>
    (await readEvents(logFile)).find((e) => e.event === 'agents-autostart');
  try {
    await expect.poll(autostart, { timeout: 30_000 }).toBeTruthy();
    expect(((await autostart())!.detail as { skipped: number }).skipped).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(spawnLines(spawnLog).filter((argv) => argv[1] === 'Fake')).toEqual([]);
    expect(await hostExecs(logFile, 'wsl:Fake')).toBe(0);
    expect(await hostState(app)).toBe('stopped');
  } finally {
    await closeApp(app);
  }
});

test('envCaptureDisabled: the probe completes and an explicit refresh resolves', async () => {
  const { app } = await launchSeeded(
    { hosts: { overrides: { 'wsl:Fake': { envCaptureDisabled: true } } } },
    { FAKE_WSL_DISTROS: 'Fake:Running:default' },
  );
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('ready');
    const host = (await state(app)).hosts.find((h) => h.id === 'wsl:Fake');
    expect(host?.claude.path).toBeTruthy();
    expect(host?.shellEnv).toBeNull();
    const outcome = await app.evaluate(() =>
      Promise.race([
        (globalThis as any).__agentworkspace.hostRefresh('wsl:Fake').then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 15_000)),
      ]),
    );
    expect(outcome).toBe('resolved');
    expect(await hostState(app)).toBe('ready');
    const keys = (await app.evaluate(() =>
      (globalThis as any).__agentworkspace.hostShellEnvKeys('wsl:Fake'),
    )) as string[];
    expect(keys).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('an explicit start on a stopped distro re-reads its state promptly', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const distros = join(uncRoot, 'distros.txt');
  writeFileSync(distros, 'Fake:Stopped:default');
  const fakeAgent = `node ${join(process.cwd(), 'out/fixtures/fakeAcpAgent.cjs')}`;
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS_FILE: distros,
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_ROOT: uncRoot,
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: fakeAgent,
    FAKE_WSL_DEVIN_CMD: fakeAgent,
  });
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('stopped');
    // The user adds a workspace in that distro: the start boots it (the fake
    // can't boot, so flip the table the way the real distro would).
    writeFileSync(distros, 'Fake:Running:default');
    await app.evaluate(
      (_e, path: string) => (globalThis as any).__agentworkspace.localAddWorkspace(path),
      `${uncRoot}\\home\\u\\ws`,
    );
    await expect.poll(() => hostState(app), { timeout: 10_000 }).toBe('ready');
  } finally {
    await closeApp(app);
  }
});
