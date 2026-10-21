import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchWithClaudeFixture, shellPage, waitForEvent } from './helpers';
import type { ClaudeAgent, ClaudeState } from '../../src/shared/ipc';

// §2.5: the Claude terminal tab + background agents end-to-end — fake pty
// (AGENT_WORKSPACE_TEST_TERMINAL_CMD prints `args:...`), fake `claude agents`
// CLI (FAKE_CLAUDE_AGENTS file / FAKE_CLAUDE_AGENTS_LOG record), fake SDK.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const FAKE_PTY = `node ${resolve(__dirname, '../../out/fixtures/fakePty.cjs')}`;
const FAKE_AGENTS = `node ${resolve(__dirname, '../../out/fixtures/fakeClaudeAgents.cjs')}`;
const UA = '11111111-0000-4000-8000-00000000000a';
const UB = '11111111-0000-4000-8000-00000000000b';

type MenuItem = {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  submenu?: MenuItem[];
};

function findMenuItem(items: MenuItem[], label: string): MenuItem | undefined {
  for (const item of items) {
    if (item.label === label) return item;
    const nested = item.submenu && findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return undefined;
}

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    claudeState: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeState()) as Promise<ClaudeState>,
    claudeChatState: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeChatState()) as Promise<any>,
    claudeSelect: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeSelect(v),
        id,
      ) as Promise<void>,
    claudeMenuItems: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeMenuItems()) as Promise<MenuItem[]>,
    claudeMenuClick: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeMenuClick(v),
        id,
      ) as Promise<{ action: string | null }>,
    claudeLiveCount: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeLiveCount()) as Promise<number>,
    claudeAgents: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeAgents()) as Promise<ClaudeAgent[]>,
    claudeAgentsRefresh: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeAgentsRefresh()) as Promise<void>,
    claudePrompt: (id: string, text: string) =>
      app.evaluate(
        (_e, a: { id: string; text: string }) =>
          (globalThis as any).__agentworkspace.claudePrompt(a.id, a.text),
        { id, text },
      ) as Promise<void>,
    terminalList: () =>
      evaluate(() => (globalThis as any).__agentworkspace.terminalList()) as Promise<
        { id: string; kind: string; sessionId: string | null }[]
      >,
    terminalRead: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.terminalRead(v),
        id,
      ) as Promise<string>,
    terminalPid: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.terminalPid(v),
        id,
      ) as Promise<number | null>,
    state: () =>
      evaluate(() => (globalThis as any).__agentworkspace.state()) as Promise<{
        claudeSessionId: string | null;
      }>,
    setSurface: (surface: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.setSurface(v as never),
        surface,
      ),
  };
}

function baseEnv(agentsFile?: string, agentsLog?: string): Record<string, string> {
  return {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: FAKE_PTY,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_CMD: FAKE_AGENTS,
    ...(agentsFile ? { FAKE_CLAUDE_AGENTS: agentsFile } : {}),
    ...(agentsLog ? { FAKE_CLAUDE_AGENTS_LOG: agentsLog } : {}),
    AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS: '500',
  };
}

