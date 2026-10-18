import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { evaluateInShell, launchApp, readEvents, shellPage, state } from './helpers';

type LocalState = {
  agents: Record<string, { status: string }>;
  sessions: Record<string, { id: string; running: boolean; lastStopReason?: string }>;
};

type Hooks = {
  localState(): LocalState;
  localAddWorkspace(path: string): string | null;
  localNewSession(workspace: string): Promise<string>;
  localPrompt(sessionId: string, text: string): Promise<string>;
  localListSessions(workspace: string): Promise<Array<{ id: string }>>;
  setSurface(value: 'cloud' | 'local' | 'settings'): void;
  listScopes(): Array<{ scope: string; count: number }>;
  terminalClose(id: string): boolean;
};

type G = typeof globalThis & { __devinworkspaces: Hooks };

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function localState(app: ElectronApplication): Promise<LocalState> {
  return app.evaluate(() => (globalThis as G).__devinworkspaces.localState());
}

async function shellCount(app: ElectronApplication, selector: string): Promise<number> {
  return (await evaluateInShell(
    app,
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  )) as number;
}

async function shellClick(app: ElectronApplication, selector: string): Promise<boolean> {
  return (await evaluateInShell(
    app,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
  )) as boolean;
}

// Drive the React composer like a user: native setter + input + Enter.
async function typeAndSend(app: ElectronApplication, text: string): Promise<void> {
  const ok = await evaluateInShell(
    app,
    `(() => {
      const el = document.getElementById('composer');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`,
  );
  expect(ok).toBe(true);
}

