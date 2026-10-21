import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchWithClaudeFixture, readEvents, shellPage, state } from './helpers';

// Helper channel (P1 Task 8): the fake wsl.exe runs the REAL built helper
// bundle under FAKE_WSL_ROOT over piped stdio — deploy, hello, liveness,
// breaker and exit-86 redeploy are exercised end to end.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const HOST = 'wsl:Fake';
const hash = (): string =>
  (JSON.parse(readFileSync(join(process.cwd(), 'out/helper/helper-hash.json'), 'utf8')) as { hash: string }).hash;
const deployedFile = (root: string): string =>
  join(root, 'home', 'u', '.agent-workspace', `helper-${hash()}.mjs`);

type ChannelInfo = { state: string; failures: number; open: boolean; running: boolean } | null;
const channelState = (app: ElectronApplication) =>
  app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostChannelState(id), HOST) as Promise<ChannelInfo>;
const helperState = async (app: ElectronApplication) => (await channelState(app))?.state ?? null;
const hostRow = async (app: ElectronApplication) => (await state(app)).hosts.find((h) => h.id === HOST);

const spawnLines = (spawnLog: string): string[][] =>
  existsSync(spawnLog)
    ? readFileSync(spawnLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    : [];
// The helper launch line is `test -f "$0" || exit 86; exec node "$0" --stdio`.
const launches = (spawnLog: string): number =>
  spawnLines(spawnLog).filter((argv) => argv.some((a) => a.includes('exit 86;'))).length;
const envCaptures = (spawnLog: string): number =>
  spawnLines(spawnLog).filter((argv) => argv.some((a) => a.includes('__DW_ENV__'))).length;

const helperEvents = async (logFile: string) =>
  (await readEvents(logFile))
    .filter((e) => e.event === 'host-helper')
    .map((e) => e.detail as { host: string; state: string; reason?: string });

// The log of the most recent launch: a failing test appends its host-list
// `ok` sequence (load flakes are usually a failed/slow enumeration).
let lastLogFile: string | null = null;

async function withListTrace(error: unknown): Promise<unknown> {
  if (!lastLogFile || !(error instanceof Error)) return error;
  const seq = (await readEvents(lastLogFile).catch(() => []))
    .filter((e) => e.event === 'host-list')
    .map((e) => (e.detail as { ok?: boolean }).ok);
  error.message += `\nhost-list ok sequence: ${JSON.stringify(seq)}`;
  return error;
}

async function launch(env: Record<string, string>) {
  const root = env.FAKE_WSL_ROOT ?? mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const spawnLog = join(root, 'spawn.log');
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_ROOT: root,
    FAKE_WSL_SPAWN_LOG: spawnLog,
    AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS: '300',
    // One failed list under load must not block re-enumeration for the
    // production 60 s backoff; backoff tests set their own value.
    AGENT_WORKSPACE_TEST_ENUM_BACKOFF_MS: '300',
    ...env,
  });
  lastLogFile = join(profile, 'events.jsonl');
  return { app, profile, root, spawnLog, logFile: lastLogFile };
}

test('deploy then hello → helper ready', async () => {
  const { app, root, logFile } = await launch({});
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(existsSync(deployedFile(root))).toBe(true);
    const deploys = (await readEvents(logFile)).filter((e) => e.event === 'host-helper-deploy');
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.detail).toMatchObject({ host: HOST, ok: true });
    expect((deploys[0]!.detail as { bytes: number }).bytes).toBeGreaterThan(0);
    // ShellState carries the channel's status; fsReady follows the channel.
    await expect.poll(async () => (await hostRow(app))?.helper?.state).toBe('ready');
    const events = await helperEvents(logFile);
    expect(events.some((e) => e.state === 'ready' && e.reason === 'hello')).toBe(true);
    // Log detail is ids / enums only.
    for (const e of events) expect(Object.keys(e).sort()).toEqual(['host', 'reason', 'state']);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('bundle already present → no deploy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const first = await launch({ FAKE_WSL_ROOT: root });
  try {
    await expect.poll(() => helperState(first.app), { timeout: 30_000 }).toBe('ready');
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(first.app);
  }
  expect(existsSync(deployedFile(root))).toBe(true);
  const second = await launch({ FAKE_WSL_ROOT: root });
  try {
    await expect.poll(() => helperState(second.app), { timeout: 30_000 }).toBe('ready');
    const deploys = (await readEvents(second.logFile)).filter((e) => e.event === 'host-helper-deploy');
    expect(deploys).toEqual([]);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(second.app);
  }
});

