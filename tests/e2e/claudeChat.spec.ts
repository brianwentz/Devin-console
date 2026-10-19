import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchApp, launchWithClaudeFixture, shellPage } from './helpers';
import type { ClaudeChatStatePublic, ClaudeState } from '../../src/shared/ipc';

// §3.5: the Claude chat view end-to-end over the fake SDK
// (DEVIN_WORKSPACES_TEST_CLAUDE_SDK → out/fixtures/fakeClaudeSdk.mjs).

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
    claudeChatState: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeChatState()) as Promise<ClaudeChatStatePublic>,
    claudeState: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeState()) as Promise<ClaudeState>,
    claudeNewSession: (cwd: string | null) =>
      app.evaluate(
        (_e, v: string | null) => (globalThis as any).__devinworkspaces.claudeNewSession(v),
        cwd,
      ) as Promise<string | null>,
    claudePrompt: (id: string, text: string) =>
      app.evaluate(
        (_e, a: { id: string; text: string }) =>
          (globalThis as any).__devinworkspaces.claudePrompt(a.id, a.text),
        { id, text },
      ) as Promise<void>,
    claudeCancel: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.claudeCancel(v),
        id,
      ) as Promise<void>,
    claudeLiveCount: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeLiveCount()) as Promise<number>,
    setSurface: (surface: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.setSurface(v as never),
        surface,
      ),
    state: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.state()) as Promise<{
        claudeSessionId: string | null;
      }>,
  };
}

test('new session: prompt → Echo, turn summary, sidebar lists the transcript', async () => {
  const newCwd = mkdtempSync(join(tmpdir(), 'claude-chat-cwd-'));
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: newCwd,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    await expect(shell.locator('[data-claude-view]')).toBeVisible();

    const id = await h.claudeNewSession(null);
    expect(id).toBeTruthy();
    expect((await h.state()).claudeSessionId).toBe(id);
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id!]?.live)
      .toBe('idle');

    await h.claudePrompt(id!, 'hello claude');
    await expect(shell.locator('#messageList')).toContainText('hello claude');
    await expect(shell.locator('#messageList')).toContainText('Echo: hello claude', {
      timeout: 10_000,
    });
    await expect(shell.locator('#turnSummary')).toBeVisible();
    await expect(shell.locator('#stopReason')).toHaveAttribute(
      'data-stop-reason',
      'end_turn',
    );
    await expect(shell.locator('#tokenUsage')).toBeVisible();

    // The fake wrote the transcript — the watcher lists the new session.
    await expect
      .poll(async () => (await h.claudeState()).sessions.some((s) => s.id === id), {
        timeout: 4_000,
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const dirs = await import('node:fs').then((fs) =>
          fs.readdirSync(join(claudeHome, 'projects')),
        );
        return dirs.length;
      })
      .toBeGreaterThan(2);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(newCwd, { recursive: true, force: true });
  }
});

test('relaunch restores claude.lastSessionId and loads the transcript history', async () => {
  const newCwd = mkdtempSync(join(tmpdir(), 'claude-chat-cwd-'));
  const env = {
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: newCwd,
  };
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures, env);
  const h = hooks(app);
  let id: string | null = null;
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    id = await h.claudeNewSession(null);
    await h.claudePrompt(id!, 'persist me');
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id!]?.lastStopReason)
      .toBe('end_turn');
  } finally {
    await closeApp(app);
  }

  const app2 = await launchApp(
    profile,
    join(profile, 'events2.jsonl'),
    join(profile, 'downloads'),
    fixtures,
    { CLAUDE_CONFIG_DIR: claudeHome, ...env },
  );
  const h2 = hooks(app2);
  try {
    await expect.poll(async () => (await h2.claudeState()).status).toBe('ready');
    await expect.poll(async () => (await h2.state()).claudeSessionId).toBe(id);
    await expect
      .poll(async () => (await h2.claudeChatState()).sessions[id!]?.loaded)
      .toBe(true);
    const shell = await shellPage(app2);
    await h2.setSurface('claude');
    await expect(shell.locator('#messageList')).toContainText('persist me');
    await expect(shell.locator('#messageList')).toContainText('Echo: persist me');
  } finally {
    await app2.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    rmSync(newCwd, { recursive: true, force: true });
  }
});

test('tool permission: card with 3 options, Allow completes the turn', async () => {
  const newCwd = mkdtempSync(join(tmpdir(), 'claude-chat-cwd-'));
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: newCwd,
    FAKE_CLAUDE_TOOL: '1',
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    const id = (await h.claudeNewSession(null))!;
    await h.claudePrompt(id, 'run a tool');
    await expect(shell.locator('.permission-card')).toBeVisible({ timeout: 10_000 });
    const options = shell.locator('.permission-card .permission-option');
    await expect(options).toHaveCount(3);
    await expect(shell.locator('[data-tool-call-id]')).toHaveAttribute(
      'data-status',
      'in_progress',
    );
    await options.filter({ hasText: 'Allow' }).first().click();
    await expect(shell.locator('[data-tool-call-id]')).toHaveAttribute(
      'data-status',
      'completed',
      { timeout: 10_000 },
    );
    await expect(shell.locator('#stopReason')).toHaveAttribute(
      'data-stop-reason',
      'end_turn',
    );
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(newCwd, { recursive: true, force: true });
  }
});

test('cancel mid-turn finishes as cancelled and re-enables the composer', async () => {
  const newCwd = mkdtempSync(join(tmpdir(), 'claude-chat-cwd-'));
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: newCwd,
    FAKE_CLAUDE_DELAY_MS: '5000',
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    const id = (await h.claudeNewSession(null))!;
    await h.claudePrompt(id, 'slow turn');
    await expect(shell.locator('#cancelButton')).toBeVisible({ timeout: 10_000 });
    await shell.locator('#cancelButton').click();
    await expect(shell.locator('#stopReason')).toHaveAttribute(
      'data-stop-reason',
      'cancelled',
      { timeout: 10_000 },
    );
    await expect(shell.locator('#composer')).toBeEnabled();
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(newCwd, { recursive: true, force: true });
  }
});

test('opening a fixture session renders history; live stays 0 until a prompt', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    await shell.locator(`[data-session-id="${UA}"]`).click();
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[UA]?.loaded)
      .toBe(true);
    // getSessionMessages drops the fixture's string-content user entry; the
    // assistant history is what renders.
    await expect(shell.locator('#messageList')).toContainText('Alpha reply');
    await expect(shell.locator('#composer')).toBeEnabled();
    expect(await h.claudeLiveCount()).toBe(0);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('setPermissionMode updates the session and the header select', async () => {
  const newCwd = mkdtempSync(join(tmpdir(), 'claude-chat-cwd-'));
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: FAKE_SDK,
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: newCwd,
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    const id = (await h.claudeNewSession(null))!;
    await shell.evaluate((sid: string) =>
      (window as any).devinworkspaces.claudeSetPermissionMode(sid, 'plan'),
    id);
    await expect(shell.locator('#claudePermissionMode')).toHaveValue('plan');
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id]?.permissionMode)
      .toBe('plan');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(newCwd, { recursive: true, force: true });
  }
});

