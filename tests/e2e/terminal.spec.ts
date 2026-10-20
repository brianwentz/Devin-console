import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  closeApp,
  evaluateInShell,
  launchApp,
  launchWithClaudeFixture,
  readEvents,
  shellPage,
  state,
  waitForEvent,
} from './helpers';

type Hooks = {
  terminalOpen(
    options: { kind: 'devin'; workspace: string; sessionId: string } | { kind: 'shell'; cwd?: string },
  ): { ok: true; id: string } | { ok: false; error: string };
  terminalInput(id: string, data: string): boolean;
  terminalResize(id: string, cols: number, rows: number): boolean;
  terminalClose(id: string): boolean;
  terminalRead(id: string): string;
  terminalPid(id: string): number | null;
  terminalList(): Array<{ id: string; kind: string; cwd: string; sessionId: string | null; title: string; exitCode: number | null }>;
  localAddWorkspace(path: string): string | null;
  localNewSession(workspace: string): Promise<string>;
  localState(): { agents: Record<string, { status: string }> };
  setSurface(value: 'cloud' | 'local' | 'claude' | 'settings' | 'analytics'): void;
  claudeState(): { status: string };
  claudeSelect(id: string | null): void;
  setTerminalOpen(value: boolean): void;
  setTerminalHeight(value: number): void;
  getDevinBounds(): { y: number; height: number } | null;
  getShellWebContents(): Electron.WebContents;
  childViews(): Array<{ bounds: { x: number; y: number; width: number; height: number }; url: string | null }>;
  layoutRects(): { terminal: { x: number; y: number; width: number; height: number } | null };
  setPaneOpen(value: boolean): void;
  clipboardWrite(text: string): void;
  clipboardRead(): string;
};

type G = typeof globalThis & { __agentworkspace: Hooks };

const TERMINAL_CMD = 'node out/fixtures/fakePty.cjs';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
  expect(existsSync(join('out', 'fixtures', 'fakePty.cjs'))).toBe(true);
});

test.afterAll(async () => {
  await fixtures.close();
});

// process.kill(pid, 0) lies on Windows when the pid was recycled — check the
// image name too (pty children here are node.exe).
function pidAlive(pid: number): boolean {
  try {
    const out = spawnSync('tasklist', ['/fi', `pid eq ${pid}`, '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
    }).stdout;
    const match = /^"([^"]+)"/.exec(out.trim());
    return match ? match[1]!.toLowerCase() === 'node.exe' : false;
  } catch {
    return false;
  }
}

