import { appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  launchWithClaudeFixture,
  shellPage,
  closeApp,
} from './helpers';
import type { ClaudeState, ClaudeSubagent } from '../../src/shared/ipc';

// Phase 6 deferrals (#1–#8): subagent transcripts, header fork, per-API-
// message bubbles, --permission-mode on claude ptys, terminal-owned live
// history, and the usage pill's cost.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});
test.afterAll(async () => {
  await fixtures.close();
});

const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const FAKE_PTY = resolve(__dirname, '../../out/fixtures/fakePty.cjs');
const UA = '11111111-0000-4000-8000-00000000000a';

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    claudeState: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeState()) as Promise<ClaudeState>,
    state: () =>
      evaluate(() => (globalThis as any).__agentworkspace.state()) as Promise<any>,
    setSurface: (s: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.setSurface(v),
        s,
      ) as Promise<void>,
    claudeSelect: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeSelect(v),
        id,
      ) as Promise<void>,
    claudeNewSession: (cwd: string | null = null) =>
      app.evaluate(
        (_e, v: string | null) => (globalThis as any).__agentworkspace.claudeNewSession(v),
        cwd,
      ) as Promise<string>,
    claudePrompt: (id: string, text: string) =>
      app.evaluate(
        (_e, a: { id: string; text: string }) =>
          (globalThis as any).__agentworkspace.claudePrompt(a.id, a.text),
        { id, text },
      ) as Promise<void>,
    claudeChatState: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeChatState()) as Promise<any>,
    claudeSubagents: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeSubagents(v),
        id,
      ) as Promise<ClaudeSubagent[]>,
    claudeOpenSubagent: (id: string, agentId: string) =>
      app.evaluate(
        (_e, a: { id: string; agentId: string }) =>
          (globalThis as any).__agentworkspace.claudeOpenSubagent(a.id, a.agentId),
        { id, agentId },
      ) as Promise<null>,
    claudeChatMessageIds: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeChatMessageIds(v),
        id,
      ) as Promise<(string | null)[]>,
    claudeFork: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeFork(v),
        id,
      ) as Promise<void>,
    claudeTerminalOpen: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeTerminalOpen(v),
        id,
      ) as Promise<void>,
    terminalList: () =>
      evaluate(() => (globalThis as any).__agentworkspace.terminalList()) as Promise<any[]>,
    terminalRead: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.terminalRead(v),
        id,
      ) as Promise<string>,
  };
}

const BASE_ENV = {
  AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
  AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
};

test('subagent row expands, opens read-only, back returns', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, BASE_ENV);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    // The row's subagents list loads on expand.
    const subs = await h.claudeSubagents(UA);
    expect(subs.length).toBe(1);
    const sub = subs[0]!;
    expect(sub.agentId).toBe('fixture01');
    expect(sub.parentSessionId).toBe(UA);
    expect(sub.title).toContain('List the files');
    expect(sub.messageCount).toBe(3);
    const shell = await shellPage(app);
    await h.claudeSelect(UA);
    // Shell: expand toggle on the UA row (not first() — other rows have one).
    const row = shell.locator(`[data-session-id="${UA}"]`).locator('..');
    await expect(row.locator(`[data-subagents-toggle]`)).toBeVisible({
      timeout: 10_000,
    });
    await row.locator(`[data-subagents-toggle]`).click();
    await expect(shell.locator(`[data-subagent-id="fixture01"]`)).toBeVisible({
      timeout: 10_000,
    });
    await shell.locator(`[data-subagent-id="fixture01"]`).click();
    await expect.poll(async () => (await h.claudeState()).selectedSubagentId).toBe('fixture01');
    // Read-only view: back button + the transcript content.
    await expect(shell.locator('#claudeSubagentBack')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () =>
      (await h.claudeChatState()).subagentSessions[`${UA}/fixture01`]?.loaded,
    ).toBe(true);
    // Back clears the selection.
    await shell.locator('#claudeSubagentBack').click();
    await expect.poll(async () => (await h.claudeState()).selectedSubagentId).toBe(null);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('header fork creates and selects a new session', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, BASE_ENV);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    await h.claudeSelect(UA);
    const shell = await shellPage(app);
    await shell.locator('#claudeFork').click({ timeout: 10_000 });
    await expect
      .poll(async () => (await h.state()).claudeSessionId)
      .not.toBe(UA);
    const id = await h.state().then((s: any) => s.claudeSessionId);
    expect(id).not.toBe(UA);
    expect((await h.claudeState()).sessions.some((s) => s.id === id)).toBe(true);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('two API messages in one turn → two agent bubbles', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    ...BASE_ENV,
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
    FAKE_CLAUDE_TWO_MESSAGES: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const id = await h.claudeNewSession(null);
    await h.claudePrompt(id, 'hi');
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id]?.lastStopReason)
      .toBe('end_turn');
    const ids = (await h.claudeChatMessageIds(id)).filter(Boolean);
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
    expect(ids).toContain('msg_fake_1');
    expect(ids).toContain('msg_fake_2');
    const shell = await shellPage(app);
    await h.claudeSelect(id);
    await expect(shell.locator('#messageList')).toContainText('Echo:hi');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('terminal-owned session reloads history on transcript change', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures, {
    ...BASE_ENV,
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: FAKE_PTY,
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    await h.claudeSelect(UA);
    await h.claudeTerminalOpen(UA);
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[UA]?.terminalOwned)
      .toBe(true);
    const shell = await shellPage(app);
    await expect(shell.locator('#terminalOwnedBanner')).toBeVisible({ timeout: 10_000 });
    // Append a transcript line — the watcher → debounced loadHistory must
    // surface it in the chat column within ~2 s.
    const file = join(
      claudeHome,
      'projects',
      'C--work-alpha',
      `${UA}.jsonl`,
    );
    appendFileSync(
      file,
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: 'terminal typed this' },
        uuid: 'e5e5e5e5-0000-4000-8000-000000000001',
        timestamp: new Date().toISOString(),
        userType: 'external',
        entrypoint: 'cli',
        cwd: 'C:\\work\\alpha',
        sessionId: UA,
        version: '2.1.302',
        gitBranch: 'main',
      }) + '\n',
    );
    await expect(shell.locator('#messageList')).toContainText('terminal typed this', {
      timeout: 8_000,
    });
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('cost reaches the usage pill', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    ...BASE_ENV,
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
    FAKE_CLAUDE_COST_USD: '0.05',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const id = await h.claudeNewSession(null);
    await h.claudePrompt(id, 'hi');
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id]?.lastStopReason)
      .toBe('end_turn');
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id]?.usage?.costUsd)
      .toBeGreaterThan(0);
    const shell = await shellPage(app);
    await expect(shell.locator('#tokenUsage')).toContainText('$', { timeout: 10_000 });
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
