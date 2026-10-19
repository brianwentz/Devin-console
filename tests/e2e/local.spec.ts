import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { evaluateInShell, launchApp, readEvents, shellPage, state, waitForEvent, waitForEventCount } from './helpers';

// Mirrors LocalStateSchema in src/shared/ipc.ts (subset used by the assertions).
type LocalState = {
  cliPath: string | null;
  installGuidance: string;
  agents: Record<
    string,
    {
      status: string;
      protocolVersion?: number;
      capabilities?: { loadSession: boolean; sessionList: boolean; sessionDelete: boolean };
      restarts: number;
      error?: string;
    }
  >;
  sessions: Record<
    string,
    {
      id: string;
      workspace: string;
      title: string;
      running: boolean;
      loaded: boolean;
      historySource: 'agent' | 'local-index';
      lastStopReason?: string;
      terminalOwned?: boolean;
      error?: string;
      messages: Array<{ role: 'user' | 'agent'; blocks: Array<{ type: string; text?: string; id?: string }> }>;
      toolCalls: Record<string, { id: string; title: string; status: string; kind?: string }>;
      plan?: Array<{ content: string; status: string }>;
      pendingPermission?: { requestId: string; options: Array<{ optionId: string }> };
    }
  >;
};

type Hooks = {
  localState(): LocalState;
  localAddWorkspace(path: string): string | null;
  localRemoveWorkspace(path: string): void;
  localNewSession(workspace: string): Promise<string>;
  localPrompt(sessionId: string, text: string): Promise<string>;
  localCancel(sessionId: string): Promise<void>;
  localListSessions(
    workspace: string,
  ): Promise<Array<{ id: string; title: string; historySource: string }>>;
  localLoadSession(workspace: string, sessionId: string): Promise<void>;
  localDeleteSession(sessionId: string): Promise<void>;
  localAgentPid(workspace: string): number | null;
  terminalOpen(options: {
    kind: 'devin';
    workspace: string;
    sessionId: string;
  }): { ok: true; id: string } | { ok: false; error: string };
  terminalClose(id: string): boolean;
  setSurface(value: 'cloud' | 'local' | 'settings'): void;
  clipboardWrite(text: string): void;
  clipboardRead(): string;
};

const FAKE_AGENT_CMD = 'node out/fixtures/fakeAcpAgent.cjs';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
  expect(existsSync(join('out', 'fixtures', 'fakeAcpAgent.cjs'))).toBe(true);
});

test.afterAll(async () => {
  await fixtures.close();
});

type G = typeof globalThis & { __devinworkspaces: Hooks };

async function localState(app: ElectronApplication): Promise<LocalState> {
  return app.evaluate(() => (globalThis as G).__devinworkspaces.localState());
}

async function setSurfaceLocal(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as G).__devinworkspaces.setSurface('local'));
}

async function addWorkspace(app: ElectronApplication, path: string): Promise<string> {
  const added = await app.evaluate(
    (_electron, value: string) => (globalThis as G).__devinworkspaces.localAddWorkspace(value),
    path,
  );
  if (!added) throw new Error('localAddWorkspace returned null');
  return added;
}

async function agentPid(app: ElectronApplication, workspace: string): Promise<number> {
  const pid = await app.evaluate(
    (_electron, value: string) => (globalThis as G).__devinworkspaces.localAgentPid(value),
    workspace,
  );
  return pid ?? 0;
}

async function newSession(app: ElectronApplication, workspace: string): Promise<string> {
  return app.evaluate(
    (_electron, value: string) => (globalThis as G).__devinworkspaces.localNewSession(value),
    workspace,
  );
}

// Awaits the full turn and returns the stopReason.
async function promptAndWait(app: ElectronApplication, sessionId: string, text: string): Promise<string> {
  return app.evaluate(
    (_electron, args: { id: string; text: string }) =>
      (globalThis as G).__devinworkspaces.localPrompt(args.id, args.text),
    { id: sessionId, text },
  );
}

// Fire-and-forget so the test can interact (permission card, Cancel) mid-turn.
async function promptNoWait(app: ElectronApplication, sessionId: string, text: string): Promise<void> {
  await app.evaluate(
    (_electron, args: { id: string; text: string }) => {
      (globalThis as G).__devinworkspaces.localPrompt(args.id, args.text).catch(() => undefined);
    },
    { id: sessionId, text },
  );
}

async function listSessions(app: ElectronApplication, workspace: string) {
  return app.evaluate(
    (_electron, value: string) => (globalThis as G).__devinworkspaces.localListSessions(value),
    workspace,
  );
}

async function loadSession(app: ElectronApplication, workspace: string, sessionId: string): Promise<string | null> {
  return app.evaluate(
    async (_electron, args: { path: string; id: string }) => {
      try {
        await (globalThis as G).__devinworkspaces.localLoadSession(args.path, args.id);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { path: workspace, id: sessionId },
  );
}

async function waitForHooks(app: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__devinworkspaces)))
    .toBe(true);
}

async function shellCount(app: ElectronApplication, selector: string): Promise<number> {
  return (await evaluateInShell(app, `document.querySelectorAll(${JSON.stringify(selector)}).length`)) as number;
}

