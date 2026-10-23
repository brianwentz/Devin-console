// Linked Context user tabs: the "+" button, the on-demand address bar and its
// shortcuts (Ctrl+T / Ctrl+L), and links dropped onto the tab row.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  CLAUDE_FIXTURE_HOME,
  closeApp,
  evaluateInShell,
  launchApp,
  openTab,
  readEvents,
  shellPage,
  state,
  waitForTabCount,
} from './helpers';

type Rect = { x: number; y: number; width: number; height: number };
type G = typeof globalThis & {
  __agentworkspace: {
    addressBar(): { open: boolean; mode: 'new' | 'current' };
    layoutRects(): { ghTab: Rect | null };
    loadDevinUrl(url: string): void;
    setPaneOpen(value: boolean): void;
    setSurface(value: string): void;
    getShellWebContents(): Electron.WebContents;
    terminalRead(id: string): string;
    tabInfo(id: string): { url: string; originSessionId: string | null } | null;
    claudeSelect(id: string): void;
    openhandsOpen(id: string): boolean;
  };
};

const TITLE_BAR = 36;
const BAR = 32;

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

interface Launched {
  app: ElectronApplication;
  shell: Page;
  profile: string;
  logFile: string;
}

// Shared launch: one temp profile per test; `profile` lets a test relaunch on it.
async function launch(profile?: string, env: Record<string, string> = {}): Promise<Launched> {
  const dir = profile ?? mkdtempSync(join(tmpdir(), 'agent-workspace-usertabs-'));
  const logFile = join(dir, 'events.jsonl');
  const app = await launchApp(dir, logFile, join(dir, 'downloads'), fixtures, env);
  const shell = await shellPage(app);
  return { app, shell, profile: dir, logFile };
}

async function dispose(launched: Launched, keepProfile = false): Promise<void> {
  await closeApp(launched.app);
  if (!keepProfile) rmSync(launched.profile, { recursive: true, force: true });
}

async function openSession(app: ElectronApplication, name: string): Promise<void> {
  await app.evaluate(
    (_e, url: string) => (globalThis as G).__agentworkspace.loadDevinUrl(url),
    `${fixtures.devinUrl}/sessions/${name}`,
  );
  await expect.poll(async () => (await state(app)).tabs.scope).toBe(name);
}

function addressBar(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as G).__agentworkspace.addressBar());
}

async function ghTabY(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(() => (globalThis as G).__agentworkspace.layoutRects().ghTab?.y);
}

// Main-process shortcuts only see sendInputEvent (before-input-event), never
// Playwright's keyboard. `urlPrefix` targets a hosted view instead of the shell.
async function shortcut(app: ElectronApplication, key: string, urlPrefix?: string): Promise<void> {
  // A hosted tab's webContents may still be loading its first URL: retry until it exists.
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }, arg: { key: string; urlPrefix: string | null }) => {
          const contents = arg.urlPrefix
            ? webContents.getAllWebContents().find((c) => c.getURL().startsWith(arg.urlPrefix!))
            : (globalThis as G).__agentworkspace.getShellWebContents();
          if (!contents) return false;
          contents.sendInputEvent({ type: 'keyDown', keyCode: arg.key, modifiers: ['control'] });
          contents.sendInputEvent({ type: 'keyUp', keyCode: arg.key, modifiers: ['control'] });
          return true;
        },
        { key, urlPrefix: urlPrefix ?? null },
      ),
    )
    .toBe(true);
}

async function addressBarEvents(logFile: string): Promise<Array<Record<string, unknown>>> {
  return (await readEvents(logFile)).filter((event) => event.event === 'address-bar');
}

