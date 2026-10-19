import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchWithClaudeFixture, shellPage, state } from './helpers';

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
  const { app } = await launchWithClaudeFixture(fixtures, {
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
    const keys = (await app.evaluate(() =>
      (globalThis as any).__devinworkspaces.hostShellEnvKeys('wsl:Fake'),
    )) as string[];
    expect(keys).toContain('FAKE_WSL_MARKER');
  } finally {
    await closeApp(app);
  }
});

test('a session created under the UNC root runs on the wsl host', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
    DEVIN_WORKSPACES_TEST_TERMINAL_CMD: `node ${join(process.cwd(), 'out/fixtures/fakePty.cjs')}`,
  });
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');

    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__devinworkspaces.claudeNewSession(cwd),
      `${uncRoot}\\home\\u\\proj`,
    )) as string | null;
    expect(id).toBeTruthy();

    const chat = (await app.evaluate(() =>
      (globalThis as any).__devinworkspaces.claudeChatState(),
    )) as { sessions: Record<string, { host: string; cwd: string }> };
    expect(chat.sessions[id!]?.host).toBe('wsl:Fake');
    expect(chat.sessions[id!]?.cwd).toBe('/home/u/proj');

    const opened = (await app.evaluate(
      (_e, sessionId: string) =>
        (globalThis as any).__devinworkspaces.claudeTerminalOpen(sessionId),
      id!,
    )) as { ok: boolean; id?: string };
    expect(opened.ok).toBe(true);
    const terminalId = opened.id!;
    const read = () =>
      app.evaluate(
        (_e, tid: string) => (globalThis as any).__devinworkspaces.terminalRead(tid),
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
  });
  const shell = await shellPage(app);
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');
    await app.evaluate(() => (globalThis as any).__devinworkspaces.setSurface('settings'));
    const row = shell.locator('[data-host-id="wsl:Fake"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator('[data-host-state]')).toHaveText('ready');
    await expect(row.locator('[data-host-facts]')).toContainText('shell env');

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
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  const spawnLog = join(uncRoot, 'spawn.log');
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
    FAKE_WSL_SPAWN_LOG: spawnLog,
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: `node ${join(process.cwd(), 'out/fixtures/fakeAcpAgent.cjs')}`,
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
      (_e, path: string) => (globalThis as any).__devinworkspaces.localAddWorkspace(path),
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
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  const { app } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
    DEVIN_WORKSPACES_TEST_TERMINAL_CMD: `node ${join(process.cwd(), 'out/fixtures/fakePty.cjs')}`,
  });
  const shell = await shellPage(app);
  try {
    await expect
      .poll(
        async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Fake')?.state,
        { timeout: 30_000 },
      )
      .toBe('ready');
    await app.evaluate(() => (globalThis as any).__devinworkspaces.setSurface('claude'));
    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__devinworkspaces.claudeNewSession(cwd),
      `${uncRoot}\\home\\u\\proj`,
    )) as string;
    const opened = (await app.evaluate(
      (_e, sessionId: string) =>
        (globalThis as any).__devinworkspaces.claudeTerminalOpen(sessionId),
      id,
    )) as { ok: boolean };
    expect(opened.ok).toBe(true);
    await app.evaluate(
      (_e, sessionId: string) => (globalThis as any).__devinworkspaces.claudeSelect(sessionId),
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