// Right-click a selector by dispatching contextmenu (avoids CSS path quoting).
async function rightClick(app: ElectronApplication, selector: string): Promise<void> {
  const ok = await evaluateInShell(
    app,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); return true; })()`,
  );
  expect(ok).toBe(true);
}

// Same for a workspace section header, matching the data-section-name path.
async function rightClickWorkspace(app: ElectronApplication, path: string): Promise<void> {
  const ok = await evaluateInShell(
    app,
    `(() => {
      const el = [...document.querySelectorAll('[data-section-name]')]
        .find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(path)});
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
      return true;
    })()`,
  );
  expect(ok).toBe(true);
}

type MenuItem = { id: string; label: string; enabled: boolean };
async function localMenuItems(app: ElectronApplication): Promise<MenuItem[]> {
  return app.evaluate(
    () => (globalThis as any).__devinworkspaces.localMenuItems(),
  ) as Promise<MenuItem[]>;
}
async function localMenuClick(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate((_e, v) => (globalThis as any).__devinworkspaces.localMenuClick(v), id);
}
async function menuItem(app: ElectronApplication, label: string): Promise<MenuItem | undefined> {
  const items = await localMenuItems(app);
  return items.find((i) => i.label === label);
}

async function shellClick(app: ElectronApplication, selector: string): Promise<boolean> {
  return (await evaluateInShell(
    app,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
  )) as boolean;
}

// Drive the React-controlled composer the way a user would: set the value via the
// native setter so React sees the input event, then press Enter.
async function typeAndSend(app: ElectronApplication, text: string): Promise<void> {
  const ok = await evaluateInShell(
    app,
    `(() => {
      const el = document.getElementById('composer');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      return true;
    })()`,
  );
  expect(ok).toBe(true);
}

function agentText(session: LocalState['sessions'][string]): string {
  return session.messages
    .filter((message) => message.role === 'agent')
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('Local: fake agent with session/list + session/load — prompt, permission, cancel, link, history, crash restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-local-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const linkUrl = `${fixtures.githubUrl}/page/pr-1`;
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_LIST: '1',
    FAKE_ACP_LOAD: '1',
    FAKE_ACP_DELETE: '1',
    FAKE_ACP_LINK_URL: linkUrl,
  });
  let agentPids: number[] = [];
  try {
    await waitForHooks(app);
    await setSurfaceLocal(app);
    await expect.poll(() => shellCount(app, '#localPanel')).toBe(1);
    expect((await localState(app)).cliPath).toBe('node');

    // Add a workspace → agent starts → ready with ACP v1 capabilities visible.
    const ws = await addWorkspace(app, workspace);
    expect(ws).toBeTruthy();
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('ready');
    let local = await localState(app);
    expect(local.agents[ws]?.protocolVersion).toBe(1);
    expect(local.agents[ws]?.capabilities).toEqual({ loadSession: true, sessionList: true, sessionDelete: true });
    expect(((await state(app)).settings as { workspaces: string[] }).workspaces).toContain(ws);
    await expect.poll(() => shellCount(app, '#agentBadge[data-status="ready"]')).toBe(1);
    await expect.poll(() => shellCount(app, `[data-workspace][data-status="ready"]`)).toBe(1);
    const firstPid = await agentPid(app, ws);
    expect(firstPid).toBeGreaterThan(0);
    agentPids = [firstPid];

    // New session through the shell button.
    expect(await shellClick(app, '#sessionNew')).toBe(true);
    await expect.poll(async () => Object.keys((await localState(app)).sessions).length).toBe(1);
    local = await localState(app);
    const sessionId = Object.keys(local.sessions)[0]!;
    await expect.poll(() => shellCount(app, `.session-item[data-session-id="${sessionId}"]`)).toBe(1);

    // Prompt "hello" via the composer: chunks concatenate, tool-call card + plan render.
    await typeAndSend(app, 'hello');
    await expect.poll(async () => (await localState(app)).sessions[sessionId]?.lastStopReason).toBe('end_turn');
    local = await localState(app);
    let session = local.sessions[sessionId]!;
    expect(session.running).toBe(false);
    expect(session.title).toBe('hello');
    expect(session.messages[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: 'hello' }] });
    expect(agentText(session)).toBe(`Hello from the fake agent. See [the pull request](${linkUrl}).`);
    const agentBlocks = session.messages[1]!.blocks;
    expect(agentBlocks[0]).toEqual({ type: 'thought', text: 'The user said something. I should reply politely.' });
    expect(agentBlocks.some((block) => block.type === 'tool_call')).toBe(true);
    expect(Object.values(session.toolCalls).some((call) => call.title === 'Read README.md' && call.status === 'completed')).toBe(true);
    expect(session.plan?.map((entry) => entry.status)).toEqual(['completed', 'in_progress', 'pending']);
    await expect.poll(() => shellCount(app, '#messageList .tool-call[data-status="completed"]')).toBe(1);
    expect(await shellCount(app, '#messageList .plan .plan-entry')).toBe(3);
    expect(await shellCount(app, '#messageList .thought')).toBe(1);
    expect(await shellCount(app, '#messageList .thought-body')).toBe(0); // collapsed by default
    expect(await shellClick(app, '#messageList .thought-toggle')).toBe(true);
    await expect.poll(() => shellCount(app, '#messageList .thought-body')).toBe(1);
    expect(await shellCount(app, '.session-item .history-label')).toBe(0);

    // GitHub link in the agent message → routed to the GitHub pane.
    expect(await shellCount(app, '#messageList .md a')).toBe(1);
    expect(await shellClick(app, '#messageList .md a')).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.url)).toContain(linkUrl);
    const linkEvents = (await readEvents(logFile)).filter((entry) => entry.event === 'link-open');
    expect(linkEvents.some((entry) => entry.view === 'local' && entry.decision === 'github-tab')).toBe(true);

    // Permission flow: card appears, choosing "Allow" lets the turn finish.
    await promptNoWait(app, sessionId, 'I need permission');
    await expect
      .poll(async () =>
        (await localState(app)).sessions[sessionId]?.pendingPermission?.options.map((o) => o.optionId),
      )
      .toEqual(['allow', 'reject']);
    await expect.poll(() => shellCount(app, '#messageList .permission-card')).toBe(1);
    expect(await shellCount(app, '.permission-option:not([disabled])')).toBe(2);
    expect(await shellClick(app, '.permission-option[data-option-id="allow"]')).toBe(true);
    await expect.poll(async () => (await localState(app)).sessions[sessionId]?.lastStopReason).toBe('end_turn');
    local = await localState(app);
    session = local.sessions[sessionId]!;
    expect(session.pendingPermission).toBeUndefined();
    expect(session.toolCalls['perm-1']?.status).toBe('completed');
    expect(agentText(session)).toContain('Permission granted, tests passed.');
    expect(await shellCount(app, '#messageList .permission-card')).toBe(0);
    const permissionEvents = (await readEvents(logFile)).filter((entry) => entry.event === 'permission-resolved');
    expect(permissionEvents).toHaveLength(1);

    // Cancel: "slow" streams for 5 s; Cancel in the composer → stopReason cancelled.
    await typeAndSend(app, 'please be slow');
    await expect.poll(async () => (await localState(app)).sessions[sessionId]?.running).toBe(true);
    await expect.poll(() => shellCount(app, '#cancelButton')).toBe(1);
    expect(await shellClick(app, '#cancelButton')).toBe(true);
    await expect.poll(async () => (await localState(app)).sessions[sessionId]?.lastStopReason).toBe('cancelled');
    await expect.poll(() => shellCount(app, '#stopReason[data-stop-reason="cancelled"]')).toBe(1);
    expect(await shellCount(app, '#sendButton')).toBe(1);

    // History from the agent: session/list + session/load replay.
    const listed = await listSessions(app, ws);
    expect(listed.map((entry) => entry.id)).toContain(sessionId);
    expect(listed.every((entry) => entry.historySource === 'agent')).toBe(true);
    expect(
      (await readEvents(logFile)).some(
        (entry) => entry.event === 'session-list' && (entry.detail as any)?.source === 'agent',
      ),
    ).toBe(true);
    local = await localState(app);
    session = local.sessions[sessionId]!;
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(3);
    expect(await loadSession(app, ws, sessionId)).toBeNull();
    local = await localState(app);
    session = local.sessions[sessionId]!;
    expect(session.loaded).toBe(true);
    expect(
      session.messages.filter((message) => message.role === 'user').map((m) => m.blocks[0]?.text),
    ).toEqual(['hello', 'I need permission', 'please be slow']);
    expect(agentText(session)).toContain('Hello from the fake agent.');
    expect((await readEvents(logFile)).some((entry) => entry.event === 'session-load')).toBe(true);

    // Crash: kill the agent process externally → crashed → next prompt restarts it.
    expect(processAlive(firstPid)).toBe(true);
    process.kill(firstPid);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('crashed');
    local = await localState(app);
    expect(local.agents[ws]?.restarts).toBe(1);
    await expect.poll(() => shellCount(app, '#agentBadge[data-status="crashed"]')).toBe(1);
    expect(await promptAndWait(app, sessionId, 'hello again')).toBe('end_turn');
    local = await localState(app);
    expect(local.agents[ws]?.status).toBe('ready');
    const secondPid = await agentPid(app, ws);
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);
    agentPids.push(secondPid);
    session = local.sessions[sessionId]!;
    expect(session.messages.at(-2)?.blocks[0]?.text).toBe('hello again');
    expect(
      (await readEvents(logFile)).some(
        (entry) => entry.event === 'session-rebound' && (entry.detail as any)?.via === 'load',
      ),
    ).toBe(true);

    // Delete (sessionCapabilities.delete): caps badge, one-click trash (no
    // confirm), running-refusal, and the agent's list no longer returns it.
    expect(
      ((await evaluateInShell(app, `document.getElementById('agentCaps')?.textContent`)) as string) ?? '',
    ).toContain('delete yes');
    const secondId = await newSession(app, ws);
    await expect.poll(() => shellCount(app, `.session-item[data-session-id="${secondId}"]`)).toBe(1);

    // Deleting while running is refused: the menu item is disabled and the
    // host-level delete throws.
    await promptNoWait(app, secondId, 'please be slow');
    await expect.poll(async () => (await localState(app)).sessions[secondId]?.running).toBe(true);
    await rightClick(app, `.session-item[data-session-id="${secondId}"]`);
    const runningDelete = await menuItem(app, 'Delete');
    expect(runningDelete).toBeTruthy();
    expect(runningDelete!.enabled).toBe(false);
    // Resolve the parked menu (Copy session id is a no-op here).
    await localMenuClick(app, (await menuItem(app, 'Copy session id'))!.id);
    const refusal = await app.evaluate(
      async (_e, id) => {
        try {
          await (globalThis as G).__devinworkspaces.localDeleteSession(id as string);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      secondId,
    );
    expect(refusal).toBe('cancel the running prompt before deleting');
    await app.evaluate(
      (_e, id) => (globalThis as G).__devinworkspaces.localCancel(id as string),
      secondId,
    );
    await expect.poll(async () => (await localState(app)).sessions[secondId]?.running).toBe(false);

    // Menu Delete → row and state drop; the agent no longer lists it.
    await rightClick(app, `.session-item[data-session-id="${secondId}"]`);
    const deleteItem = await menuItem(app, 'Delete');
    expect(deleteItem?.enabled).toBe(true);
    await localMenuClick(app, deleteItem!.id);
    await expect.poll(() => shellCount(app, `.session-item[data-session-id="${secondId}"]`)).toBe(0);
    await expect.poll(async () => (await localState(app)).sessions[secondId]).toBeUndefined();
    const deleteEvents = (await readEvents(logFile)).filter(
      (entry) => entry.event === 'session-delete',
    );
    expect(deleteEvents.some((entry) => (entry.detail as any)?.sessionId === secondId)).toBe(true);
    const afterDelete = await listSessions(app, ws);
    expect(afterDelete.map((entry) => entry.id)).not.toContain(secondId);

    // Delete all: header trash → inline confirm with the count; running
    // prompts are cancelled first. The first session is still around, so two
    // new sessions make three.
    const bulkA = await newSession(app, ws);
    await newSession(app, ws);
    await expect.poll(() => shellCount(app, '.session-item')).toBe(3);
    await promptNoWait(app, bulkA, 'please be slow');
    await expect.poll(async () => (await localState(app)).sessions[bulkA]?.running).toBe(true);
    await rightClickWorkspace(app, ws);
    const deleteAllItem = await menuItem(app, 'Delete all sessions…');
    expect(deleteAllItem?.enabled).toBe(true);
    await localMenuClick(app, deleteAllItem!.id);
    await expect.poll(() => shellCount(app, '#sessionDeleteAllConfirm')).toBe(1);
    const confirmLabel = await evaluateInShell(
      app,
      `document.getElementById('sessionDeleteAllConfirm')?.textContent ?? ''`,
    );
    expect(confirmLabel).toContain('Delete');
    expect(confirmLabel).toContain('3');
    // Cancel keeps everything.
    expect(await shellClick(app, '#sessionDeleteAllCancel')).toBe(true);
    await expect.poll(() => shellCount(app, '#sessionDeleteAllConfirm')).toBe(0);
    expect(await shellCount(app, '.session-item')).toBe(3);
    // Confirm → all rows and state drop, including the running one.
    await rightClickWorkspace(app, ws);
    await localMenuClick(app, (await menuItem(app, 'Delete all sessions…'))!.id);
    await expect.poll(() => shellCount(app, '#sessionDeleteAllConfirm')).toBe(1);
    expect(await shellClick(app, '#sessionDeleteAllConfirm')).toBe(true);
    await expect.poll(() => shellCount(app, '.session-item')).toBe(0);
    await expect
      .poll(async () =>
        Object.values((await localState(app)).sessions).filter((s) => s.workspace === ws).length,
      )
      .toBe(0);
    const deleteAllEvent = (await readEvents(logFile)).find(
      (entry) => entry.event === 'session-delete-all',
    );
    expect(deleteAllEvent).toBeTruthy();
    expect((deleteAllEvent!.detail as any)?.deleted).toBe(3);
    expect((deleteAllEvent!.detail as any)?.cancelled).toBe(1);
    expect((deleteAllEvent!.detail as any)?.failed).toBe(0);
    expect(await listSessions(app, ws)).toEqual([]);

    // Markdown rendering must not trip the shell CSP (no inline styles/scripts).
    const consoleEvents = (await readEvents(logFile)).filter((entry) => entry.event === 'console-message');
    // (the pre-existing "frame-ancestors is ignored when delivered via <meta>" notice is not a violation)
    expect(
      consoleEvents.filter((entry) => /Refused to/i.test(String((entry.detail as any)?.message))),
    ).toEqual([]);
    // Prompt text is never logged — only lengths/ids.
    expect(
      (await readEvents(logFile)).some((entry) => JSON.stringify(entry.detail ?? {}).includes('please be slow')),
    ).toBe(false);

    // Shutdown stops the agent child.
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
    await expect.poll(() => agentPids.some(processAlive)).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    for (const pid of agentPids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Local: fake agent without list/load — local-index history, load error, crash rebinds to a fresh remote session, index persists', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-local-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const env = { DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD, DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1' };
  let app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, env);
  const agentPids: number[] = [];
  try {
    await waitForHooks(app);
    await setSurfaceLocal(app);
    const ws = await addWorkspace(app, workspace);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('ready');
    expect((await localState(app)).agents[ws]?.capabilities).toEqual({
      loadSession: false,
      sessionList: false,
      sessionDelete: false,
    });
    // No delete capability → the badge reports delete no and rows have no trash.
    expect(
      ((await evaluateInShell(app, `document.getElementById('agentCaps')?.textContent`)) as string) ?? '',
    ).toContain('delete no');
    agentPids.push(await agentPid(app, ws));

    const sessionId = await newSession(app, ws);
    expect(sessionId).toBeTruthy();
    expect((await localState(app)).sessions[sessionId]?.historySource).toBe('local-index');
    expect(await promptAndWait(app, sessionId, 'hello')).toBe('end_turn');

    // Session list falls back to the app-local index and the UI labels it.
    const listed = await listSessions(app, ws);
    expect(listed).toEqual([
      { id: sessionId, workspace: ws, title: 'hello', createdAt: expect.any(String), historySource: 'local-index' },
    ]);
    expect(
      (await readEvents(logFile)).some(
        (entry) => entry.event === 'session-list' && (entry.detail as any)?.source === 'local-index',
      ),
    ).toBe(true);
    await expect
      .poll(() => shellCount(app, `.session-item[data-session-id="${sessionId}"] .history-label`))
      .toBe(1);
    expect(
      (await evaluateInShell(app, `document.querySelector('.session-item .history-label').textContent`)) as string,
    ).toBe('history not supported by agent');
    // No delete capability: the session-menu Delete and the workspace-menu
    // Delete-all items are both disabled.
    await rightClick(app, `.session-item[data-session-id="${sessionId}"]`);
    expect((await menuItem(app, 'Delete'))?.enabled).toBe(false);
    await localMenuClick(app, (await menuItem(app, 'Copy session id'))!.id);
    await rightClickWorkspace(app, ws);
    expect((await menuItem(app, 'Delete all sessions…'))?.enabled).toBe(false);
    // Rename… → inline input; Escape cancels it (also resolves the menu).
    await localMenuClick(app, (await menuItem(app, 'Rename…'))!.id);
    await expect.poll(() => shellCount(app, '#sessionFolderEdit')).toBe(1);
    await evaluateInShell(
      app,
      `document.getElementById('sessionFolderEdit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    await expect.poll(() => shellCount(app, '#sessionFolderEdit')).toBe(0);

    // session/load is refused when the agent lacks loadSession.
    expect(await loadSession(app, ws, sessionId)).toBe('history not supported by agent');
    const localSessionsFile = join(profile, 'local-sessions.json');
    expect(existsSync(localSessionsFile)).toBe(true);
    expect(JSON.parse(readFileSync(localSessionsFile, 'utf8')).sessions[0]).toMatchObject({
      id: sessionId,
      workspace: ws,
      title: 'hello',
    });

    // Crash without loadSession: UI history is kept, a fresh remote session is bound.
    process.kill(agentPids[0]!);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('crashed');
    const messagesBefore = (await localState(app)).sessions[sessionId]!.messages.length;
    expect(await promptAndWait(app, sessionId, 'after crash')).toBe('end_turn');
    const after = (await localState(app)).sessions[sessionId]!;
    expect(after.messages.length).toBe(messagesBefore + 2);
    expect((await localState(app)).agents[ws]?.status).toBe('ready');
    expect(
      (await readEvents(logFile)).some(
        (entry) => entry.event === 'session-rebound' && (entry.detail as any)?.via === 'new',
      ),
    ).toBe(true);
    agentPids.push(await agentPid(app, ws));

    // Relaunch: workspace persisted in settings, index still lists the session.
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
    await expect.poll(() => agentPids.some(processAlive)).toBe(false);
    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, env);
    await waitForHooks(app);
    expect(Object.keys((await localState(app)).agents)).toEqual([ws]);
    const relisted = await listSessions(app, ws);
    expect(relisted.map((entry) => [entry.id, entry.title, entry.historySource])).toEqual([
      [sessionId, 'hello', 'local-index'],
    ]);
    agentPids.push(await agentPid(app, ws));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 2);
    await app.close();
    await expect.poll(() => agentPids.some(processAlive)).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    for (const pid of agentPids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Local composer: native editing shortcuts work (Ctrl+A/C/V/X/Z) — regression guard', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-composer-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const agentPids: number[] = [];
  try {
    await waitForHooks(app);
    await setSurfaceLocal(app);
    const ws = await addWorkspace(app, workspace);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('ready');
    agentPids.push(await agentPid(app, ws));
    const sessionId = await newSession(app, ws);
    expect(sessionId).toBeTruthy();

    const page = await shellPage(app);
    await expect.poll(() => shellCount(app, `.session-item[data-session-id="${sessionId}"]`)).toBe(1);
    expect(await shellClick(app, `.session-item[data-session-id="${sessionId}"]`)).toBe(true);
    await page.waitForSelector('#composer:not([disabled])');
    const composer = page.locator('#composer');
    await composer.click();
    await page.keyboard.type('clip text');

    // Ctrl+A selects all; Ctrl+C writes the selection to the OS clipboard.
    await page.keyboard.press('Control+a');
    await app.evaluate((_e, text) => (globalThis as G).__devinworkspaces.clipboardWrite(text as string), '__seed__');
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => app.evaluate(() => (globalThis as G).__devinworkspaces.clipboardRead()))
      .toBe('clip text');

    // Ctrl+V pastes; Ctrl+X cuts; Ctrl+Z undoes.
    await app.evaluate((_e, text) => (globalThis as G).__devinworkspaces.clipboardWrite(text as string), 'PASTED');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+v');
    await expect.poll(async () => composer.inputValue()).toBe('PASTED');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+x');
    await expect.poll(async () => composer.inputValue()).toBe('');
    await expect
      .poll(async () => app.evaluate(() => (globalThis as G).__devinworkspaces.clipboardRead()))
      .toBe('PASTED');
    await page.keyboard.press('Control+z');
    await expect.poll(async () => composer.inputValue()).toBe('PASTED');

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
  } finally {
    await app.close().catch(() => undefined);
    for (const pid of agentPids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Local composer keeps unsent text across a surface switch', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-draft-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const agentPids: number[] = [];
  try {
    await waitForHooks(app);
    await setSurfaceLocal(app);
    const ws = await addWorkspace(app, workspace);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('ready');
    agentPids.push(await agentPid(app, ws));
    const sessionId = await newSession(app, ws);
    expect(sessionId).toBeTruthy();

    const page = await shellPage(app);
    await expect.poll(() => shellCount(app, `.session-item[data-session-id="${sessionId}"]`)).toBe(1);
    expect(await shellClick(app, `.session-item[data-session-id="${sessionId}"]`)).toBe(true);
    await page.waitForSelector('#composer:not([disabled])');
    const composer = page.locator('#composer');
    await composer.click();
    await page.keyboard.type('keep me');

    await evaluateInShell(app, "window.devinworkspaces.setSurface('settings')");
    await page.waitForSelector('#composer', { state: 'detached' });
    await evaluateInShell(app, "window.devinworkspaces.setSurface('local')");
    await page.waitForSelector('#composer:not([disabled])');

    await expect.poll(() => page.locator('#composer').inputValue()).toBe('keep me');
    await expect(page.locator('#sendButton')).toBeEnabled();

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
  } finally {
    await app.close().catch(() => undefined);
    for (const pid of agentPids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Local: thinking indicator and token usage while a prompt runs', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-thinking-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_USAGE: '1',
    FAKE_ACP_PROMPT_DELAY_MS: '1500',
  });
  try {
    await waitForHooks(app);
    await setSurfaceLocal(app);
    const ws = await addWorkspace(app, workspace);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('ready');
    const sessionId = await newSession(app, ws);
    await expect
      .poll(() => shellCount(app, `.session-item[data-session-id="${sessionId}"]`))
      .toBe(1);
    expect(await shellClick(app, `.session-item[data-session-id="${sessionId}"]`)).toBe(true);

    // In-flight: the thinking indicator with elapsed time shows.
    await promptNoWait(app, sessionId, 'hello');
    await expect.poll(async () => (await localState(app)).sessions[sessionId]?.running).toBe(true);
    await expect.poll(() => shellCount(app, '#thinking')).toBe(1);
    await expect
      .poll(async () =>
        evaluateInShell(app, `document.getElementById('thinking')?.textContent ?? ''`),
      )
      .toContain('Thinking…');

    // Turn done: indicator gone, elapsed summary + usage badge rendered.
    await expect
      .poll(async () => (await localState(app)).sessions[sessionId]?.running)
      .toBe(false);
    await expect.poll(() => shellCount(app, '#thinking')).toBe(0);
    await expect
      .poll(async () =>
        evaluateInShell(app, `document.getElementById('turnSummary')?.textContent ?? ''`),
      )
      .toContain('Took ');
    const usageText = (await evaluateInShell(
      app,
      `document.getElementById('tokenUsage')?.textContent ?? ''`,
    )) as string;
    expect(usageText).toContain('1.2k / 200k ctx');
    expect(usageText).toContain('↑1.0k');
    expect(usageText).toContain('↓234');
    const tooltip = (await evaluateInShell(
      app,
      `document.getElementById('tokenUsage')?.getAttribute('title') ?? ''`,
    )) as string;
    expect(tooltip).toContain('Context: 1,234 / 200,000');
    expect(tooltip).toContain('Total: 1,234');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('terminal handoff: devin -r takes the session lock; closing reclaims it', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-local-'));
  const logFile = join(profile, 'events.jsonl');
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    DEVIN_WORKSPACES_TEST_TERMINAL_CMD: 'node out/fixtures/fakePty.cjs',
    FAKE_ACP_LOAD: '1',
    FAKE_ACP_PROMPT_DELAY_MS: '4000',
  });
  try {
    await waitForHooks(app);
    await setSurfaceLocal(app);
    const ws = await addWorkspace(app, workspace);
    await expect.poll(async () => (await localState(app)).agents[ws]?.status).toBe('ready');
    const sessionId = await newSession(app, ws);
    const secondId = await newSession(app, ws);
    await expect
      .poll(() => shellCount(app, `.session-item[data-session-id="${sessionId}"]`))
      .toBe(1);
    await shellClick(app, `.session-item[data-session-id="${sessionId}"]`);
    const pidBefore = await agentPid(app, ws);
    expect(pidBefore).toBeGreaterThan(0);

    // Refusal: the handoff restarts the workspace agent, so it is refused
    // while ANY session in the workspace is still running.
    await promptNoWait(app, secondId, 'slow turn');
    await expect
      .poll(async () => (await localState(app)).sessions[secondId]?.running)
      .toBe(true);
    expect(await shellClick(app, '#view-terminal')).toBe(true);
    await expect
      .poll(async () =>
        evaluateInShell(
          app,
          `document.getElementById('terminalPane')?.textContent ?? ''`,
        ),
      )
      .toContain('still running');
    await expect
      .poll(async () => (await localState(app)).sessions[sessionId]?.terminalOwned ?? false)
      .toBe(false);
    expect(
      (await readEvents(logFile)).some((entry) => entry.event === 'agent-restart'),
    ).toBe(false);

    // Once the busy session finishes the open succeeds.
    await expect
      .poll(async () => (await localState(app)).sessions[secondId]?.running)
      .toBe(false);

    // Opening a devin terminal for the session: agent restarts to release the
    // CLI's per-session lock; chat is disabled while the pty owns it.
    const opened = await app.evaluate(
      (_e, args: { ws: string; sid: string }) =>
        (globalThis as G).__devinworkspaces.terminalOpen({
          kind: 'devin',
          workspace: args.ws,
          sessionId: args.sid,
        }),
      { ws, sid: sessionId },
    );
    expect(opened.ok).toBe(true);
    await waitForEvent(logFile, 'agent-restart');
    expect(
      (await readEvents(logFile)).some(
        (entry) =>
          entry.event === 'agent-restart' &&
          (entry.detail as { reason?: string } | undefined)?.reason === 'terminal-handoff',
      ),
    ).toBe(true);
    await expect.poll(() => agentPid(app, ws)).not.toBe(pidBefore);
    await expect.poll(async () => (await localState(app)).sessions[sessionId]?.terminalOwned).toBe(
      true,
    );
    await expect.poll(() => shellCount(app, '#terminalOwnedBanner')).toBe(1);
    expect(await evaluateInShell(app, `document.getElementById('composer')?.disabled ?? null`)).toBe(true);
    expect(await evaluateInShell(app, `document.getElementById('sendButton')?.disabled ?? null`)).toBe(true);

    // Chat for an owned session refuses.
    await expect(promptAndWait(app, sessionId, 'hi')).rejects.toThrow(
      'session is open in the Terminal tab',
    );

    // Close the terminal -> chat reclaims the session (fresh load).
    await app.evaluate(
      (_e, id: string) => (globalThis as G).__devinworkspaces.terminalClose(id),
      opened.ok ? opened.id : '',
    );
    await waitForEvent(logFile, 'session-load');
    expect(
      (await readEvents(logFile)).some(
        (entry) =>
          entry.event === 'session-load' &&
          (entry.detail as { sessionId?: string } | undefined)?.sessionId === sessionId,
      ),
    ).toBe(true);
    await expect
      .poll(async () => (await localState(app)).sessions[sessionId]?.terminalOwned ?? false)
      .toBe(false);
    await expect.poll(() => shellCount(app, '#terminalOwnedBanner')).toBe(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ux2 P4a — the workspace sidebar itself: sections at start, DnD reorder,
// collapse, rename, remove, sessions-column toggle, WSL host chip.
test('Local sidebar: sections list at start, reorder/collapse/rename persist, context-menu new/remove, WSL chip, toggle off', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-side-'));
  const wsA = mkdtempSync(join(tmpdir(), 'devin-workspaces-wsA-'));
  const wsB = mkdtempSync(join(tmpdir(), 'devin-workspaces-wsB-'));
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_LIST: '1',
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
  });
  const hasSection = (path: string) =>
    evaluateInShell(
      app,
      `[...document.querySelectorAll('[data-section-name]')].some((e) => e.getAttribute('data-section-name') === ${JSON.stringify(path)})`,
    ) as Promise<boolean>;
  const sectionLabel = (path: string) =>
    evaluateInShell(
      app,
      `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(path)})?.querySelector('[data-section-label]')?.textContent ?? ''`,
    ) as Promise<string>;
  const dndSections = (from: string, to: string) =>
    evaluateInShell(
      app,
      `(() => {
        const els = [...document.querySelectorAll('[data-section-name]')];
        const src = els.find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(from)});
        const tgt = els.find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(to)});
        if (!src || !tgt) return false;
        const dt = new DataTransfer();
        const fire = (el, t) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(src, 'dragstart'); fire(tgt, 'dragover'); fire(tgt, 'drop'); fire(src, 'dragend');
        return true;
      })()`,
    );
  try {
    await waitForHooks(app);
    const a = await addWorkspace(app, wsA);
    const b = await addWorkspace(app, wsB);
    const wslWs = `${uncRoot}\\home\\u\\ws`;
    const w = await addWorkspace(app, wslWs);
    await expect.poll(async () => (await localState(app)).agents[a]?.status).toBe('ready');
    await expect.poll(async () => (await localState(app)).agents[b]?.status).toBe('ready');
    // Sessions in BOTH workspaces, created before the surface opens.
    const sa = await newSession(app, a);
    const sb = await newSession(app, b);

    await setSurfaceLocal(app);
    await expect.poll(() => shellCount(app, '[data-sidebar="local"]')).toBe(1);
    // Both sections list their rows without any selection click.
    await expect.poll(() => shellCount(app, '.session-item')).toBe(2);
    expect(await hasSection(a)).toBe(true);
    expect(await hasSection(b)).toBe(true);
    expect(await hasSection(w)).toBe(true);
    expect(await shellCount(app, `.session-item[data-session-id="${sa}"]`)).toBe(1);
    expect(await shellCount(app, `.session-item[data-session-id="${sb}"]`)).toBe(1);

    // WSL workspace → host chip in its header.
    const chip = (await evaluateInShell(
      app,
      `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(w)})?.querySelector('[data-host-chip]')?.textContent ?? ''`,
    )) as string;
    expect(chip).toBe('Fake');

    // DnD reorder: B before A → settings.workspaces order follows.
    expect(await dndSections(b, a)).toBe(true);
    await expect
      .poll(async () => ((await state(app)).settings as { workspaces: string[] }).workspaces)
      .toEqual([b, a, w]);

    // Collapse A → rows gone, persisted in local.collapsedWorkspaces.
    await evaluateInShell(
      app,
      `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(a)})?.click()`,
    );
    await expect.poll(() => shellCount(app, `.session-item[data-session-id="${sa}"]`)).toBe(0);
    await expect
      .poll(async () =>
        ((await state(app)).settings as unknown as { local: { collapsedWorkspaces: string[] } }).local
          .collapsedWorkspaces,
      )
      .toContain(a);

    // Rename A → persisted in local.workspaceLabels, header shows the label.
    await rightClickWorkspace(app, a);
    await localMenuClick(app, (await menuItem(app, 'Rename…'))!.id);
    await expect.poll(() => shellCount(app, '#sessionFolderEdit')).toBe(1);
    const page = await shellPage(app);
    await page.locator('#sessionFolderEdit').fill('Renamed A');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () =>
        ((await state(app)).settings as unknown as { local: { workspaceLabels: Record<string, string> } })
          .local.workspaceLabels[a],
      )
      .toBe('Renamed A');
    await expect.poll(() => sectionLabel(a)).toBe('Renamed A');

    // Context-menu New session on B → a session in B's workspace.
    await rightClickWorkspace(app, b);
    await localMenuClick(app, (await menuItem(app, 'New session'))!.id);
    await expect.poll(async () => {
      const local = await localState(app);
      return Object.values(local.sessions).filter((s) => s.workspace === b).length;
    }).toBe(2);
    await expect
      .poll(async () => (await state(app)).localSessionId)
      .not.toBeNull();

    // Remove A via the workspace menu → agent stopped + section gone.
    await rightClickWorkspace(app, a);
    await localMenuClick(app, (await menuItem(app, 'Remove workspace'))!.id);
    await expect.poll(() => hasSection(a)).toBe(false);
    await expect
      .poll(async () => (await localState(app)).agents[a])
      .toBeUndefined();

    // Sessions-column toggle off → no sidebar, LocalPanel still spans.
    await evaluateInShell(
      app,
      `window.devinworkspaces.setSettings({ sessions: { open: false } })`,
    );
    await expect.poll(() => shellCount(app, '[data-sidebar="local"]')).toBe(0);
    expect(await shellCount(app, '#localPanel')).toBe(1);

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
    rmSync(uncRoot, { recursive: true, force: true });
  }
});