test('"+" opens the bar; a typed URL opens a tab in the current scope that survives restart', async () => {
  const first = await launch();
  const { app, shell, logFile } = first;
  const typed = `${fixtures.idpUrl}/page/x`;
  try {
    await openSession(app, 'A');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);
    expect(await ghTabY(app)).toBe(TITLE_BAR);

    const plus = shell.locator('#tabNew');
    await expect(plus).toBeVisible();
    await expect(plus).toHaveAttribute('title', 'New tab (Ctrl+T)');
    await plus.click();
    const bar = shell.locator('#tabAddressBar');
    const input = shell.locator('#tabAddressBarInput');
    await expect(bar).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    expect(await addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    // The DOM row sits exactly where main carved the hosted view down.
    const rects = await app.evaluate(() => (globalThis as G).__agentworkspace.layoutRects());
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y)).toBe(TITLE_BAR);
    expect(Math.round(box.height)).toBe(BAR);
    // The shell lays out from its document size, which can differ from the
    // native content bounds by a px at fractional display scales.
    expect(Math.abs(box.x - rects.ghTab!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x + box.width - (rects.ghTab!.x + rects.ghTab!.width))).toBeLessThanOrEqual(1);

    // Rejected input keeps the bar open with the reason inline; no tab.
    await input.fill('javascript:alert(1)');
    await input.press('Enter');
    await expect(shell.locator('#tabAddressBarError')).toHaveText(
      'Only http and https addresses can open here',
    );
    await expect(bar).toBeVisible();
    await input.fill('   ');
    await input.press('Enter');
    await expect(shell.locator('#tabAddressBarError')).toHaveText('Type a web address');
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // Esc closes without a tab.
    await input.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // Blur closes without a tab.
    await plus.click();
    await expect(input).toBeFocused();
    await input.fill(typed);
    await input.evaluate((el) => (el as HTMLInputElement).blur());
    await expect(bar).toHaveCount(0);
    await expect.poll(async () => (await addressBarEvents(logFile)).at(-1)?.detail).toMatchObject({
      open: false,
      source: 'blur',
    });
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    await plus.click();
    await expect(input).toBeFocused();
    await input.fill(typed);
    await input.press('Enter');
    await waitForTabCount(app, 1);
    await expect.poll(async () => (await state(app)).tabs.tabs[0]?.url).toBe(typed);
    expect((await state(app)).tabs.scope).toBe('A');
    await expect(bar).toHaveCount(0);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);

    const events = await addressBarEvents(logFile);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.detail).toMatchObject({ open: true, mode: 'new', source: 'button' });
    // The new tab view takes focus, but the close is still the Enter's.
    expect(events.at(-1)!.detail).toMatchObject({ open: false, source: 'enter' });
    for (const event of events) expect(JSON.stringify(event)).not.toContain('/page/x');
  } finally {
    await dispose(first, true);
  }

  const second = await launch(first.profile);
  try {
    await openSession(second.app, 'A');
    await expect
      .poll(async () => (await state(second.app)).tabs.tabs.map((tab) => tab.url))
      .toEqual([typed]);
    expect(await addressBar(second.app)).toEqual({ open: false, mode: 'new' });
  } finally {
    await dispose(second);
  }
});

test('Ctrl+T and Ctrl+L open the bar; Ctrl+L navigates the active tab in place', async () => {
  const launched = await launch();
  const { app, shell } = launched;
  const input = shell.locator('#tabAddressBarInput');
  try {
    await openSession(app, 'A');
    // Ctrl+L with no tabs falls back to a new tab.
    await shortcut(app, 'L');
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await input.press('Escape');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);

    // Ctrl+T with the pane closed opens the pane, then the bar.
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(false));
    await expect.poll(async () => (await state(app)).paneOpen).toBe(false);
    await shortcut(app, 'T');
    await expect.poll(async () => (await state(app)).paneOpen).toBe(true);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect(input).toBeFocused();
    await input.press('Escape');

    const first = `${fixtures.githubUrl}/page/ctrl-l-start`;
    const id = await openTab(app, first);
    await expect.poll(async () => (await state(app)).tabs.tabs[0]?.url).toBe(first);

    // Ctrl+L from the hosted tab itself prefills its URL in mode current.
    await shortcut(app, 'L', first);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'current' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(first);
    const next = `${fixtures.idpUrl}/page/ctrl-l-next`;
    await input.fill(next);
    await input.press('Enter');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);
    await expect.poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.url)).toEqual([next]);
    expect((await state(app)).tabs.tabs.map((tab) => tab.id)).toEqual([id]);

    // Ctrl+T from a hosted tab opens a new-tab bar.
    await shortcut(app, 'T', next);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'new' });
    await expect(input).toHaveValue('');
  } finally {
    await dispose(launched);
  }
});