test('local sessions get their own GitHub tab scope and devin terminal', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-lscope-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devin-workspaces-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_LOCAL_AGENT_CMD: 'node out/fixtures/fakeAcpAgent.cjs',
    FAKE_ACP_LIST: '1',
    FAKE_ACP_LOAD: '1',
    FAKE_ACP_DELETE: '1',
    FAKE_ACP_LINK_URL: `${fixtures.githubUrl}/page/pr-1`,
    DEVIN_WORKSPACES_TEST_TERMINAL_CMD: 'node out/fixtures/fakePty.cjs',
  });
  const agentPids: number[] = [];
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__devinworkspaces)))
      .toBe(true);
    await app.evaluate(() => (globalThis as G).__devinworkspaces.setSurface('local'));
    const page = await shellPage(app);
    await page.waitForSelector('#localPanel', { timeout: 10_000 });

    const ws = await app.evaluate(
      (_e, p) => (globalThis as G).__devinworkspaces.localAddWorkspace(p as string),
      workspace,
    );
    await expect.poll(async () => (await localState(app)).agents[ws!]?.status).toBe('ready');

    const sessionA = await app.evaluate(
      (_e, w) => (globalThis as G).__devinworkspaces.localNewSession(w as string),
      ws,
    );
    const sessionB = await app.evaluate(
      (_e, w) => (globalThis as G).__devinworkspaces.localNewSession(w as string),
      ws,
    );
    await expect
      .poll(() => shellCount(app, '.session-item[data-session-id]'))
      .toBe(2);

    // Select A → scope follows the local session.
    expect(await shellClick(app, `.session-item[data-session-id="${sessionA}"]`)).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe(`local:${sessionA}`);
    expect((await state(app)).localSessionId).toBe(sessionA);

    // Prompt in A, click the reply link → tab lands in local:A.
    await typeAndSend(app, 'hello from A');
    await expect
      .poll(async () => (await localState(app)).sessions[sessionA]?.lastStopReason)
      .toBe('end_turn');
    await expect.poll(() => shellCount(app, '#messageList .md a')).toBe(1);
    expect(await shellClick(app, '#messageList .md a')).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(1);
    const tabA = (await state(app)).tabs.tabs[0]!.id;
    expect((await state(app)).tabs.scope).toBe(`local:${sessionA}`);

    // Switch to B → A's tab is hidden in its own scope.
    expect(await shellClick(app, `.session-item[data-session-id="${sessionB}"]`)).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe(`local:${sessionB}`);
    expect((await state(app)).tabs.tabs.length).toBe(0);
    expect((await state(app)).tabs.hiddenTabCount).toBe(1);

    // Prompt in B → its own tab (dedupe is per-scope, so a separate id).
    await typeAndSend(app, 'hello from B');
    await expect
      .poll(async () => (await localState(app)).sessions[sessionB]?.lastStopReason)
      .toBe('end_turn');
    expect(await shellClick(app, '#messageList .md a')).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(1);
    const tabB = (await state(app)).tabs.tabs[0]!.id;
    expect(tabB).not.toBe(tabA);

    // Back to A → A's tab returns.
    expect(await shellClick(app, `.session-item[data-session-id="${sessionA}"]`)).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.tabs.map((t) => t.id)).toEqual([tabA]);

    // Cloud surface → the local scope is hidden; the strip serves the cloud scope.
    await app.evaluate(() => (globalThis as G).__devinworkspaces.setSurface('cloud'));
    await expect
      .poll(async () => (await state(app)).tabs.scope.startsWith('local:'))
      .toBe(false);
    expect((await state(app)).tabs.hiddenTabCount).toBe(2);

    // Back to Local → the panel re-selects A (selection lives in main), and no
    // transient `active-session` null event is emitted during the remount.
    const eventMark = (await readEvents(logFile)).length;
    await app.evaluate(() => (globalThis as G).__devinworkspaces.setSurface('local'));
    await expect
      .poll(async () =>
        (await readEvents(logFile))
          .slice(eventMark)
          .filter((e) => e.event === 'active-session').length,
      )
      .toBeGreaterThanOrEqual(1);
    const activeEvents = (await readEvents(logFile))
      .slice(eventMark)
      .filter((e) => e.event === 'active-session');
    expect(
      activeEvents.every((e) => (e.detail as { sessionId?: string })?.sessionId === sessionA),
    ).toBe(true);
    await expect.poll(async () => (await state(app)).localSessionId).toBe(sessionA);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe(`local:${sessionA}`);
    await expect
      .poll(() => shellCount(app, `.session-item[data-session-id="${sessionA}"].bg-\\[\\#27364a\\]`))
      .toBe(1);

    // Terminals: A's Terminal tab opens a devin pty keyed to A.
    await page.waitForSelector('#view-terminal:not([disabled])', { timeout: 10_000 });
    await page.click('#view-terminal');
    await expect
      .poll(
        async () =>
          (await state(app)).terminals.find((t) => t.kind === 'devin' && t.sessionId === sessionA)?.id,
      )
      .toBeTruthy();

    // Select B (still on the Terminal view) → a second pty for B; A's stays.
    expect(await shellClick(app, `.session-item[data-session-id="${sessionB}"]`)).toBe(true);
    await expect
      .poll(
        async () =>
          (await state(app)).terminals.find(
            (t) => t.kind === 'devin' && t.sessionId === sessionB,
          )?.id,
      )
      .toBeTruthy();
    const ptyB = (await state(app)).terminals.find(
      (t) => t.sessionId === sessionB,
    )!.id;
    expect((await state(app)).terminals.filter((t) => t.kind === 'devin').length).toBe(2);

    // Containers: only the selected session's terminal is displayed.
    const displays = (await evaluateInShell(
      app,
      `(() => {
        const get = (sid) => document.querySelector('[data-session-terminal="' + sid + '"]')?.style.display ?? 'missing';
        return { a: get(${JSON.stringify(sessionA)}), b: get(${JSON.stringify(sessionB)}) };
      })()`,
    )) as { a: string; b: string };
    expect(displays.b).toBe('flex');
    expect(displays.a).toBe('none');

    // Back to A → reuse (still 2 devin ptys), A's view visible again.
    expect(await shellClick(app, `.session-item[data-session-id="${sessionA}"]`)).toBe(true);
    await expect
      .poll(async () => (await state(app)).terminals.filter((t) => t.kind === 'devin').length)
      .toBe(2);
    await expect
      .poll(async () =>
        evaluateInShell(
          app,
          `document.querySelector('[data-session-terminal="${sessionA}"]')?.style.display`,
        ),
      )
      .toBe('flex');

    // Delete B via the trash → its pty is closed and its scope is gone.
    expect(await shellClick(app, `.session-delete[data-session-id="${sessionB}"]`)).toBe(true);
    await expect.poll(async () => (await localState(app)).sessions[sessionB]).toBeUndefined();
    await expect
      .poll(async () =>
        (await state(app)).terminals.some((t) => t.id === ptyB),
      )
      .toBe(false);
    const events = await readEvents(logFile);
    expect(
      events.some(
        (e) => e.event === 'session-delete' && (e.detail as { sessionId?: string })?.sessionId === sessionB,
      ),
    ).toBe(true);
    expect(events.some((e) => e.event === 'terminal-close')).toBe(true);
    // forgetDeletedSession closes the scope asynchronously after the state
    // update — poll the log instead of a one-shot read.
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some((e) => e.event === 'tabs-scope-closed'),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await app.evaluate(() => (globalThis as G).__devinworkspaces.listScopes())).map(
          (s) => s.scope,
        ),
      )
      .not.toContain(`local:${sessionB}`);
    const listed = await app.evaluate(
      (_e, w) => (globalThis as G).__devinworkspaces.localListSessions(w as string),
      ws,
    );
    expect(listed.map((entry) => entry.id)).not.toContain(sessionB);

    // quit() may exit before the IPC reply — fire it off and bound the close.
    void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    closed = true;
  } finally {
    if (!closed) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
    }
    await Promise.race([
      app.close().then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    try {
      const proc = app.process();
      if (proc && proc.exitCode === null) proc.kill();
    } catch {
      // already gone
    }
    for (const pid of agentPids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    // ConPTY children can hold the temp dirs briefly after quit — retry.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
});
