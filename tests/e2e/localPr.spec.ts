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
  setSurface(value: 'cloud' | 'local' | 'settings'): void;
  terminalInput(id: string, data: string): boolean;
};

type G = typeof globalThis & { __agentworkspace: Hooks };

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function localState(app: ElectronApplication): Promise<LocalState> {
  return app.evaluate(() => (globalThis as G).__agentworkspace.localState());
}

async function shellClick(app: ElectronApplication, selector: string): Promise<boolean> {
  return (await evaluateInShell(
    app,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
  )) as boolean;
}

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

async function autoOpenEvents(app: ElectronApplication, logFile: string) {
  return (await readEvents(logFile)).filter((e) => e.event === 'pr-auto-open');
}

test('local PR urls auto-open lazy tabs from chat and the devin pty', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-lpr-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const chatPrUrl = `${fixtures.githubUrl}/acme/widgets/pull/7`;
  const termPrUrl = `${fixtures.githubUrl}/acme/widgets/pull/8`;
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: 'node out/fixtures/fakeAcpAgent.cjs',
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_LIST: '1',
    FAKE_ACP_LOAD: '1',
    FAKE_ACP_LINK_URL: chatPrUrl,
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: 'node out/fixtures/fakePty.cjs',
  });
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
      .toBe(true);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('local'));
    const page = await shellPage(app);
    await page.waitForSelector('#localPanel', { timeout: 10_000 });

    const ws = await app.evaluate(
      (_e, p) => (globalThis as G).__agentworkspace.localAddWorkspace(p as string),
      workspace,
    );
    await expect.poll(async () => (await localState(app)).agents[ws!]?.status).toBe('ready');
    const sessionA = await app.evaluate(
      (_e, w) => (globalThis as G).__agentworkspace.localNewSession(w as string),
      ws,
    );
    await page.waitForSelector(`.session-item[data-session-id="${sessionA}"]`);
    expect(await shellClick(app, `.session-item[data-session-id="${sessionA}"]`)).toBe(true);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe(`local:${sessionA}`);

    // Chat path: the reply contains a PR URL → lazy tab in local:A, no click.
    await typeAndSend(app, 'open a pr');
    await expect
      .poll(async () => (await localState(app)).sessions[sessionA]?.lastStopReason)
      .toBe('end_turn');
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(1);
    await expect
      .poll(async () => (await autoOpenEvents(app, logFile)).length)
      .toBe(1);
    const first = (await autoOpenEvents(app, logFile))[0]!;
    expect(first.url).toBe(chatPrUrl);
    expect((first.detail as { source?: string }).source).toBe('local-chat');
    expect(((await state(app)).tabs.tabs[0] as { originSessionId?: string }).originSessionId).toBe(
      `local:${sessionA}`,
    );

    // Same PR again → deduped, still one tab.
    await typeAndSend(app, 'open a pr');
    await expect
      .poll(async () => (await localState(app)).sessions[sessionA]?.lastStopReason)
      .toBe('end_turn');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await state(app)).tabs.tabs.length).toBe(1);
    expect((await autoOpenEvents(app, logFile)).length).toBe(1);

    // Terminal path: the pty echoes the input — a PR URL in output → second tab.
    await page.waitForSelector('#view-terminal:not([disabled])', { timeout: 10_000 });
    await page.click('#view-terminal');
    await expect
      .poll(async () =>
        (await state(app)).terminals.find(
          (t) => t.kind === 'devin' && t.sessionId === sessionA,
        )?.id,
      )
      .toBeTruthy();
    const ptyA = (await state(app)).terminals.find(
      (t) => t.kind === 'devin' && t.sessionId === sessionA,
    )!.id;
    await app.evaluate(
      (_e, args) => (globalThis as G).__agentworkspace.terminalInput(args.id, args.data),
      { id: ptyA, data: `${termPrUrl}\r` },
    );
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(2);
    const termEvents = (await autoOpenEvents(app, logFile)).filter(
      (e) => (e.detail as { source?: string }).source === 'local-terminal',
    );
    expect(termEvents.map((e) => e.url)).toContain(termPrUrl);

    // Settings off → nothing auto-opens.
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ prs: { autoOpenTabs: false } })`,
    );
    const mark = (await readEvents(logFile)).length;
    const offPrUrl = `${fixtures.githubUrl}/acme/widgets/pull/9`;
    await app.evaluate(
      (_e, args) => (globalThis as G).__agentworkspace.terminalInput(args.id, args.data),
      { id: ptyA, data: `${offPrUrl}\r` },
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await state(app)).tabs.tabs.length).toBe(2);
    expect(
      (await readEvents(logFile))
        .slice(mark)
        .filter((e) => e.event === 'pr-auto-open').length,
    ).toBe(0);

    // Restore the setting for the next part.
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ prs: { autoOpenTabs: true } })`,
    );

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

test('xterm web links: clicking a PR url in the dock terminal routes like a chat link', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-lxlink-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const prUrl = `${fixtures.githubUrl}/acme/widgets/pull/11`;
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: 'node out/fixtures/fakePty.cjs',
  });
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
      .toBe(true);
    const page = await shellPage(app);

    // Dock shell terminal on the cloud surface.
    await page.waitForSelector('#terminalToggle', { timeout: 10_000 });
    await page.click('#terminalToggle');
    await expect(page.locator('#terminalDock')).toBeVisible({ timeout: 10_000 });
    await page.click('#terminalNew');
    await expect
      .poll(async () => (await state(app)).terminals.find((t) => t.kind === 'shell')?.id)
      .toBeTruthy();
    const dock = (await state(app)).terminals.find((t) => t.kind === 'shell')!.id;
    await page.waitForSelector(`[data-terminal-id="${dock}"] .xterm`, { timeout: 10_000 });

    // Echo a PR URL into the dock so xterm renders it as a link row.
    await app.evaluate(
      (_e, args) => (globalThis as G).__agentworkspace.terminalInput(args.id, args.data),
      { id: dock, data: `${prUrl}\r` },
    );
    const mark = (await readEvents(logFile)).length;
    const linkSpan = page.locator(`[data-terminal-id="${dock}"] .xterm-rows span`, {
      hasText: 'pull/11',
    });
    await expect(linkSpan.first()).toBeVisible({ timeout: 10_000 });
    const box = await linkSpan.first().boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect
      .poll(async () =>
        (await readEvents(logFile))
          .slice(mark)
          .filter((e) => e.event === 'link-open' && e.url === prUrl).length,
      )
      .toBe(1);
    await expect
      .poll(async () => (await state(app)).tabs.tabs.some((t) => t.url === prUrl))
      .toBe(true);

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