// Regression: workspaces already in settings.json must get their agents
// started at launch — the sidebar lists on the ready transition, and nothing
// else spawns an agent before the user acts.
test('Local startup: configured workspaces autostart their agents and list in the sidebar', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-autostart-'));
  const wsA = mkdtempSync(join(tmpdir(), 'devin-workspaces-wsA-'));
  const wsB = mkdtempSync(join(tmpdir(), 'devin-workspaces-wsB-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ workspaces: [wsA, wsB] }));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_LIST: '1',
  });
  try {
    await waitForHooks(app);
    // No user action: both agents come up on their own.
    await expect.poll(async () => (await localState(app)).agents[wsA]?.status).toBe('ready');
    await expect.poll(async () => (await localState(app)).agents[wsB]?.status).toBe('ready');
    const events = await readEvents(logFile);
    const autostart = events.find((entry) => entry.event === 'agents-autostart');
    expect(autostart).toBeDefined();
    expect((autostart!.detail as any)?.count).toBe(2);
    expect(events.filter((entry) => entry.event === 'agent-start')).toHaveLength(2);
    // The ready hook lists each workspace exactly once (no double list).
    await expect
      .poll(async () =>
        (await readEvents(logFile)).filter(
          (entry) => entry.event === 'session-list' && (entry.detail as any)?.source === 'agent',
        ).length,
      )
      .toBe(2);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    expect(
      (await readEvents(logFile)).filter(
        (entry) => entry.event === 'session-list' && (entry.detail as any)?.source === 'agent',
      ),
    ).toHaveLength(2);

    await setSurfaceLocal(app);
    await expect.poll(() => shellCount(app, '[data-sidebar="local"]')).toBe(1);
    await expect
      .poll(() =>
        evaluateInShell(
          app,
          `[...document.querySelectorAll('[data-section-name]')].map((e) => e.getAttribute('data-section-name')).sort()`,
        ),
      )
      .toEqual([wsA, wsB].sort());
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  }
});

// Negative: a configured workspace with no devin binary (local.devinPath
// points nowhere, no test command) stays missing-cli — nothing is spawned.
test('Local startup: missing CLI leaves configured workspaces missing-cli without spawning', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-autostart-nocli-'));
  const wsA = mkdtempSync(join(tmpdir(), 'devin-workspaces-wsA-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ workspaces: [wsA], local: { devinPath: join(profile, 'missing', 'devin.exe') } }),
  );
  const env: Record<string, string> = { DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1' };
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, env);
  try {
    await waitForHooks(app);
    await waitForEvent(logFile, 'agents-autostart');
    const events = await readEvents(logFile);
    const autostart = events.find((entry) => entry.event === 'agents-autostart');
    expect((autostart!.detail as any)?.count).toBe(0);
    expect((autostart!.detail as any)?.skipped).toBe(1);
    const local = await localState(app);
    expect(local.cliPath).toBeNull();
    expect(local.agents[wsA]?.status).toBe('missing-cli');
    expect(events.some((entry) => entry.event === 'agent-start')).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
    rmSync(wsA, { recursive: true, force: true });
  }
});
