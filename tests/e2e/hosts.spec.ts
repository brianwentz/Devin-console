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

    // Write the transcript under the mapped UNC root — the tiered poller must
    // pick it up and reload the terminal-owned chat within ~5 s.
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
      timeout: 8_000,
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

test('a WSL transcript change does not trigger a full claude-list', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  // inotify mode: events carry file names; the projects dir must exist before
  // the watch (rooted at projects/) starts.
  const projectDir = join(uncRoot, 'home', 'u', '.claude', 'projects', '-home-u-proj');
  mkdirSync(projectDir, { recursive: true });
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_INOTIFY: '1',
    FAKE_WSL_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
  });
  const logFile = join(profile, 'events.jsonl');
  const inotifyEvents = async () =>
    (await readEvents(logFile)).filter(
      (e) =>
        e.event === 'claude-watch' &&
        (e.detail as { mode?: string; events?: number } | undefined)?.mode === 'inotify' &&
        ((e.detail as { events?: number }).events ?? 0) > 0,
    ).length;
  const watchLists = async () =>
    (await readEvents(logFile)).filter(
      (e) =>
        e.event === 'claude-list' &&
        (e.detail as { source?: string } | undefined)?.source === 'watch',
    ).length;
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__agentworkspace.claudeNewSession(cwd),
      `${uncRoot}\\home\\u\\proj`,
    )) as string;
    // The fake inotifywait is a node child: wait for the watcher, then give
    // its fs.watch time to arm before writing (else the event is missed).
    await expect
      .poll(
        async () =>
          (await readEvents(logFile)).some(
            (e) =>
              e.event === 'claude-watch' &&
              (e.detail as { mode?: string } | undefined)?.mode === 'inotify',
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // Not terminal-owned: a transcript append must not re-list over the UNC.
    const before = await watchLists();
    const seen = await inotifyEvents();
    writeFileSync(join(projectDir, `${id}.jsonl`), '{"type":"user"}\n');
    // Positive control: the change reached the store watcher...
    await expect.poll(inotifyEvents, { timeout: 10_000 }).toBeGreaterThan(seen);
    // The inotify watcher is a wsl.exe spawn and is counted too.
    expect(
      (await readEvents(logFile)).some(
        (e) => e.event === 'host-exec' && (e.detail as { kind?: string })?.kind === 'spawn',
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    // ...but did not trigger a full list.
    expect(await watchLists()).toBe(before);
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

test('disabling a distro stops its agents poll and change check', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const projects = join(uncRoot, 'home', 'u', '.claude', 'projects');
  mkdirSync(join(projects, '-home-u-proj'), { recursive: true });
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
    AGENT_WORKSPACE_TEST_WSL_CHANGE_CHECK_MS: '300',
  });
  const logFile = join(profile, 'events.jsonl');
  const shell = await shellPage(app);
  const wslWatch = async () =>
    (await readEvents(logFile)).filter((e) => {
      const detail = e.detail as { mode?: string; host?: string; events?: number } | undefined;
      return (
        e.event === 'claude-watch' &&
        detail?.mode === 'poll-wsl' &&
        detail.host === 'wsl:Fake' &&
        (detail.events ?? 0) > 0
      );
    }).length;
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    // Positive control: the agents poller runs `claude agents` through wsl.exe.
    await expect
      .poll(() => hostExecs(logFile, 'wsl:Fake', 'exec'), { timeout: 10_000 })
      .toBeGreaterThan(1);

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
    const watches = await wslWatch();
    // A live change check would notice this new external session.
    const id = '33333333-0000-4000-8000-0000000000aa';
    mkdirSync(join(projects, '-home-u-other'), { recursive: true });
    writeFileSync(
      join(projects, '-home-u-other', `${id}.jsonl`),
      transcriptLine(id, '/home/u/other', 'x'),
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await hostExecs(logFile, 'wsl:Fake')).toBe(execs);
    expect(await wslWatch()).toBe(watches);
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
    expect(await hostExecs(logFile, 'wsl:Fake', 'exec')).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test('the WSL change check surfaces a new external session and a transcript append', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const projects = join(uncRoot, 'home', 'u', '.claude', 'projects');
  const existing = '44444444-0000-4000-8000-0000000000aa';
  mkdirSync(join(projects, '-home-u-proj'), { recursive: true });
  const existingFile = join(projects, '-home-u-proj', `${existing}.jsonl`);
  writeFileSync(existingFile, transcriptLine(existing, '/home/u/proj', 'first'));
  // inotify stays off (FAKE_WSL_INOTIFY unset) → tiered poll + change check.
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    AGENT_WORKSPACE_TEST_WSL_CHANGE_CHECK_MS: '500',
  });
  const logFile = join(profile, 'events.jsonl');
  const watchLists = async () =>
    (await readEvents(logFile))
      .filter(
        (e) =>
          e.event === 'claude-list' &&
          (e.detail as { source?: string } | undefined)?.source === 'watch',
      )
      .map((e) => e.detail as { listedHosts?: number });
  const sessionIds = async () =>
    (
      (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeState())) as {
        sessions: { id: string }[];
      }
    ).sessions.map((s) => s.id);
  try {
    await expect
      .poll(async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state, {
        timeout: 30_000,
      })
      .toBe('ready');
    await expect.poll(sessionIds, { timeout: 15_000 }).toContain(existing);
    // Let the first snapshots (taken while the initial rows land) settle.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // (1) a new session in a new project dir → a project-dir change.
    const before = (await watchLists()).length;
    const fresh = '44444444-0000-4000-8000-0000000000bb';
    mkdirSync(join(projects, '-home-u-other'), { recursive: true });
    writeFileSync(
      join(projects, '-home-u-other', `${fresh}.jsonl`),
      transcriptLine(fresh, '/home/u/other', 'new'),
    );
    await expect
      .poll(async () => (await watchLists()).length, { timeout: 10_000 })
      .toBeGreaterThan(before);
    expect((await watchLists()).at(-1)?.listedHosts).toBe(1);
    await expect.poll(sessionIds, { timeout: 10_000 }).toContain(fresh);

    // (2) an append to an existing (newest-5) transcript — dir mtimes unchanged.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const beforeAppend = (await watchLists()).length;
    appendFileSync(existingFile, transcriptLine(existing, '/home/u/proj', 'second'));
    await expect
      .poll(async () => (await watchLists()).length, { timeout: 10_000 })
      .toBeGreaterThan(beforeAppend);
    expect((await watchLists()).at(-1)?.listedHosts).toBe(1);
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
  });
  const logFile = join(profile, 'events.jsonl');
  const work = async () =>
    (await hostExecs(logFile, 'wsl:Fake', 'probe')) +
    (await hostExecs(logFile, 'wsl:Fake', 'env')) +
    (await hostExecs(logFile, 'wsl:Fake', 'exec'));
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('ready');
    await expect
      .poll(() => hostExecs(logFile, 'wsl:Fake', 'exec'), { timeout: 10_000 })
      .toBeGreaterThan(1);
    // `wsl --terminate Fake` / a VM crash: nothing else in the app changes.
    writeFileSync(distros, 'Fake:Stopped:default');
    // The next background tick re-reads the (stale) enumeration first.
    await expect.poll(() => hostState(app), { timeout: 10_000 }).toBe('stopped');
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
    AGENT_WORKSPACE_TEST_ENUM_FRESH_MS: '300',
    // The agents tick also re-reads the table, so the stop is noticed even
    // when the gh path itself doesn't re-enumerate.
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
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
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeRefreshPrStates());
    await expect.poll(() => hostState(app), { timeout: 10_000 }).toBe('stopped');
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
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
  });
  const shell = await shellPage(app);
  const ours = () => readFileSync(settingsFile, 'utf8').includes('/agent-workspace/hook/');
  try {
    await expect.poll(() => hostState(app), { timeout: 30_000 }).toBe('ready');
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

    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ claude: { hooksEnabled: false } })`,
    );
    // Our block embeds the bearer token: opting out must remove it everywhere.
    await expect.poll(ours, { timeout: 15_000 }).toBe(false);
    expect(readFileSync(settingsFile, 'utf8')).toContain('keepMe');
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