test('a Devin tenant URL goes to the Cloud surface; pane toggle, surface switch and scope change close the bar', async () => {
  const launched = await launch();
  const { app, shell } = launched;
  const bar = shell.locator('#tabAddressBar');
  const input = shell.locator('#tabAddressBarInput');
  try {
    await openSession(app, 'A');
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await shell.locator('#tabNew').click();
    await expect(input).toBeFocused();
    const tenant = `${fixtures.devinUrl}/sessions/typed-target`;
    await input.fill(tenant);
    await input.press('Enter');
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('typed-target');
    await expect(bar).toHaveCount(0);
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // Pane hidden while open.
    await shell.locator('#tabNew').click();
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(false));
    await expect.poll(async () => (await addressBar(app)).open).toBe(false);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(true));
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    await expect(bar).toHaveCount(0);

    // Surface switch while open.
    await shell.locator('#tabNew').click();
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => (await addressBar(app)).open).toBe(false);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    await expect(bar).toHaveCount(0);

    // Tab-scope change while open (another Cloud session becomes visible).
    await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('cloud'));
    await shell.locator('#tabNew').click();
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR + BAR);
    await openSession(app, 'B');
    await expect.poll(async () => (await addressBar(app)).open).toBe(false);
    await expect.poll(() => ghTabY(app)).toBe(TITLE_BAR);
    await expect(bar).toHaveCount(0);
  } finally {
    await dispose(launched);
  }
});

test('an OpenHands URL typed in the bar goes to the OpenHands surface without a pane tab', async () => {
  const launched = await launch();
  const { app, shell } = launched;
  const input = shell.locator('#tabAddressBarInput');
  try {
    await openSession(app, 'A');
    await shell.locator('#tabNew').click();
    await expect(input).toBeFocused();
    await input.fill(`${fixtures.openhands.url}/conversations/0123456789abcdef0123456789abcd0e`);
    await input.press('Enter');
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);
    expect((await state(app)).tabs.tabs).toHaveLength(0);
  } finally {
    await dispose(launched);
  }
});

test('Ctrl+L to a URL already open in another tab focuses that tab instead of duplicating it', async () => {
  const launched = await launch();
  const { app, shell } = launched;
  const input = shell.locator('#tabAddressBarInput');
  try {
    await openSession(app, 'A');
    const first = `${fixtures.githubUrl}/page/dedupe-a`;
    const second = `${fixtures.githubUrl}/page/dedupe-b`;
    const firstId = await openTab(app, first);
    await openTab(app, second);
    await waitForTabCount(app, 2);
    await expect.poll(async () => (await visibleTabs(app)).activeId).not.toBe(firstId);

    await shortcut(app, 'L', second);
    await expect.poll(() => addressBar(app)).toEqual({ open: true, mode: 'current' });
    await input.fill(first);
    await input.press('Enter');
    await expect.poll(async () => (await visibleTabs(app)).activeId).toBe(firstId);
    expect((await state(app)).tabs.tabs.map((tab) => tab.url).sort()).toEqual([first, second]);
  } finally {
    await dispose(launched);
  }
});

test('Ctrl+L / Ctrl+T inside the terminal dock reach the pty and never open the bar or the pane', async () => {
  const launched = await launch(undefined, {
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: 'node out/fixtures/fakePty.cjs',
  });
  const { app, shell } = launched;
  try {
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(false));
    await expect.poll(async () => (await state(app)).paneOpen).toBe(false);
    const width = await app.evaluate(
      ({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentBounds().width,
    );
    await shell.click('#terminalToggle');
    await shell.click('#terminalNew');
    let id = '';
    await expect
      .poll(async () => {
        id = (await state(app)).terminals[0]?.id ?? '';
        return id;
      })
      .not.toBe('');
    await shell.waitForSelector(`[data-terminal-id="${id}"] .xterm`);
    const read = () =>
      app.evaluate((_e, tid: string) => (globalThis as G).__agentworkspace.terminalRead(tid), id);
    await expect.poll(read).toContain('ready');
    await shell.locator(`[data-terminal-id="${id}"]`).click();

    // Through sendInputEvent, so main's before-input-event sees the keys too.
    await shortcut(app, 'L');
    await shortcut(app, 'T');
    await shell.keyboard.type('z');
    await shell.keyboard.press('Enter');
    await expect.poll(read).toContain('\\x0c');
    await expect.poll(read).toContain('\\x14');
    expect(await addressBar(app)).toEqual({ open: false, mode: 'new' });
    await expect(shell.locator('#tabAddressBar')).toHaveCount(0);
    expect((await state(app)).paneOpen).toBe(false);
    expect(
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentBounds().width),
    ).toBe(width);
  } finally {
    await dispose(launched);
  }
});

