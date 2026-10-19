import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchWithClaudeFixture, state } from './helpers';

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