test('terminal tab: spawn, banner, reuse, close restores chat + history', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, baseEnv());
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    await h.claudeSelect(UA);

    // --- Terminal tab: pty mounts, fake pty echoes -r <id> ------------------
    await shell.locator('#view-terminal').click();
    await expect(shell.locator(`[data-session-terminal="${UA}"]`)).toBeAttached({
      timeout: 10_000,
    });
    await expect
      .poll(async () => {
        const terms = await h.terminalList();
        const claude = terms.find((t) => t.sessionId === UA);
        return claude ? await h.terminalRead(claude.id) : '';
      })
      .toContain(`-r ${UA}`);
    // One-writer: composer disabled + banner, no live query.
    await shell.locator('#view-chat').click();
    await expect(shell.locator('#terminalOwnedBanner')).toBeVisible();
    await expect(shell.locator('#composer')).toBeDisabled();
    expect(await h.claudeLiveCount()).toBe(0);
    expect(
      (await h.claudeChatState()).sessions[UA]?.terminalOwned,
    ).toBe(true);

    // --- Switch back: same pty (no second spawn) ----------------------------
    const pid0 = (await h.terminalList()).find((t) => t.sessionId === UA)!.id;
    const pid = await h.terminalPid(pid0);
    await shell.locator('#view-terminal').click();
    await shell.locator('#view-chat').click();
    expect((await h.terminalList()).find((t) => t.sessionId === UA)?.id).toBe(pid0);
    expect(await h.terminalPid(pid0)).toBe(pid);

    // --- Close: pty ends, composer re-enables, history reloads --------------
    const logFile = join(profile, 'events.jsonl');
    await shell.locator('#terminalOwnedClose').click();
    await expect
      .poll(async () => (await h.terminalList()).some((t) => t.sessionId === UA))
      .toBe(false);
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[UA]?.terminalOwned)
      .toBeFalsy();
    await expect(shell.locator('#composer')).toBeEnabled();
    await waitForEvent(logFile, 'claude-history');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('opening the terminal during a running prompt is refused', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    ...baseEnv(),
    FAKE_CLAUDE_DELAY_MS: '4000',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: mkdtempSync(
      join(tmpdir(), 'claude-term-cwd-'),
    ),
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    const id = (await app.evaluate(() =>
      (globalThis as any).__agentworkspace.claudeNewSession(null),
    )) as string;
    await h.claudePrompt(id, 'long turn');
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id]?.running)
      .toBe(true);
    await shell.locator('#view-terminal').click();
    await expect(shell.locator('#claudeError')).toContainText(
      'Cancel the running prompt first',
      { timeout: 10_000 },
    );
    // End the turn before close — app.close() while a query is still running
    // wedges the Electron quit path on Windows (see AGENTS.md Phase 3 notes).
    await app.evaluate(
      (_e, sid: string) =>
        (globalThis as any).__agentworkspace.claudeCancel(sid),
      id,
    );
    await expect
      .poll(async () => (await h.claudeChatState()).sessions[id]?.running)
      .toBeFalsy();
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('sidebar "Open in terminal" selects the session and shows the terminal tab', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, baseEnv());
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    await shell.locator(`[data-session-id="${UB}"]`).click({ button: 'right' });
    const items = await h.claudeMenuItems();
    const item = findMenuItem(items, 'Open in terminal');
    expect(item).toBeTruthy();
    const { action } = await h.claudeMenuClick(item!.id);
    expect(action).toBe('open-terminal');
    expect((await h.state()).claudeSessionId).toBe(UB);
    await expect(shell.locator(`[data-session-terminal="${UB}"]`)).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('background agents: badges, orphan section, stop via menu', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-agents-'));
  const agentsFile = join(dir, 'agents.json');
  const agentsLog = join(dir, 'agents-log.txt');
  writeFileSync(
    agentsFile,
    JSON.stringify([
      {
        pid: 4242,
        id: 'aa11bb22',
        cwd: 'C:\\work\\alpha',
        kind: 'background',
        startedAt: Date.now() - 60_000,
        sessionId: UA,
        name: 'alpha worker',
        status: 'busy',
        state: 'working',
      },
      {
        pid: 4243,
        id: 'cc33dd44',
        cwd: 'C:\\work\\elsewhere',
        kind: 'background',
        startedAt: Date.now() - 30_000,
        sessionId: null,
        name: 'orphan task',
        status: 'busy',
        state: 'working',
      },
    ]),
  );
  const { app, profile } = await launchWithClaudeFixture(
    fixtures,
    baseEnv(agentsFile, agentsLog),
  );
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    // Mapped agent → the session row carries the running badge.
    await expect
      .poll(async () => (await h.claudeAgents()).length)
      .toBe(2);
    await expect(shell.locator(`[data-session-id="${UA}"]`)).toHaveAttribute(
      'data-agent-status',
      'running',
    );
    // Orphan → "Background agents" section row.
    await expect(shell.locator('[data-section-kind="agents"]')).toBeVisible();
    const orphan = shell.locator('[data-agent-id="cc33dd44"]');
    await expect(orphan).toContainText('orphan task');
    await expect(orphan).toHaveAttribute('data-agent-status', 'running');

    // Attach + Stop items on the orphan's menu.
    await orphan.click({ button: 'right' });
    const items = await h.claudeMenuItems();
    expect(findMenuItem(items, 'Attach')).toBeTruthy();
    const stop = findMenuItem(items, 'Stop');
    expect(stop).toBeTruthy();
    await h.claudeMenuClick(stop!.id);
    await expect
      .poll(async () => existsSync(agentsLog))
      .toBe(true);
    expect(readFileSync(agentsLog, 'utf8')).toContain('stop cc33dd44');

    // Rewrite the list empty → refresh → the section disappears.
    writeFileSync(agentsFile, '[]');
    await h.claudeAgentsRefresh();
    await expect
      .poll(async () => (await h.claudeAgents()).length)
      .toBe(0);
    await expect(shell.locator('[data-section-kind="agents"]')).toHaveCount(0);
    await expect(
      shell.locator(`[data-session-id="${UA}"]`),
    ).not.toHaveAttribute('data-agent-status', 'running');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