// --- links dropped onto the tab row -------------------------------------------

type DragKind = 'dragenter' | 'dragover' | 'dragleave' | 'drop';

// A synthetic HTML5 drag on the strip; it bubbles to the pane segment's
// handlers. Returns whether the handler accepted it (defaultPrevented).
async function drag(
  app: ElectronApplication,
  kind: DragKind,
  data: Record<string, string>,
): Promise<boolean> {
  return (await evaluateInShell(
    app,
    `(() => {
      const target = document.getElementById('tabStrip');
      if (!target) throw new Error('no #tabStrip');
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(${JSON.stringify(data)})) dt.setData(type, value);
      const event = new DragEvent(${JSON.stringify(kind)}, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    })()`,
  )) as boolean;
}

async function dropUrl(app: ElectronApplication, url: string): Promise<void> {
  await drag(app, 'dragenter', { 'text/uri-list': url });
  await drag(app, 'dragover', { 'text/uri-list': url });
  await drag(app, 'drop', { 'text/uri-list': `# dragged\r\n${url}\r\n`, 'text/plain': url });
}

async function visibleTabs(app: ElectronApplication) {
  const s = await state(app);
  return { ids: s.tabs.tabs.map((tab) => tab.id), activeId: s.tabs.activeId };
}

function tabInfo(app: ElectronApplication, id: string) {
  return app.evaluate((_e, tid: string) => (globalThis as G).__agentworkspace.tabInfo(tid), id);
}

test('a link dragged over the tab row shows the drop hint; sidebar drags and plain text do not open tabs', async () => {
  const launched = await launch();
  const { app, shell, logFile } = launched;
  const hint = shell.locator('#tabDropHint');
  try {
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(true));
    await expect(shell.locator('#tabStrip')).toHaveAttribute('aria-label', 'Linked Context tabs');
    await expect(shell.locator('[data-testid="tabStripEmpty"]')).toHaveText(
      'No tabs yet — drop a link here or press +',
    );
    const url = `${fixtures.idpUrl}/page/drop`;

    expect(await drag(app, 'dragenter', { 'text/uri-list': url })).toBe(true);
    expect(await drag(app, 'dragover', { 'text/uri-list': url })).toBe(true);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('data-state', 'drop');
    await drag(app, 'dragleave', { 'text/uri-list': url });
    await expect(hint).toHaveCount(0);

    // Sidebar row / folder drags are not accepted and never show the hint.
    for (const mime of ['application/x-devin-session', 'application/x-devin-folder']) {
      expect(await drag(app, 'dragenter', { [mime]: 'row', 'text/plain': url })).toBe(false);
      expect(await drag(app, 'dragover', { [mime]: 'row', 'text/plain': url })).toBe(false);
      await expect(hint).toHaveCount(0);
      await drag(app, 'drop', { [mime]: 'row', 'text/plain': url });
    }
    // Neither is a file drag.
    expect(await drag(app, 'dragover', { Files: '' })).toBe(false);
    await expect(hint).toHaveCount(0);
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // Plain text that is not a URL: no tab, a transient error hint.
    await drag(app, 'dragenter', { 'text/plain': 'hello world' });
    expect(await drag(app, 'dragover', { 'text/plain': 'hello world' })).toBe(true);
    await drag(app, 'drop', { 'text/plain': 'hello world', 'text/html': '<b>hello world</b>' });
    await expect(hint).toHaveAttribute('data-state', 'error');
    await expect(hint).toHaveText("That doesn't look like a web address");
    await expect(hint).toHaveCount(0, { timeout: 8_000 });
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // A javascript: link is refused by main, never opened.
    await drag(app, 'drop', { 'text/uri-list': 'javascript:alert(1)' });
    await expect(hint).toHaveText('Only http and https addresses can open here');
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // A file: link is refused by main too.
    await drag(app, 'drop', { 'text/uri-list': 'file:///etc/passwd' });
    await expect(hint).toHaveText('Only http and https addresses can open here');
    expect((await state(app)).tabs.tabs).toHaveLength(0);

    // The diagnostic stays off without AGENT_WORKSPACE_DEBUG_DROPS.
    expect((await readEvents(logFile)).some((e) => e.event === 'tab-drop-types')).toBe(false);
  } finally {
    await dispose(launched);
  }
});