test('killed helper reconnects', async () => {
  const { app, spawnLog, logFile } = await launch({});
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    const before = launches(spawnLog);
    const killed = await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST);
    expect(killed).toBe(true);
    await expect
      .poll(async () => (await helperEvents(logFile)).some((e) => e.state === 'reconnecting'), { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(launches(spawnLog)).toBe(before + 1);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('FAKE_WSL_HELPER_HANG → killed after silence → reconnect', async () => {
  const { app, spawnLog, logFile } = await launch({
    FAKE_WSL_HELPER_HANG: '1',
    // 600 ms silence → ping, 1.8 s → kill (the 15 s / 45 s ratio).
    AGENT_WORKSPACE_TEST_HELPER_SILENCE_MS: '600',
  });
  try {
    await expect
      .poll(async () => (await helperEvents(logFile)).some((e) => e.state === 'reconnecting' && e.reason === 'silence'), {
        timeout: 30_000,
      })
      .toBe(true);
    // The respawned helper says hello again (and hangs again).
    await expect
      .poll(async () => (await helperEvents(logFile)).filter((e) => e.state === 'ready').length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    expect(launches(spawnLog)).toBeGreaterThanOrEqual(2);
    // Hello-then-silence is a failed start every time: the breaker ends it.
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('degraded');
    expect(launches(spawnLog)).toBe(3);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('three failed starts → degraded, no further spawns', async () => {
  const { app, spawnLog } = await launch({ FAKE_WSL_NODE: join(tmpdir(), 'nonexistent', 'node.exe') });
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('degraded');
    expect(await channelState(app)).toMatchObject({ failures: 3, open: true });
    expect(launches(spawnLog)).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(launches(spawnLog)).toBe(3);
    expect(await helperState(app)).toBe('degraded');
    expect((await hostRow(app))?.helper?.state).toBe('degraded');
    // hosts:refresh closes the breaker and tries again.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostRefresh(id), HOST);
    await expect.poll(() => launches(spawnLog), { timeout: 10_000 }).toBeGreaterThan(3);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('helper file deleted while ready → exit 86 on respawn → redeploy → ready', async () => {
  const { app, root, logFile } = await launch({});
  const deployOk = async () =>
    (await readEvents(logFile)).filter(
      (e) => e.event === 'host-helper-deploy' && (e.detail as { ok: boolean }).ok,
    ).length;
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(await deployOk()).toBe(1);
    rmSync(deployedFile(root));
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST);
    await expect.poll(deployOk, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(existsSync(deployedFile(root))).toBe(true);
    expect((await helperEvents(logFile)).some((e) => e.reason === 'redeploy')).toBe(true);
    // Only the kill counted; the 86 itself did not.
    expect(await channelState(app)).toMatchObject({ failures: 1, open: false });
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('stopped distro is not respawned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const distros = join(root, 'distros.txt');
  writeFileSync(distros, 'Fake:Running:default');
  const { app, spawnLog } = await launch({
    FAKE_WSL_ROOT: root,
    FAKE_WSL_DISTROS_FILE: distros,
    // Background ticks re-read the table, so the stop is noticed promptly.
    AGENT_WORKSPACE_TEST_ENUM_FRESH_MS: '300',
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300',
  });
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    writeFileSync(distros, 'Fake:Stopped:default');
    await expect.poll(async () => (await hostRow(app))?.state, { timeout: 15_000 }).toBe('stopped');
    await expect.poll(() => helperState(app), { timeout: 10_000 }).toBe('reconnecting');
    expect((await channelState(app))?.running).toBe(false);
    const n = launches(spawnLog);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(launches(spawnLog)).toBe(n);
    expect(await helperState(app)).toBe('reconnecting');
    // Some other actor boots it: the next enumeration resets and starts again.
    writeFileSync(distros, 'Fake:Running:default');
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(launches(spawnLog)).toBe(n + 1);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('FAKE_WSL_NO_NODE → node-missing + #hostHelperHint', async () => {
  const { app, root, spawnLog, logFile } = await launch({ FAKE_WSL_NO_NODE: '1' });
  try {
    await expect.poll(async () => (await hostRow(app))?.helper?.state, { timeout: 30_000 }).toBe('node-missing');
    expect(await channelState(app)).toBeNull();
    expect(launches(spawnLog)).toBe(0);
    expect(existsSync(deployedFile(root))).toBe(false);
    expect((await readEvents(logFile)).filter((e) => e.event === 'host-helper-deploy')).toEqual([]);
    const shell = await shellPage(app);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const hint = shell.locator(`[id="hostHelperHint-${HOST}"]`);
    await expect(hint).toBeVisible({ timeout: 10_000 });
    await expect(hint).toContainText('Node 18 or newer is required');
    await expect(shell.locator(`[data-host-id="${HOST}"] [data-host-helper]`)).toHaveAttribute(
      'data-host-helper',
      'node-missing',
    );
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('env.get feeds spawnOn — no -ilc env-capture spawn after ready', async () => {
  // spawnOn's consumer here is the Devin Local agent (`devin acp` in the
  // distro); `claude agents` no longer spawns — it runs inside the helper.
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const fakeAgent = `node ${join(process.cwd(), 'out/fixtures/fakeAcpAgent.cjs')}`;
  const { app, spawnLog, logFile } = await launch({
    FAKE_WSL_ROOT: root,
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: root,
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: fakeAgent,
    FAKE_WSL_DEVIN_CMD: fakeAgent,
  });
  const agentRuns = () => spawnLines(spawnLog).filter((argv) => argv.includes('acp'));
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    // env.get landed: the spawn env now comes from the helper.
    await expect
      .poll(
        async () =>
          (await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostShellEnvKeys(id), HOST)) as string[],
        { timeout: 10_000 },
      )
      .toContain('FAKE_WSL_HELPER');
    const keys = (await app.evaluate(
      (_e, id: string) => (globalThis as any).__agentworkspace.hostShellEnvKeys(id),
      HOST,
    )) as string[];
    // WSL_ENV_DENYLIST vars are never replayed.
    for (const denied of ['WSL_INTEROP', 'WSLENV', 'PWD', 'SHLVL', 'TERM']) expect(keys).not.toContain(denied);
    const captures = envCaptures(spawnLog);
    const runsBefore = agentRuns().length;
    await app.evaluate(
      (_e, path: string) => (globalThis as any).__agentworkspace.localAddWorkspace(path),
      `${root}\\home\\u\\ws`,
    );
    await expect.poll(() => agentRuns().length, { timeout: 15_000 }).toBeGreaterThan(runsBefore);
    const fresh = agentRuns().slice(runsBefore);
    expect(fresh.every((argv) => argv.includes('FAKE_WSL_HELPER=1'))).toBe(true);
    // Later background work still runs no new interactive-login capture.
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh());
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(envCaptures(spawnLog)).toBe(captures);
    const channelEnv = (await readEvents(logFile)).filter(
      (e) => e.event === 'host-env' && (e.detail as { source?: string }).source === 'channel',
    );
    expect(channelEnv.length).toBeGreaterThanOrEqual(1);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

// Fix round 1: the channel's own respawn re-checks the distro (G15 / review
// focus #2) and a degraded channel resets when its distro comes back (R19a).
const flipAndEnumerate = async (app: ElectronApplication, distros: string, spec: string) => {
  writeFileSync(distros, spec);
  // The agents poll's backgroundReady re-reads the (stale) table.
  await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh());
};

const flipEnv = (root: string, distros: string, extra: Record<string, string> = {}) => ({
  FAKE_WSL_ROOT: root,
  FAKE_WSL_DISTROS_FILE: distros,
  AGENT_WORKSPACE_TEST_ENUM_FRESH_MS: '300',
  // Nothing re-enumerates on its own; only the respawn gate or an explicit poll.
  AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '600000',
  ...extra,
});

const flipRoot = (): { root: string; distros: string } => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const distros = join(root, 'distros.txt');
  writeFileSync(distros, 'Fake:Running:default');
  return { root, distros };
};

test('a helper killed by a distro stop is not respawned into the stopped distro', async () => {
  const { root, distros } = flipRoot();
  const { app, spawnLog, logFile } = await launch(flipEnv(root, distros));
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    const n = launches(spawnLog);
    // `wsl --terminate Fake`: the table says Stopped and the helper dies.
    writeFileSync(distros, 'Fake:Stopped:default');
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST);
    await expect
      .poll(async () => (await helperEvents(logFile)).some((e) => e.reason === 'distro-unavailable'), {
        timeout: 15_000,
      })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(launches(spawnLog)).toBe(n);
    expect((await channelState(app))?.running).toBe(false);
    await flipAndEnumerate(app, distros, 'Fake:Running:default');
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(launches(spawnLog)).toBe(n + 1);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('a degraded helper resets when its distro stops and runs again', async () => {
  const { root, distros } = flipRoot();
  const { app, spawnLog } = await launch(
    flipEnv(root, distros, { FAKE_WSL_NODE: join(tmpdir(), 'nonexistent', 'node.exe') }),
  );
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('degraded');
    expect(launches(spawnLog)).toBe(3);
    await flipAndEnumerate(app, distros, 'Fake:Stopped:default');
    await expect.poll(async () => (await hostRow(app))?.state, { timeout: 15_000 }).toBe('stopped');
    expect(launches(spawnLog)).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await flipAndEnumerate(app, distros, 'Fake:Running:default');
    await expect.poll(() => launches(spawnLog), { timeout: 15_000 }).toBeGreaterThan(3);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test("Settings shows a stopped distro's helper as paused", async () => {
  const { root, distros } = flipRoot();
  const { app } = await launch(flipEnv(root, distros));
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    const shell = await shellPage(app);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const helper = shell.locator(`[data-host-id="${HOST}"] [data-host-helper]`);
    await expect(helper).toContainText('ready', { timeout: 10_000 });
    await flipAndEnumerate(app, distros, 'Fake:Stopped:default');
    await expect(helper).toContainText('paused (distro stopped)', { timeout: 15_000 });
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

const enumRuns = async (logFile: string) =>
  (await readEvents(logFile)).filter(
    (e) => e.event === 'host-exec' && (e.detail as { kind?: string }).kind === 'enum',
  ).length;
const focusWindow = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => {
    BaseWindow.getAllWindows()[0]?.emit('focus');
  });

test('a timed-out wsl -l -v keeps the hosts and the live helper; backs off; the respawn gate refuses', async () => {
  const { root, distros } = flipRoot();
  const { app, spawnLog, logFile } = await launch(
    flipEnv(root, distros, {
      AGENT_WORKSPACE_TEST_ENUM_TIMEOUT_MS: '1000',
      AGENT_WORKSPACE_TEST_ENUM_BACKOFF_MS: '8000',
    }),
  );
  const listOutcomes = async () =>
    (await readEvents(logFile))
      .filter((e) => e.event === 'host-list')
      .map((e) => (e.detail as { ok?: boolean }).ok);
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    const n = launches(spawnLog);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A wedged VM: `wsl -l -v` hangs until the 1 s test timeout kills it.
    await flipAndEnumerate(app, distros, 'FAIL');
    await expect.poll(async () => (await listOutcomes()).includes(false), { timeout: 15_000 }).toBe(true);
    // The host row survives and the running helper is left alone.
    expect((await hostRow(app))?.state).toBe('ready');
    expect(await helperState(app)).toBe('ready');
    // Inside the failure backoff, focus and background checks don't re-run the list.
    const runs = await enumRuns(logFile);
    for (let i = 0; i < 5; i++) {
      await focusWindow(app);
      await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh());
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await enumRuns(logFile)).toBe(runs);
    // While the latest list failed, a dead helper is not respawned (the gate
    // runs its own fresh list, which fails too).
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST);
    await expect
      .poll(async () => (await helperEvents(logFile)).some((e) => e.reason === 'distro-unavailable'), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(launches(spawnLog)).toBe(n);
    expect((await hostRow(app))?.state).toBe('ready');
    // The VM recovers; once the (doubled, 16 s) backoff has passed the next
    // background check re-lists and brings the helper back.
    writeFileSync(distros, 'Fake:Running:default');
    await new Promise((resolve) => setTimeout(resolve, 16_500));
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh());
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(launches(spawnLog)).toBe(n + 1);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('no installed distros (wsl -l exits non-zero) is a cached empty list: focus does not re-run it', async () => {
  const { app, logFile } = await launch({ FAKE_WSL_DISTROS: 'NONE' });
  try {
    await expect
      .poll(
        async () =>
          (await readEvents(logFile)).some(
            (e) => e.event === 'host-list' && (e.detail as { ok?: boolean }).ok === true,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const runs = await enumRuns(logFile);
    expect(runs).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 5; i++) {
      await focusWindow(app);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await enumRuns(logFile)).toBe(runs);
    expect((await readEvents(logFile)).some((e) => e.event === 'host-list' && (e.detail as { ok?: boolean }).ok === false)).toBe(false);
    expect((await state(app)).hosts.map((h) => h.id)).toEqual(['local']);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

// --- P1 Task 9: the Claude store, history, hooks and agents over the channel ---
// FAKE_WSL_ROOT (what the helper sees) and the UNC root (what a Windows-side
// \\wsl.localhost read would see) are DIFFERENT dirs: anything the app finds
// can only have come over the channel.

const STORE_ID = '99999999-0000-4000-8000-0000000000a1';
let storeSeq = 0;
const storeLine = (id: string, cwd: string, text: string): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `99999999-0000-4000-8000-${String(++storeSeq).padStart(12, '0')}`,
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: id,
    version: '2.1.302',
    gitBranch: 'main',
  }) + '\n';

type StoreRow = { id: string; host: string; title: string };
const claudeRows = async (app: ElectronApplication): Promise<StoreRow[]> =>
  ((await app.evaluate(() => (globalThis as any).__agentworkspace.claudeState())) as { sessions: StoreRow[] })
    .sessions;
const wslRow = async (app: ElectronApplication, id: string) =>
  (await claudeRows(app)).find((s) => s.id === id && s.host === HOST) ?? null;

async function launchStore(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const projectDir = join(root, 'home', 'u', '.claude', 'projects', '-home-u-proj');
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${STORE_ID}.jsonl`);
  writeFileSync(transcript, storeLine(STORE_ID, '/home/u/proj', 'hello from the distro'));
  const launched = await launch({ FAKE_WSL_ROOT: root, AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot, ...extra });
  return { ...launched, uncRoot, projectDir, transcript };
}

const listsOf = async (logFile: string) =>
  (await readEvents(logFile)).filter((e) => e.event === 'claude-list').length;
const patchesOf = async (logFile: string) =>
  (await readEvents(logFile))
    .filter((e) => e.event === 'claude-patch')
    .map((e) => e.detail as { host: string; updated: number; removed: number });

test('WSL sessions list via the channel', async () => {
  const { app, logFile } = await launchStore();
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 15_000 }).not.toBeNull();
    expect((await wslRow(app, STORE_ID))?.title).toContain('hello from the distro');
    const lists = (await readEvents(logFile))
      .filter((e) => e.event === 'claude-store-list')
      .map((e) => e.detail as Record<string, unknown>);
    expect(lists.some((d) => d.host === HOST && (d.count as number) >= 1)).toBe(true);
    for (const d of lists) expect(Object.keys(d).sort()).toEqual(['count', 'host', 'ms']);
    // The store watch is the helper's: no UNC poll/inotify watcher any more.
    const watches = (await readEvents(logFile))
      .filter((e) => e.event === 'claude-watch' && (e.detail as { host?: string }).host === HOST)
      .map((e) => (e.detail as { mode: string }).mode);
    expect(watches.length).toBeGreaterThan(0);
    expect(new Set(watches)).toEqual(new Set(['channel']));
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('transcript append patches one row — no full claude-list', async () => {
  const { app, logFile, transcript } = await launchStore();
  try {
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 30_000 }).not.toBeNull();
    // Let start-up lists (start / hosts / env) settle before the baseline.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const lists = await listsOf(logFile);
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'custom-title', customTitle: 'Patched in the distro', sessionId: STORE_ID })}\n`,
    );
    await expect
      .poll(async () => (await wslRow(app, STORE_ID))?.title, { timeout: 15_000 })
      .toBe('Patched in the distro');
    expect((await patchesOf(logFile)).some((p) => p.host === HOST && p.updated === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await listsOf(logFile)).toBe(lists);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('deleted WSL transcript removes its row', async () => {
  const { app, logFile, transcript } = await launchStore();
  try {
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 30_000 }).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const lists = await listsOf(logFile);
    rmSync(transcript);
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 15_000 }).toBeNull();
    expect((await patchesOf(logFile)).some((p) => p.host === HOST && p.removed === 1)).toBe(true);
    expect(await listsOf(logFile)).toBe(lists);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

const storeListsFor = async (logFile: string, host: string) =>
  (await readEvents(logFile)).filter(
    (e) => e.event === 'claude-store-list' && (e.detail as { host?: string }).host === host,
  ).length;

test('a respawned helper is re-subscribed: one store list after ready, then appends patch', async () => {
  const { app, logFile, transcript } = await launchStore();
  try {
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 30_000 }).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const listsBefore = await storeListsFor(logFile, HOST);
    const readyBefore = (await helperEvents(logFile)).filter((e) => e.state === 'ready').length;
    expect(await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST)).toBe(
      true,
    );
    await expect
      .poll(async () => (await helperEvents(logFile)).filter((e) => e.state === 'ready').length, { timeout: 30_000 })
      .toBeGreaterThan(readyBefore);
    // The returning host is listed in full exactly once (the store's resync)...
    await expect.poll(() => storeListsFor(logFile, HOST), { timeout: 15_000 }).toBe(listsBefore + 1);
    // ...and the new helper got watch.subscribe again: an append patches the row.
    const patches = (await patchesOf(logFile)).length;
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'custom-title', customTitle: 'After respawn', sessionId: STORE_ID })}\n`,
    );
    await expect.poll(async () => (await wslRow(app, STORE_ID))?.title, { timeout: 15_000 }).toBe('After respawn');
    expect((await patchesOf(logFile)).length).toBeGreaterThan(patches);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await storeListsFor(logFile, HOST)).toBe(listsBefore + 1);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test("one distro's helper flapping never re-lists another distro", async () => {
  const OTHER = 'wsl:Second';
  const { app, logFile } = await launchStore({ FAKE_WSL_DISTROS: 'Fake:Running:default,Second:Running' });
  const channel = (id: string) =>
    app.evaluate((_e, h: string) => (globalThis as any).__agentworkspace.hostChannelState(h)?.state ?? null, id);
  try {
    await expect.poll(() => channel(HOST), { timeout: 30_000 }).toBe('ready');
    await expect.poll(() => channel(OTHER), { timeout: 30_000 }).toBe('ready');
    await expect.poll(() => storeListsFor(logFile, OTHER), { timeout: 15_000 }).toBeGreaterThan(0);
    // Let start-up (env.get publishes, hooks) settle.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const other = await storeListsFor(logFile, OTHER);
    for (let i = 0; i < 2; i++) {
      const readyBefore = (await helperEvents(logFile)).filter((e) => e.host === HOST && e.state === 'ready').length;
      await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST);
      await expect
        .poll(async () => (await helperEvents(logFile)).filter((e) => e.host === HOST && e.state === 'ready').length, {
          timeout: 30_000,
        })
        .toBeGreaterThan(readyBefore);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await storeListsFor(logFile, OTHER)).toBe(other);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('WSL history loads via store.messages', async () => {
  const { app } = await launchStore();
  try {
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 30_000 }).not.toBeNull();
    const shell = await shellPage(app);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.claudeSelect(id), STORE_ID);
    await expect(shell.locator('#messageList')).toContainText('hello from the distro', { timeout: 15_000 });
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('rename/delete via the channel', async () => {
  const { app, transcript } = await launchStore();
  try {
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 30_000 }).not.toBeNull();
    await app.evaluate(
      (_e, id: string) => (globalThis as any).__agentworkspace.claudeRename(id, 'Renamed over the channel'),
      STORE_ID,
    );
    await expect
      .poll(async () => (await wslRow(app, STORE_ID))?.title, { timeout: 15_000 })
      .toBe('Renamed over the channel');
    expect(readFileSync(transcript, 'utf8')).toContain('Renamed over the channel');
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.claudeDeleteTranscript(id), STORE_ID);
    await expect.poll(() => existsSync(transcript), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 15_000 }).toBeNull();
    const mutations = (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeMutations())) as {
      op: string;
    }[];
    expect(mutations.map((m) => m.op)).toEqual(expect.arrayContaining(['rename', 'sessionDeleteTranscript']));
    const snapshot = (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeState())) as {
      lastError: unknown;
    };
    expect(snapshot.lastError).toBeNull();
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('background agents list for WSL via the channel', async () => {
  const agents = JSON.stringify([
    {
      pid: 4242,
      id: 'bg-wsl-1',
      cwd: '/home/u/proj',
      kind: 'background',
      startedAt: Date.now(),
      sessionId: STORE_ID,
      name: 'wsl agent',
      status: 'busy',
      state: 'working',
    },
  ]);
  const { app, spawnLog } = await launchStore({ FAKE_CLAUDE_AGENTS: agents });
  const wslAgent = async () =>
    (
      (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgents())) as {
        id: string;
        host: string;
      }[]
    ).find((a) => a.id === 'bg-wsl-1')?.host ?? null;
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh());
    await expect.poll(wslAgent, { timeout: 15_000 }).toBe(HOST);
    // No `wsl.exe … claude agents` spawn: it ran inside the helper.
    expect(spawnLines(spawnLog).filter((argv) => argv.includes('agents'))).toEqual([]);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});

test('Reveal transcript on a WSL session calls showItemInFolder with the \\\\wsl.localhost path', async () => {
  const { app, uncRoot } = await launchStore();
  const revealed = () =>
    app.evaluate(() => (globalThis as any).__agentworkspace.claudeRevealed()) as Promise<string[]>;
  try {
    await expect.poll(() => wslRow(app, STORE_ID), { timeout: 30_000 }).not.toBeNull();
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.claudeRevealTranscript(id), STORE_ID);
    // The UNC root stands in for \\wsl.localhost\Fake (the windowsPath seam).
    await expect
      .poll(revealed, { timeout: 10_000 })
      .toEqual([join(uncRoot, 'home', 'u', '.claude', 'projects', '-home-u-proj', `${STORE_ID}.jsonl`)]);
  } catch (error) {
    throw await withListTrace(error);
  } finally {
    await closeApp(app);
  }
});