test('terminal: opens a pty, echoes input, resizes, closes, and leaves no orphans on quit', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-term-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: 'node out/fixtures/fakeAcpAgent.cjs',
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
      .toBe(true);

    // A path outside the configured workspaces must be rejected.
    const denied = await app.evaluate(
      (_e, path) => (globalThis as G).__agentworkspace.terminalOpen({ kind: 'devin', workspace: path as string, sessionId: 'deny-session' }),
      tmpdir(),
    );
    expect(denied.ok).toBe(false);
    const added = await app.evaluate(
      (_e, path) => (globalThis as G).__agentworkspace.localAddWorkspace(path),
      workspace,
    );
    expect(added).toBeTruthy();
    const opened = await app.evaluate(
      (_e, ws) => (globalThis as G).__agentworkspace.terminalOpen({ kind: 'devin', workspace: ws as string, sessionId: 'sess-term' }),
      added,
    );
    expect(opened.ok).toBe(true);
    const id = opened.ok ? opened.id : '';
    expect(id).toBeTruthy();

    // Fake pty announces readiness.
    await expect
      .poll(async () =>
        app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), id),
      )
      .toContain('ready');

    // Input echoes back through the pty.
    await app.evaluate(
      (_e, args) => (globalThis as G).__agentworkspace.terminalInput(args.id, args.data),
      { id, data: 'ping\r' },
    );
    await expect
      .poll(async () =>
        app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), id),
      )
      .toContain('echo:ping');

    expect(
      await app.evaluate(
        (_e, args) => (globalThis as G).__agentworkspace.terminalResize(args.id, args.c, args.r),
        { id, c: 80, r: 24 },
      ),
    ).toBe(true);

    const pid = await app.evaluate(
      (_e, tid) => (globalThis as G).__agentworkspace.terminalPid(tid as string),
      id,
    );
    expect(pid).toBeTruthy();

    // Shell DOM: Terminal tab shows an xterm surface (per-session pty — the
    // hook-opened one belongs to 'sess-term', the session gets its own).
    await expect
      .poll(async () => (await app.evaluate(() => (globalThis as G).__agentworkspace.localState())).agents[added!]?.status)
      .toBe('ready');
    const uiSessionId = await app.evaluate(
      (_e, w) => (globalThis as G).__agentworkspace.localNewSession(w as string),
      added,
    );
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('local'));
    const page = await shellPage(app);
    await page.waitForSelector(`.session-item[data-session-id="${uiSessionId}"]`, { timeout: 10000 });
    await page.click(`.session-item[data-session-id="${uiSessionId}"]`);
    await page.waitForSelector('#view-terminal:not([disabled])', { timeout: 10000 });
    await page.click('#view-terminal');
    await page.waitForSelector('.xterm', { timeout: 10000 });

    // Close kills the child process.
    await app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalClose(tid as string), id);
    await expect.poll(async () => pidAlive(pid!)).toBe(false);

    // A second terminal left open is disposed on quit — no orphan conhost/node.
    const opened2 = await app.evaluate(
      (_e, ws) => (globalThis as G).__agentworkspace.terminalOpen({ kind: 'devin', workspace: ws as string, sessionId: 'sess-term' }),
      added,
    );
    expect(opened2.ok).toBe(true);
    const pid2 = opened2.ok
      ? await app.evaluate(
          (_e, tid) => (globalThis as G).__agentworkspace.terminalPid(tid as string),
          opened2.id,
        )
      : null;
    expect(pid2).toBeTruthy();

    // app.evaluate(quit) can hang forever (the app exits before the IPC reply
    // is delivered) — fire it un-awaited and wait on the child 'exit' event.
    const exitStatus = new Promise<'exited' | 'timeout'>((resolve) => {
      app.process().once('exit', () => resolve('exited'));
      setTimeout(() => resolve('timeout'), 30_000);
    });
    void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    expect(await exitStatus).toBe('exited');
    closed = true;
    await expect.poll(async () => pidAlive(pid2!)).toBe(false);
    await Promise.race([
      app.close().then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  } finally {
    if (!closed) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([
        app.close().then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
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

test('terminal dock: rail toggle, shell tabs, surface gating, persisted height', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-dock-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
  });
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
      .toBe(true);
    const page = await shellPage(app);
    await page.waitForSelector('#terminalToggle', { timeout: 10_000 });

    // Closed by default; devin view fills the height.
    const before = await app.evaluate(() => (globalThis as G).__agentworkspace.getDevinBounds());
    expect(before?.height).toBeGreaterThan(600);
    await expect(page.locator('#terminalDock')).toBeHidden();

    // Rail toggle opens the dock; devin height shrinks by height + splitter.
    await page.click('#terminalToggle');
    await expect.poll(async () => (await state(app)).terminalOpen).toBe(true);
    await expect(page.locator('#terminalDock')).toBeVisible();
    const after = await app.evaluate(() => (globalThis as G).__agentworkspace.getDevinBounds());
    expect(after?.height).toBe(before!.height - 280 - 6);

    // Live resize: the dock height follows the pointer mid-drag; Escape
    // restores it.
    const splitterBox = await page.locator('#terminalSplitter').boundingBox();
    expect(splitterBox).toBeTruthy();
    // The painted line is a 1 px hairline while idle.
    expect((await page.locator('#terminalSplitter .splitter-line').boundingBox())?.height).toBe(1);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(splitterBox!.x + splitterBox!.width).toBeLessThan(clientWidth);
    const splitCx = splitterBox!.x + splitterBox!.width / 2;
    const splitCy = splitterBox!.y + splitterBox!.height / 2;
    await page.mouse.move(splitCx, splitCy);
    await page.mouse.down();
    await page.mouse.move(splitCx, splitCy - 40, { steps: 3 });
    await expect.poll(async () => (await state(app)).terminalHeight).toBeGreaterThan(280);
    await page.keyboard.press('Escape');
    await page.mouse.up().catch(() => undefined);
    expect((await state(app)).terminalHeight).toBe(280);

    // Native layering: no WebContentsView may cover the dock rect — a stray
    // native view over the strip swallows real clicks before they reach the
    // shell DOM (CDP input bypasses native hit-testing, so DOM assertions miss it).
    const [rects, views] = await app.evaluate(() => [
      (globalThis as G).__agentworkspace.layoutRects(),
      (globalThis as G).__agentworkspace.childViews(),
    ]);
    const term = rects.terminal!;
    expect(term).toBeTruthy();
    const overlaps = (b: { x: number; y: number; width: number; height: number }) =>
      b.x < term.x + term.width && b.x + b.width > term.x && b.y < term.y + term.height && b.y + b.height > term.y;
    for (const view of views) {
      const isShell = view.url?.startsWith('app://shell');
      if (!isShell) expect(overlaps(view.bounds), `view over dock: ${view.url}`).toBe(false);
    }

    // + opens a shell immediately in the default cwd (workspaces empty → homedir).
    await page.click('#terminalNew');
    await expect.poll(async () => (await state(app)).terminals.length).toBe(1);
    await waitForEvent(logFile, 'terminal-open');
    const openEvents = (await readEvents(logFile)).filter(
      (e) => e.event === 'terminal-open' && (e.detail as { kind?: string }).kind === 'shell',
    );
    expect(openEvents.length).toBe(1);
    const firstId = (await state(app)).terminals[0]!.id;

    // Focus lands in the new terminal (xterm helper textarea), not the button —
    // typed input goes to the pty and Space/Enter cannot re-trigger +.
    await expect
      .poll(async () =>
        page.evaluate(
          (id) =>
            document.activeElement?.closest(`[data-terminal-id="${id}"]`) !== null &&
            document.activeElement?.classList.contains('xterm-helper-textarea'),
          firstId,
        ),
      )
      .toBe(true);
    await page.keyboard.type('ping\r');
    await expect
      .poll(async () =>
        app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), firstId),
      )
      .toContain('ping');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    expect((await state(app)).terminals.length).toBe(1);
    // Tab label is the cwd basename (short), not the raw OSC title.
    const firstCwd = (await state(app)).terminals[0]!.cwd;
    await expect(page.locator(`[data-terminal-tab="${firstId}"] .tabTitle`)).toHaveText(
      firstCwd.split(/[\\/]/).filter(Boolean).at(-1)!,
    );

    // The chevron opens the cwd menu — it must be a real, unclipped overlay:
    // rect inside the dock and the first item hit-tests to itself.
    const profiles = (await evaluateInShell(app, `window.agentworkspace.terminalProfiles()`)) as unknown[];
    expect(Array.isArray(profiles)).toBe(true);
    await page.click('#terminalNewCwd');
    await page.waitForSelector('#terminalNewMenu button');
    await expect(page.locator('#terminalNewMenu >> text=Open in…')).toHaveCount(1);
    const options = await page.locator('#terminalNewMenu button').allTextContents();
    expect(options.length).toBeGreaterThan(0);
    const menuBox = await page.locator('#terminalNewMenu').boundingBox();
    const dockBox = await page.locator('#terminalDock').boundingBox();
    expect(menuBox).toBeTruthy();
    expect(dockBox).toBeTruthy();
    expect(menuBox!.y).toBeGreaterThanOrEqual(dockBox!.y);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(dockBox!.y + dockBox!.height + 1);
    const firstItem = page.locator('#terminalNewMenu button').first();
    const hitId = await firstItem.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === el || el.contains(hit) ? (el.closest('#terminalNewMenu')?.id ?? 'menu') : (hit?.id ?? hit?.tagName ?? 'none');
    });
    expect(hitId).toBe('terminalNewMenu');
    await firstItem.click();
    await expect.poll(async () => (await state(app)).terminals.length).toBe(2);
    const tabs = (await state(app)).terminals;
    expect(tabs.every((t) => t.kind === 'shell')).toBe(true);
    await expect(page.locator('#terminalDock .terminal-tab')).toHaveCount(2);

    // Input round-trips through the active pty.
    const activeId = (await state(app)).activeTerminalId;
    expect(activeId).toBe(tabs[1]!.id);
    await expect
      .poll(async () =>
        app.evaluate(
          (_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string),
          activeId,
        ),
      )
      .toContain('ready');
    await app.evaluate(
      (_e, tid) => (globalThis as G).__agentworkspace.terminalInput(tid as string, 'hi\r'),
      activeId,
    );
    await expect
      .poll(async () =>
        app.evaluate(
          (_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string),
          activeId,
        ),
      )
      .toContain('echo:hi');

    // Clicking a tab switches; × closes it and kills the pty.
    await page.click(`[data-terminal-tab="${tabs[0]!.id}"]`);
    await expect.poll(async () => (await state(app)).activeTerminalId).toBe(tabs[0]!.id);
    const pid = await app.evaluate(
      (_e, tid) => (globalThis as G).__agentworkspace.terminalPid(tid as string),
      tabs[0]!.id,
    );
    expect(pid).toBeTruthy();
    await page.click(`[data-terminal-tab="${tabs[0]!.id}"] .closeMark`);
    await expect.poll(async () => (await state(app)).terminals.length).toBe(1);
    await expect.poll(async () => pidAlive(pid!)).toBe(false);

    // Resize + persist across restart.
    await app.evaluate(() => (globalThis as G).__agentworkspace.setTerminalHeight(400));
    await expect.poll(async () => (await state(app)).terminalHeight).toBe(400);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('cloud'));
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();

    const app2 = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
      AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
    });
    try {
      await expect
        .poll(async () => app2.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
        .toBe(true);
      const s = await state(app2);
      expect(s.terminalOpen).toBe(true);
      expect(s.terminalHeight).toBe(400);
    } finally {
      await app2.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
      await app2.close().catch(() => undefined);
    }
    closed = true;
  } finally {
    if (!closed) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([
        app.close().then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
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

test('terminal clipboard: Ctrl+V pastes, Ctrl+C copies selection, right-click copy/paste', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-termclip-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
  });
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
      .toBe(true);
    const page = await shellPage(app);
    await page.waitForSelector('#terminalToggle', { timeout: 10_000 });
    await page.click('#terminalToggle');
    await page.waitForSelector('#terminalNew', { timeout: 10_000 });
    await page.click('#terminalNew');
    let id = '';
    await expect
      .poll(async () => {
        id = (await state(app)).terminals[0]?.id ?? '';
        return id;
      })
      .not.toBe('');
    await page.waitForSelector(`[data-terminal-id="${id}"] .xterm`, { timeout: 10_000 });
    await expect
      .poll(async () =>
        app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), id),
      )
      .toContain('ready');
    const read = () =>
      app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), id);
    await page.locator(`[data-terminal-id="${id}"]`).click();

    // Plain Ctrl+V pastes via term.paste. The fake pty enabled bracketed
    // paste, but on Windows ConPTY strips the \x1b[?2004h mode set and the
    // 200~/201~ input markers, so the pty observes the raw text. Measured
    // because the pre-fix path let PSReadLine handle the paste (~500ms).
    // The child's stdin is line-buffered, so the trailing \r flushes it.
    await app.evaluate((_e, text) => (globalThis as G).__agentworkspace.clipboardWrite(text as string), 'clip-text');
    const t0 = Date.now();
    await page.keyboard.press('Control+v');
    await expect.poll(read).toContain('clip-text');
    const elapsed = Date.now() - t0;
    // The ~500ms pre-fix path (PSReadLine paste) is comfortably above this.
    expect(elapsed).toBeLessThan(400);
    expect((await read()).split('clip-text').length - 1).toBe(1); // no double paste
    await page.keyboard.press('Enter');
    await expect.poll(read).toContain('echo:clip-text\\x0d');
    expect(await read()).not.toContain('\\x16'); // ^V never reached the pty

    // Right-click with no xterm selection pastes (Windows Terminal convention).
    await app.evaluate((_e, text) => (globalThis as G).__agentworkspace.clipboardWrite(text as string), 'right-click-paste');
    await page.locator(`[data-terminal-id="${id}"]`).click({ button: 'right' });
    await expect.poll(read).toContain('right-click-paste');
    await page.keyboard.press('Enter'); // flush the pasted line to the child

    // Drag across the first screen row ('ready') to make an xterm selection.
    const screen = page.locator(`[data-terminal-id="${id}"] .xterm-screen`);
    const box = await screen.boundingBox();
    expect(box).toBeTruthy();
    const selectRow = async () => {
      await page.mouse.move(box!.x + 2, box!.y + 6);
      await page.mouse.down();
      await page.mouse.move(box!.x + 60, box!.y + 6, { steps: 5 });
      await page.mouse.up();
    };
    await selectRow();

    // Right-click with a selection copies it to the OS clipboard.
    await app.evaluate((_e, text) => (globalThis as G).__agentworkspace.clipboardWrite(text as string), '__cleared__');
    await page.locator(`[data-terminal-id="${id}"]`).click({ button: 'right' });
    await expect
      .poll(async () => app.evaluate(() => (globalThis as G).__agentworkspace.clipboardRead()))
      .toContain('ready');

    // Ctrl+C with an xterm selection copies it instead of sending ^C.
    await selectRow();
    await app.evaluate((_e, text) => (globalThis as G).__agentworkspace.clipboardWrite(text as string), '');
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => app.evaluate(() => (globalThis as G).__agentworkspace.clipboardRead()))
      .toContain('ready');
    await page.keyboard.type('z');
    await page.keyboard.press('Enter');
    await expect.poll(read).toContain('echo:z\\x0d'); // no ^C in the flushed line
    expect(await read()).not.toContain('echo:\\x03');

    // Ctrl+C with no selection sends ^C to the pty — under ConPTY that is a
    // CTRL_C_EVENT which kills the child, not a readable \x03 byte.
    await page.locator(`[data-terminal-id="${id}"]`).click(); // click clears the selection
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => (await state(app)).terminals[0]?.exitCode)
      .toEqual(expect.any(Number));

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    closed = true;
  } finally {
    if (!closed) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([
        app.close().then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
});

test('terminal: quit disposes several live devin ptys and the process exits', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-termquit-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
  });
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
      .toBe(true);
    const added = await app.evaluate(
      (_e, path) => (globalThis as G).__agentworkspace.localAddWorkspace(path),
      workspace,
    );
    expect(added).toBeTruthy();
    // Three live per-session devin ptys at quit.
    for (let i = 0; i < 3; i += 1) {
      const opened = await app.evaluate(
        (_e, args) =>
          (globalThis as G).__agentworkspace.terminalOpen({
            kind: 'devin',
            workspace: args.ws as string,
            sessionId: args.sid as string,
          }),
        { ws: added, sid: `quit-sess-${i}` },
      );
      expect(opened.ok).toBe(true);
    }
    expect(
      (await app.evaluate(() => (globalThis as G).__agentworkspace.terminalList())).length,
    ).toBe(3);

    // quit + wait on the process 'exit' — the evaluate reply can be lost when
    // the app exits first, so it is fired un-awaited.
    const exitStatus = new Promise<'exited' | 'timeout'>((resolve) => {
      app.process().once('exit', () => resolve('exited'));
      setTimeout(() => resolve('timeout'), 30_000);
    });
    void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    expect(await exitStatus).toBe('exited');
    await waitForEvent(logFile, 'window-close-complete');
    closed = true;
    await Promise.race([
      app.close().then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  } finally {
    if (!closed) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([
        app.close().then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
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

test('terminal: devin pty resumes with -r, reuses the live pty per session', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-term-resume-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
  });
  let closed = false;
  const read = (id: string) =>
    app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), id);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const ws = await app.evaluate(
      (_e, path) => (globalThis as G).__agentworkspace.localAddWorkspace(path as string),
      workspace,
    );
    expect(ws).toBeTruthy();

    const a1 = await app.evaluate(
      (_e, o) =>
        (globalThis as G).__agentworkspace.terminalOpen({
          kind: 'devin',
          workspace: (o as { ws: string }).ws,
          sessionId: (o as { ws: string; sid: string }).sid,
        }),
      { ws: ws as string, sid: 'sess-a' },
    );
    expect(a1.ok).toBe(true);
    const idA = a1.ok ? a1.id : '';
    await expect.poll(async () => read(idA)).toContain('args:-r sess-a');

    // Same session reuses the live pty.
    const a2 = await app.evaluate(
      (_e, o) =>
        (globalThis as G).__agentworkspace.terminalOpen({
          kind: 'devin',
          workspace: (o as { ws: string }).ws,
          sessionId: (o as { ws: string; sid: string }).sid,
        }),
      { ws: ws as string, sid: 'sess-a' },
    );
    expect(a2.ok && a2.id).toBe(idA);

    const b = await app.evaluate(
      (_e, o) =>
        (globalThis as G).__agentworkspace.terminalOpen({
          kind: 'devin',
          workspace: (o as { ws: string }).ws,
          sessionId: (o as { ws: string; sid: string }).sid,
        }),
      { ws: ws as string, sid: 'sess-b' },
    );
    expect(b.ok).toBe(true);
    const idB = b.ok ? b.id : '';
    expect(idB).not.toBe(idA);
    await expect.poll(async () => read(idB)).toContain('args:-r sess-b');

    const list = await app.evaluate(() => (globalThis as G).__agentworkspace.terminalList());
    expect(
      list
        .filter((t) => t.kind === 'devin' && t.cwd === ws)
        .map((t) => t.sessionId)
        .sort(),
    ).toEqual(['sess-a', 'sess-b'].sort() as unknown[]);
    const resumeEvents = (await readEvents(logFile)).filter(
      (e) => e.event === 'terminal-open' && (e.detail as { resume?: boolean }).resume === true,
    );
    expect(resumeEvents).toHaveLength(2);

    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    closed = true;
  } finally {
    if (!closed) {
      spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([
        app.close().then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
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

// ux2 P2: the dock is a work-surface feature — core/layout dockSurface() gates
// main (native bounds), App (shell DOM), Rail (button) and Ctrl+` identically.
// `layout.terminalOpen` survives a visit to Settings/Analytics untouched.
test.describe('dock surfaces', () => {
  const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
  const CLAUDE_UA = '11111111-0000-4000-8000-00000000000a';
  type TRect = { x: number; y: number; width: number; height: number };

  const terminalRect = (app: ElectronApplication): Promise<TRect | null> =>
    app.evaluate(() => (globalThis as G).__agentworkspace.layoutRects().terminal);
  const setSurface = (app: ElectronApplication, surface: Parameters<Hooks['setSurface']>[0]) =>
    app.evaluate((_e, v) => (globalThis as G).__agentworkspace.setSurface(v), surface);
  const read = (app: ElectronApplication, id: string) =>
    app.evaluate((_e, tid) => (globalThis as G).__agentworkspace.terminalRead(tid as string), id);
  const toggleEvents = async (logFile: string) =>
    (await readEvents(logFile)).filter((e) => e.event === 'terminal-toggle');
  // CDP-dispatched keys (page.keyboard) bypass Electron's before-input-event;
  // sendInputEvent takes the native path the shortcut handler listens on.
  const ctrlBacktick = (app: ElectronApplication) =>
    app.evaluate(() => {
      const contents = (globalThis as G).__agentworkspace.getShellWebContents();
      contents.sendInputEvent({ type: 'keyDown', keyCode: '`', modifiers: ['control'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: '`', modifiers: ['control'] });
    });

  test('visible on cloud/local/claude, hidden + inert on settings/analytics, preference survives the visit', async () => {
    const { app, profile } = await launchWithClaudeFixture(fixtures, {
      AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
      AGENT_WORKSPACE_TEST_TERMINAL_CMD: TERMINAL_CMD,
      AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    });
    const logFile = join(profile, 'events.jsonl');
    try {
      await expect
        .poll(async () => app.evaluate(() => Boolean((globalThis as G).__agentworkspace)))
        .toBe(true);
      const page = await shellPage(app);
      const dock = page.locator('#terminalDock');
      const toggle = page.locator('#terminalToggle');
      await toggle.waitFor({ timeout: 10_000 });
      expect((await state(app)).surface).toBe('cloud');
      await expect(dock).toBeHidden();
      expect(await terminalRect(app)).toBeNull();

      // Cloud: Ctrl+` (main-process before-input-event on the shell) opens the dock.
      await ctrlBacktick(app);
      await expect.poll(async () => (await state(app)).terminalOpen).toBe(true);
      await expect(dock).toBeVisible();
      await expect.poll(async () => (await toggleEvents(logFile)).length).toBe(1);
      expect((await toggleEvents(logFile))[0]!.detail).toMatchObject({ open: true, source: 'shortcut' });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      const cloudRect = await terminalRect(app);
      expect(cloudRect).not.toBeNull();
      const cloudBox = await dock.boundingBox();
      expect(cloudBox!.y).toBe(cloudRect!.y);
      expect(cloudBox!.height).toBe(cloudRect!.height);

      // A shell in the dock, so there is an xterm to focus later on.
      await page.click('#terminalNew');
      await expect
        .poll(async () => (await state(app)).terminals.filter((t) => t.kind === 'shell').length)
        .toBe(1);
      const dockId = (await state(app)).terminals.find((t) => t.kind === 'shell')!.id;
      await expect.poll(() => read(app, dockId)).toContain('ready');

      // Local: still a dock surface.
      await setSurface(app, 'local');
      await expect.poll(async () => (await state(app)).surface).toBe('local');
      await expect(dock).toBeVisible();
      expect(await terminalRect(app)).not.toBeNull();
      await expect(toggle).toBeEnabled();

      // Settings: dock hidden, rail toggle disabled, Ctrl+` is a no-op; the
      // persisted preference is untouched (aria-pressed still reflects it).
      await setSurface(app, 'settings');
      await expect.poll(async () => (await state(app)).surface).toBe('settings');
      await expect(dock).toBeHidden();
      expect(await terminalRect(app)).toBeNull();
      await expect(toggle).toBeDisabled();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await ctrlBacktick(app);
      await page.waitForTimeout(400);
      expect((await state(app)).terminalOpen).toBe(true);
      expect((await toggleEvents(logFile)).length).toBe(1);
      await expect(dock).toBeHidden();

      // Analytics: same gating.
      await setSurface(app, 'analytics');
      await expect.poll(async () => (await state(app)).surface).toBe('analytics');
      await expect(dock).toBeHidden();
      expect(await terminalRect(app)).toBeNull();
      await expect(toggle).toBeDisabled();
      await ctrlBacktick(app);
      await page.waitForTimeout(400);
      expect((await state(app)).terminalOpen).toBe(true);
      expect((await toggleEvents(logFile)).length).toBe(1);

      // Back to Cloud: the dock re-appears at the same geometry, no re-toggle,
      // and the shell it hosted is still live.
      await setSurface(app, 'cloud');
      await expect.poll(async () => (await state(app)).surface).toBe('cloud');
      await expect(dock).toBeVisible();
      expect(await terminalRect(app)).toEqual(cloudRect);
      await expect(toggle).toBeEnabled();
      expect((await state(app)).terminals.find((t) => t.id === dockId)?.exitCode).toBeNull();

      // Claude: the dock and the per-session Terminal tab coexist.
      await expect
        .poll(async () => (await app.evaluate(() => (globalThis as G).__agentworkspace.claudeState())).status)
        .toBe('ready');
      await setSurface(app, 'claude');
      await expect.poll(async () => (await state(app)).surface).toBe('claude');
      await expect(dock).toBeVisible();
      await expect(toggle).toBeEnabled();
      await app.evaluate((_e, id) => (globalThis as G).__agentworkspace.claudeSelect(id as string), CLAUDE_UA);
      await page.locator('#view-terminal').click();
      const claudePane = page.locator(`[data-session-terminal="${CLAUDE_UA}"]`);
      await expect(claudePane).toBeAttached({ timeout: 10_000 });
      await expect(claudePane.locator('.xterm')).toBeVisible({ timeout: 10_000 });
      let claudePtyId = '';
      await expect
        .poll(async () => {
          claudePtyId = (await state(app)).terminals.find((t) => t.sessionId === CLAUDE_UA)?.id ?? '';
          return claudePtyId;
        })
        .not.toBe('');
      await expect.poll(() => read(app, claudePtyId)).toContain(`-r ${CLAUDE_UA}`);

      // Geometry: dock sits below the chat column (bounds.terminal), flush with
      // the window bottom; the Claude terminal pane ends above it.
      await expect(dock).toBeVisible();
      const claudeRect = await terminalRect(app);
      expect(claudeRect).not.toBeNull();
      expect((await dock.boundingBox())!.y).toBe(claudeRect!.y);
      const claudeBox = await claudePane.boundingBox();
      expect(claudeBox).toBeTruthy();
      expect(claudeBox!.height).toBeGreaterThan(100);
      expect(claudeBox!.y + claudeBox!.height).toBeLessThanOrEqual(claudeRect!.y + 1);
      const clientHeight = await page.evaluate(() => document.documentElement.clientHeight);
      expect(claudeRect!.y + claudeRect!.height).toBe(clientHeight);

      // Focus does not fight: re-show the dock while the Claude Terminal tab is
      // active — focus lands in the dock xterm and typed input reaches ITS pty only.
      await app.evaluate(() => (globalThis as G).__agentworkspace.setTerminalOpen(false));
      await expect(dock).toBeHidden();
      await expect(claudePane.locator('.xterm')).toBeVisible();
      await app.evaluate(() => (globalThis as G).__agentworkspace.setTerminalOpen(true));
      await expect(dock).toBeVisible();
      await expect
        .poll(async () =>
          page.evaluate(
            (id) =>
              document.activeElement?.closest(`[data-terminal-id="${id}"]`) !== null &&
              document.activeElement?.classList.contains('xterm-helper-textarea'),
            dockId,
          ),
        )
        .toBe(true);
      await page.keyboard.type('dockping\r');
      await expect.poll(() => read(app, dockId)).toContain('echo:dockping');
      expect(await read(app, claudePtyId)).not.toContain('dockping');

      // Clicking the Claude terminal moves focus there; the dock stays open.
      await claudePane.locator('.xterm-screen').click();
      await page.keyboard.type('claudeping\r');
      await expect.poll(() => read(app, claudePtyId)).toContain('claudeping');
      expect(await read(app, dockId)).not.toContain('claudeping');
      await expect(dock).toBeVisible();
      expect((await state(app)).terminalOpen).toBe(true);
    } finally {
      await closeApp(app);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  });
});