test('a dropped link opens in the current scope on every surface; a duplicate focuses the existing tab', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-workspace-usertabs-'));
  const claudeHome = join(dir, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const claudeId = '11111111-0000-4000-8000-00000000000a';
  const openhandsId = '0123456789abcdef0123456789abcd0d';
  fixtures.openhands.setConversations([
    {
      id: openhandsId,
      title: 'Drop target',
      selected_repository: 'o/r',
      git_provider: 'github',
      sandbox_status: 'RUNNING',
      execution_status: 'running',
      created_at: '2026-10-20T09:00:00Z',
      updated_at: '2026-10-20T10:00:00Z',
    },
  ]);
  const launched = await launch(dir, {
    CLAUDE_CONFIG_DIR: claudeHome,
    AGENT_WORKSPACE_DEBUG_DROPS: '1',
  });
  const { app, logFile } = launched;
  try {
    await app.evaluate(() => (globalThis as G).__agentworkspace.setPaneOpen(true));

    // Cloud: the open session's scope, then the duplicate rule.
    await openSession(app, 'A');
    const first = `${fixtures.idpUrl}/page/drop`;
    const second = `${fixtures.idpUrl}/page/drop-2`;
    await dropUrl(app, first);
    await waitForTabCount(app, 1);
    const firstId = (await visibleTabs(app)).ids[0]!;
    expect(await tabInfo(app, firstId)).toMatchObject({ url: first, originSessionId: 'A' });
    await dropUrl(app, second);
    await waitForTabCount(app, 2);
    await expect.poll(async () => (await visibleTabs(app)).activeId).not.toBe(firstId);
    await dropUrl(app, first);
    await expect.poll(async () => (await visibleTabs(app)).activeId).toBe(firstId);
    expect((await visibleTabs(app)).ids).toHaveLength(2);

    const surfaces: Array<{ name: string; scope: string; enter: () => Promise<unknown> }> = [
      {
        name: 'local',
        scope: 'local:drop-local-1',
        enter: async () => {
          await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('local'));
          await evaluateInShell(app, `window.agentworkspace.localActiveSession('drop-local-1')`);
        },
      },
      {
        name: 'claude',
        scope: `claude:${claudeId}`,
        enter: async () => {
          await app.evaluate(() => (globalThis as G).__agentworkspace.setSurface('claude'));
          await app.evaluate(
            (_e, id: string) => (globalThis as G).__agentworkspace.claudeSelect(id),
            claudeId,
          );
        },
      },
      {
        name: 'openhands',
        scope: `openhands:${openhandsId}`,
        enter: () =>
          app.evaluate(
            (_e, id: string) => (globalThis as G).__agentworkspace.openhandsOpen(id),
            openhandsId,
          ),
      },
    ];
    for (const surface of surfaces) {
      await surface.enter();
      await expect
        .poll(async () => (await state(app)).tabs.scope, { message: surface.name })
        .toBe(surface.scope);
      const url = `${fixtures.idpUrl}/page/drop-${surface.name}`;
      await dropUrl(app, url);
      await expect
        .poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.url), {
          message: surface.name,
        })
        .toEqual([url]);
      const id = (await visibleTabs(app)).ids[0]!;
      expect(await tabInfo(app, id)).toMatchObject({ url, originSessionId: surface.scope });
    }

    // AGENT_WORKSPACE_DEBUG_DROPS: one event per drag entering the row (each
    // dropUrl), MIME type names only — never the dropped values.
    const diagnostics = (await readEvents(logFile)).filter((e) => e.event === 'tab-drop-types');
    expect(diagnostics).toHaveLength(6);
    const opens = (await readEvents(logFile)).filter(
      (e) => e.event === 'tab-user-open' && (e.detail as { source?: string }).source === 'drop',
    );
    expect(opens.length).toBeGreaterThanOrEqual(1);
    for (const event of opens) expect(event.detail).toMatchObject({ source: 'drop', target: 'new' });
    for (const event of diagnostics) expect(event.detail).toEqual({ types: ['text/uri-list'] });
    for (const event of diagnostics) expect(JSON.stringify(event)).not.toContain('/page/');
  } finally {
    await dispose(launched);
  }
});
