import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function launch(env: Record<string, string>) {
  const root = env.FAKE_WSL_ROOT ?? mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const spawnLog = join(root, 'spawn.log');
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_ROOT: root,
    FAKE_WSL_SPAWN_LOG: spawnLog,
    AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS: '300',
    ...env,
  });
  return { app, profile, root, spawnLog, logFile: join(profile, 'events.jsonl') };
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
  } finally {
    await closeApp(app);
  }
});

test('bundle already present → no deploy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-helper-'));
  const first = await launch({ FAKE_WSL_ROOT: root });
  try {
    await expect.poll(() => helperState(first.app), { timeout: 30_000 }).toBe('ready');
  } finally {
    await closeApp(first.app);
  }
  expect(existsSync(deployedFile(root))).toBe(true);
  const second = await launch({ FAKE_WSL_ROOT: root });
  try {
    await expect.poll(() => helperState(second.app), { timeout: 30_000 }).toBe('ready');
    const deploys = (await readEvents(second.logFile)).filter((e) => e.event === 'host-helper-deploy');
    expect(deploys).toEqual([]);
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
  } finally {
    await closeApp(app);
  }
});

test('env.get feeds spawnOn — no -ilc env-capture spawn after ready', async () => {
  const { app, spawnLog, logFile } = await launch({ AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '300' });
  const agentRuns = () =>
    spawnLines(spawnLog).filter((argv) => argv.includes('agents') && argv.includes('--json'));
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
    await app.evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh());
    await expect.poll(() => agentRuns().length, { timeout: 15_000 }).toBeGreaterThan(runsBefore);
    const fresh = agentRuns().slice(runsBefore);
    expect(fresh.every((argv) => argv.includes('FAKE_WSL_HELPER=1'))).toBe(true);
    // Several polls later still no new interactive-login capture.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(envCaptures(spawnLog)).toBe(captures);
    const channelEnv = (await readEvents(logFile)).filter(
      (e) => e.event === 'host-env' && (e.detail as { source?: string }).source === 'channel',
    );
    expect(channelEnv.length).toBeGreaterThanOrEqual(1);
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
  } finally {
    await closeApp(app);
  }
});

test('a failing wsl -l -v keeps the hosts and the live helper; the respawn gate refuses', async () => {
  const { root, distros } = flipRoot();
  const { app, spawnLog, logFile } = await launch(flipEnv(root, distros));
  const listOutcomes = async () =>
    (await readEvents(logFile))
      .filter((e) => e.event === 'host-list')
      .map((e) => (e.detail as { ok?: boolean }).ok);
  try {
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    const n = launches(spawnLog);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await flipAndEnumerate(app, distros, 'FAIL');
    await expect.poll(async () => (await listOutcomes()).includes(false), { timeout: 15_000 }).toBe(true);
    // The host row survives and the running helper is left alone.
    expect((await hostRow(app))?.state).toBe('ready');
    expect(await helperState(app)).toBe('ready');
    // While the latest list failed, a dead helper is not respawned.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHelperKill(id), HOST);
    await expect
      .poll(async () => (await helperEvents(logFile)).some((e) => e.reason === 'distro-unavailable'), {
        timeout: 15_000,
      })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(launches(spawnLog)).toBe(n);
    expect((await hostRow(app))?.state).toBe('ready');
    // The list recovers: the next good enumeration brings the helper back.
    await flipAndEnumerate(app, distros, 'Fake:Running:default');
    await expect.poll(() => helperState(app), { timeout: 30_000 }).toBe('ready');
    expect(launches(spawnLog)).toBe(n + 1);
  } finally {
    await closeApp(app);
  }
});
