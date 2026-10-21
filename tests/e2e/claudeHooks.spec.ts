import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, evaluateInShell, launchWithClaudeFixture, readEvents, shellPage } from './helpers';
import type { ClaudeState } from '../../src/shared/ipc';

// §3.5: the Phase 4 hook listener + global settings install + chat-derived
// notifications end-to-end — fake SDK, fake pty (prints args + hook env
// presence), real loopback listener exercised via test hooks.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const FAKE_PTY = `node ${resolve(__dirname, '../../out/fixtures/fakePty.cjs')}`;
const UA = '11111111-0000-4000-8000-00000000000a';
const UA_CWD = 'C:\\work\\alpha';

type NotificationEntry = {
  id: string;
  kind: string;
  sessionId: string;
  source?: string;
  sessionTitle: string;
  title: string;
  body: string;
};

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    claudeState: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeState()) as Promise<ClaudeState>,
    claudeHookInfo: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeHookInfo()) as Promise<{
        port: number;
        token: string;
      } | null>,
    claudeActivity: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeActivity()) as Promise<
        Record<string, { activity: string }>
      >,
    claudeHooksSettingsPath: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeHooksSettingsPath()) as Promise<string>,
    hostRefresh: () =>
      evaluate(() => (globalThis as any).__agentworkspace.hostRefresh()) as Promise<void>,
    claudePostHook: (event: string, body: unknown) =>
      app.evaluate(
        (_e, a: { event: string; body: unknown }) =>
          (globalThis as any).__agentworkspace.claudePostHook(a.event, a.body),
        { event, body },
      ) as Promise<{ ok: boolean; status?: number }>,
    claudePostHookRaw: (event: string, body: unknown, auth: string | null) =>
      app.evaluate(
        (_e, a: { event: string; body: unknown; auth: string | null }) =>
          (globalThis as any).__agentworkspace.claudePostHookRaw(
            a.event,
            a.body,
            a.auth ?? undefined,
          ),
        { event, body, auth },
      ) as Promise<{ ok: boolean; status?: number }>,
    state: () =>
      evaluate(() => (globalThis as any).__agentworkspace.state()) as Promise<any>,
    notifications: () =>
      evaluate(() => (globalThis as any).__agentworkspace.notifications()) as Promise<NotificationEntry[]>,
    claudeNewSession: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeNewSession()) as Promise<string>,
    claudePrompt: (id: string, text: string) =>
      app.evaluate(
        (_e, a: { id: string; text: string }) =>
          (globalThis as any).__agentworkspace.claudePrompt(a.id, a.text),
        { id, text },
      ) as Promise<void>,
    claudeChatState: () =>
      evaluate(() => (globalThis as any).__agentworkspace.claudeChatState()) as Promise<any>,
    claudeTerminalOpen: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeTerminalOpen(v),
        id,
      ) as Promise<{ ok: boolean; id?: string; error?: string }>,
    claudeSelect: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.claudeSelect(v),
        id,
      ) as Promise<void>,
    setSurface: (s: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__agentworkspace.setSurface(v),
        s,
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

function claudeEntries(list: NotificationEntry[]): NotificationEntry[] {
  return list.filter((n) => n.source === 'claude');
}

test('hook events drive sidebar activity + notification entries (dedup + kinds)', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect.poll(async () => await h.claudeHookInfo()).not.toBeNull();
    const { port } = (await h.claudeHookInfo())!;
    expect(port).toBeGreaterThan(0);

    const shell = await shellPage(app);
    await h.setSurface('claude');
    // PermissionRequest → 'waiting' entry + amber dot on the session row.
    expect(
      (await h.claudePostHook('PermissionRequest', {
        session_id: UA,
        tool_name: 'Write',
        cwd: UA_CWD,
      })).ok,
    ).toBe(true);
    await expect
      .poll(async () => claudeEntries(await h.notifications()).length)
      .toBe(1);
    expect(claudeEntries(await h.notifications())[0]?.kind).toBe('waiting');
    await expect(shell.locator(`[data-session-id="${UA}"]`)).toHaveAttribute(
      'data-activity',
      'waiting',
    );

    // UserPromptSubmit → running.
    expect(
      (await h.claudePostHook('UserPromptSubmit', { session_id: UA, cwd: UA_CWD })).ok,
    ).toBe(true);
    await expect(shell.locator(`[data-session-id="${UA}"]`)).toHaveAttribute(
      'data-activity',
      'running',
    );

    // Notification{permission_prompt} right after a PermissionRequest for the
    // same session is the same prompt — deduped: the waiting count must not
    // grow. (A second PermissionRequest supersedes the first — still 1.)
    await h.claudePostHook('PermissionRequest', {
      session_id: UA,
      tool_name: 'Write',
      cwd: UA_CWD,
    });
    await expect
      .poll(async () =>
        claudeEntries(await h.notifications()).filter((n) => n.kind === 'waiting').length,
      )
      .toBe(1);
    await h.claudePostHook('Notification', {
      session_id: UA,
      notification_type: 'permission_prompt',
      cwd: UA_CWD,
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(
      claudeEntries(await h.notifications()).filter((n) => n.kind === 'waiting').length,
    ).toBe(1);

    // Stop → activity clears; finished entry only after kinds.finished is on.
    await h.claudePostHook('Stop', { session_id: UA, cwd: UA_CWD });
    await expect
      .poll(async () => (await h.claudeActivity())[UA]?.activity ?? null)
      .toBe(null);
    const finishedCount = async () =>
      claudeEntries(await h.notifications()).filter((n) => n.kind === 'finished').length;
    expect(await finishedCount()).toBe(0);
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ notifications: { kinds: { finished: true } } })`,
    );
    await h.claudePostHook('UserPromptSubmit', { session_id: UA, cwd: UA_CWD });
    await expect(shell.locator(`[data-session-id="${UA}"]`)).toHaveAttribute(
      'data-activity',
      'running',
    );
    await h.claudePostHook('Stop', { session_id: UA, cwd: UA_CWD });
    await expect.poll(finishedCount).toBe(1);
    await expect
      .poll(async () => (await h.claudeActivity())[UA]?.activity ?? null)
      .toBe(null);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('PostToolUse gh pr create → pr-opened entry + auto-opened tab in claude scope', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const prUrl = `${fixtures.githubUrl}/cloudbeds/testrepo/pull/42`;
    expect(
      (
        await h.claudePostHook('PostToolUse', {
          session_id: UA,
          tool_name: 'Bash',
          tool_input: { command: 'gh pr create --fill' },
          tool_response: `Created PR ${prUrl}`,
          cwd: UA_CWD,
        })
      ).ok,
    ).toBe(true);
    await expect
      .poll(async () =>
        claudeEntries(await h.notifications()).filter((n) => n.kind === 'pr-opened').length,
      )
      .toBe(1);
    await expect
      .poll(async () => (await h.state()).tabs.hiddenTabCount)
      .toBe(1);
    const events = readFileSync(join(profile, 'events.jsonl'), 'utf8');
    expect(events).toContain('"event":"pr-auto-open"');
    expect(events).toContain('"source":"claude-hook"');
    // A non-gh Bash does nothing.
    const before = (await h.notifications()).length;
    await h.claudePostHook('PostToolUse', {
      session_id: UA,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'ok',
      cwd: UA_CWD,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect((await h.notifications()).length).toBe(before);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a bad token is rejected (401 + claude-hook-rejected)', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect.poll(async () => await h.claudeHookInfo()).not.toBeNull();
    const res = await h.claudePostHookRaw('Stop', { session_id: UA }, 'Bearer wrong');
    expect(res.status).toBe(401);
    const events = readFileSync(join(profile, 'events.jsonl'), 'utf8');
    expect(events).toContain('claude-hook-rejected');
    expect(events).toContain('"reason":"auth"');
    // Unknown path → 404.
    const info = await h.claudeHookInfo();
    const notFound = await app.evaluate(
      (_e, a: { port: number }) =>
        fetch(`http://127.0.0.1:${a.port}/agent-workspace/nope/Stop`, {
          method: 'POST',
          headers: { authorization: 'Bearer x' },
          body: '{}',
        }).then((r) => r.status),
      { port: info!.port },
    );
    expect(notFound).toBe(404);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('opening a waiting notification selects the session on the claude surface', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect.poll(async () => await h.claudeHookInfo()).not.toBeNull();
    const shell = await shellPage(app);
    await h.claudePostHook('PermissionRequest', {
      session_id: UA,
      tool_name: 'Write',
      cwd: UA_CWD,
    });
    await expect
      .poll(async () => claudeEntries(await h.notifications()).length)
      .toBe(1);
    const id = claudeEntries(await h.notifications())[0]!.id;
    await evaluateInShell(app, 'window.agentworkspace.notificationsPanel(true)');
    const row = shell.locator(`[data-notification-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect.poll(async () => (await h.state()).surface).toBe('claude');
    await expect.poll(async () => (await h.state()).claudeSessionId).toBe(UA);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('claude.hooksEnabled writes and removes our block in settings.json', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect.poll(async () => await h.claudeHookInfo()).not.toBeNull();
    const settingsFile = await h.claudeHooksSettingsPath();
    expect(settingsFile.replace(/\\/g, '/')).toContain('claude-home/settings.json');
    // A foreign hook on the same event must survive enable + disable.
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }],
          },
        },
        null,
        2,
      ),
    );
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ claude: { hooksEnabled: true } })`,
    );
    await expect.poll(async () => (await h.claudeState()).hooks.installed).toBe(true);
    const merged = readFileSync(settingsFile, 'utf8');
    expect(merged).toContain('/agent-workspace/hook/');
    expect(merged).toContain('echo foreign');
    expect(existsSync(`${settingsFile}.agent-workspace.bak`)).toBe(true);

    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ claude: { hooksEnabled: false } })`,
    );
    await expect.poll(async () => (await h.claudeState()).hooks.installed).toBe(false);
    const removed = readFileSync(settingsFile, 'utf8');
    expect(removed).not.toContain('/agent-workspace/hook/');
    expect(removed).toContain('echo foreign');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('hooks apply is gated: unchanged refreshes leave settings.json alone, a failed apply retries', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  const logFile = join(profile, 'events.jsonl');
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect.poll(async () => await h.claudeHookInfo()).not.toBeNull();
    const settingsFile = await h.claudeHooksSettingsPath();

    // A failed apply: a directory squatting on the tmp path makes the write fail.
    mkdirSync(`${settingsFile}.tmp`);
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ claude: { hooksEnabled: true } })`,
    );
    await expect.poll(async () => (await h.claudeState()).hooks.error).not.toBeNull();
    expect((await h.claudeState()).hooks.installed).toBe(false);

    // The next refresh retries (lastApplied is only recorded on success).
    rmSync(`${settingsFile}.tmp`, { recursive: true, force: true });
    await h.hostRefresh();
    await expect.poll(async () => (await h.claudeState()).hooks.installed).toBe(true);
    expect((await h.claudeState()).hooks.error).toBeNull();

    // Unchanged settings: further refreshes never re-apply. applyGlobalHooks
    // would log claude-hooks-install even for a no-op write, so the event count
    // (not just the mtime) proves the lastApplied gate skipped it.
    const installs = async () =>
      (await readEvents(logFile)).filter((e) => e.event === 'claude-hooks-install').length;
    const before = statSync(settingsFile).mtimeMs;
    const installsBefore = await installs();
    await h.hostRefresh();
    await h.hostRefresh();
    await new Promise((r) => setTimeout(r, 500));
    expect(await installs()).toBe(installsBefore);
    expect(statSync(settingsFile).mtimeMs).toBe(before);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('claude pty gets --settings hook block + token env (resume mode)', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: FAKE_PTY,
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect.poll(async () => await h.claudeHookInfo()).not.toBeNull();
    await h.setSurface('claude');
    const shell = await shellPage(app);
    await h.claudeSelect(UA);
    await shell.locator('#view-terminal').click();
    await expect(
      shell.locator(`[data-session-terminal="${UA}"]`),
    ).toBeAttached({ timeout: 10_000 });
    // The fake pty echoes argv + env presence into the pty buffer.
    const output = await expect
      .poll(async () => {
        const terms = await h.terminalList();
        const t = terms.find((x: any) => x.sessionId === UA);
        return t ? await h.terminalRead(t.id) : '';
      })
      .toContain('/agent-workspace/hook/');
    const terms = await h.terminalList();
    const t = terms.find((x: any) => x.sessionId === UA);
    const text = await h.terminalRead(t.id);
    expect(text).toContain('--settings');
    expect(text).toContain(`-r ${UA}`);
    // Phase 6 #4: the app default permission mode is passed through.
    expect(text).toContain('--permission-mode');
    expect(text).toContain('default');
    expect(text).toContain('env:AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN=set');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('chat: permission card → waiting entry; Allow → finished', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
    FAKE_CLAUDE_TOOL: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const id = await h.claudeNewSession();
    await h.claudePrompt(id, 'run the tool');
    await expect
      .poll(async () =>
        claudeEntries(await h.notifications()).filter((n) => n.kind === 'waiting').length,
      )
      .toBe(1);
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ notifications: { kinds: { finished: true } } })`,
    );
    const requestId = (await h.claudeChatState()).sessions[id]?.pendingPermission?.requestId;
    expect(requestId).toBeTruthy();
    await app.evaluate(
      (_e, a: { id: string; requestId: string }) =>
        (globalThis as any).__agentworkspace.claudePermission(a.id, a.requestId, 'allow'),
      { id, requestId },
    );
    await expect
      .poll(async () =>
        claudeEntries(await h.notifications()).filter((n) => n.kind === 'finished').length,
      )
      .toBe(1);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
