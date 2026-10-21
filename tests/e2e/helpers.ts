import { cpSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import type { FixtureServers } from '../fixtures/http';

export type PublicState = {
  paneOpen: boolean;
  paneFraction: number;
  paneCollapsed: boolean;
  sessionsOpen: boolean;
  sessionsWidth: number;
  sessionsCollapsed: boolean;
  surface: 'cloud' | 'local' | 'settings' | 'analytics';
  currentSessionId: string | null;
  localSessionId: string | null;
  credentials: Array<{
    id: string;
    origin: string;
    username: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number | null;
  }>;
  autofill: {
    picker: {
      accounts: Array<{ id: string; username: string }>;
      anchor: { x: number; y: number; width: number; height: number };
    } | null;
    prompt: {
      kind: 'save' | 'update';
      origin: string;
      username: string;
      anchor: { x: number; y: number; width: number; height: number };
    } | null;
  };
  settings: Record<string, unknown> & {
    tabs: { keepAliveHours: number; maxLiveTabs: number };
    workspaces?: string[];
  };
  tabs: {
    activeId: string | null;
    scope: string;
    hiddenTabCount: number;
    tabs: Array<{
      id: string;
      url: string;
      title: string;
      favicon?: string;
      loading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
      originSessionId?: string;
      discarded?: boolean;
    }>;
  };
  // F5 terminal dock
  terminalOpen: boolean;
  terminalHeight: number;
  terminals: Array<{
    id: string;
    kind: 'devin' | 'shell';
    sessionId: string | null;
    cwd: string;
    title: string;
    exitCode: number | null;
  }>;
  activeTerminalId: string | null;
  // Execution hosts (local first).
  hosts: Array<{
    id: string;
    kind: 'local' | 'wsl';
    label: string;
    state: 'ready' | 'probing' | 'stopped' | 'disabled' | 'error';
    error: string | null;
    probedAt: string | null;
    home: string | null;
    shell: string | null;
    node: string | null;
    claude: { path: string | null; version: string | null };
    devin: { path: string | null };
    shellEnv: { ok: boolean; count: number; ms: number } | null;
    hooks: 'ok' | 'unreachable' | 'untested';
    inotify: boolean;
    gh: boolean;
    helper?: import('../../src/shared/ipc').HostStatus['helper'];
  }>;
  // P5
  notifications: {
    collect: boolean;
    banner: boolean;
    hasToken: boolean;
    lastPollAt: string | null;
    authError: boolean;
    lastError: string | null;
    noUserIdentity: boolean;
    identity: { source: 'self' | 'cli' | 'inferred' | 'manual' | null; resolved: boolean };
    openPrCount: number;
    unreadPrCount: number;
    prsPanelOpen: boolean;
    unreadCount: number;
    panelOpen: boolean;
  };
  update: {
    version: string;
    available: string | null;
    downloaded: string | null;
    enabled: boolean;
    checking: boolean;
    lastCheckedAt: string | null;
    error: string | null;
  };
  cloud: import('../../src/shared/ipc').CloudState;
  usage: {
    level: 'none' | 'warn' | 'critical';
    items: Array<{ metric: string; accountKey: string; label: string; percent: number }>;
    devin: import('../../src/shared/ipc').DevinUsageState;
  };
};

const profileWslRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-wsl-'));

// Quiet mode is the default for every test-mode launch (window invisible,
// never takes the desktop foreground); AGENT_WORKSPACE_TEST_QUIET=0 shows it
// — that is what  sets for watching a run.
export async function launchApp(
  userData: string,
  logFile: string,
  downloadDir: string,
  fixtures: FixtureServers,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: [process.cwd()],
    timeout: 30_000,
    env: {
      ...process.env,
      ...extraEnv,
      AGENT_WORKSPACE_TEST: '1',
      AGENT_WORKSPACE_TENANT_URL: fixtures.devinUrl,
      AGENT_WORKSPACE_TEST_GITHUB_ORIGINS: fixtures.githubOrigins,
      AGENT_WORKSPACE_USER_DATA: userData,
      AGENT_WORKSPACE_LOG: logFile,
      AGENT_WORKSPACE_DOWNLOAD_DIR: downloadDir,
      AGENT_WORKSPACE_ALLOW_EXTERNAL: '0',
      // Legacy specs assume the sessions column is closed (devin.x === RAIL).
      AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '0',
      AGENT_WORKSPACE_TEST_RELEASES_URL: fixtures.apiUrl,
      // Analytics Claude tab (A2): the usage fixture + account file live under
      // tests/fixtures; nothing reads them until the service lands.
      AGENT_WORKSPACE_TEST_CLAUDE_USAGE_URL: fixtures.claudeUsageUrl,
      // Devin usage metric: fixture endpoint; slow default cadence — specs
      // opt into faster polling.
      AGENT_WORKSPACE_TEST_DEVIN_USAGE_URL: fixtures.devinUsageUrl,
      AGENT_WORKSPACE_TEST_DEVIN_USAGE_POLL_MS: '600000',
      AGENT_WORKSPACE_TEST_CLAUDE_ACCOUNT_FILE: join(
        process.cwd(),
        'tests/fixtures/claude-account.json',
      ),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // Route every wsl.exe call through the fake; with no distros the app
      // stays local-only. Specs opt into distros via FAKE_WSL_DISTROS.
      AGENT_WORKSPACE_TEST_WSL_CMD: `node ${join(process.cwd(), 'out/fixtures/fakeWsl.cjs')}`,
      FAKE_WSL_DISTROS: '',
      FAKE_WSL_ROOT: join(profileWslRoot, 'root'),
      ...extraEnv,
    },
  });
  const dismissDialogs = (page: import('@playwright/test').Page) => {
    page.on('dialog', async (dialog) => {
      if (dialog.type() !== 'beforeunload') return;
      try {
        await dialog.dismiss();
      } catch (error) {
        if (!String(error).includes('No dialog is showing')) throw error;
      }
    });
  };
  app.context().pages().forEach(dismissDialogs);
  app.context().on('page', dismissDialogs);

  // Fail fast when the display clamps the window below the pane threshold —
  // otherwise every pane-dependent assertion just times out mysteriously.
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  const width = await app.evaluate(
    ({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getContentBounds().width ?? 0,
  );
  if (width < 1400) {
    let detail = '';
    try {
      detail =
        readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line.includes('window-size'))
          .pop() ?? '';
    } catch {
      // log may not exist yet
    }
    throw new Error(
      `runner display too small: window content width ${width}px (<1400) — ${detail}. ` +
        `see scripts/ci-display.ps1`,
    );
  }
  return app;
}

export async function state(app: ElectronApplication): Promise<PublicState> {
  return app.evaluate(
    () =>
      (globalThis as typeof globalThis & { __agentworkspace: { state(): PublicState } })
        .__agentworkspace.state(),
  );
}

export async function hasDevinView(
  app: ElectronApplication,
  fixtures: FixtureServers,
): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, url: string) =>
      webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(url)),
    fixtures.devinUrl,
  );
}

export async function currentDevinUrl(
  app: ElectronApplication,
  fixtures: FixtureServers,
): Promise<string | undefined> {
  return app.evaluate(
    ({ webContents }, url: string) =>
      webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url))?.getURL(),
    fixtures.devinUrl,
  );
}

export async function hasFixtureFrame(
  app: ElectronApplication,
  fixtures: FixtureServers,
): Promise<boolean> {
  return app.evaluate(
    async ({ webContents }, url: string) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
      const frame = contents?.mainFrame.frames.find((item) => item.url.endsWith('/frame'));
      return frame
        ? Boolean(
            await frame.executeJavaScript(
              `document.readyState === 'complete' && Boolean(document.getElementById('iframeTop'))`,
            ),
          )
        : false;
    },
    fixtures.devinUrl,
  );
}

export async function fixtureFrameUrl(
  app: ElectronApplication,
  fixtures: FixtureServers,
): Promise<string | undefined> {
  return app.evaluate(
    ({ webContents }, url: string) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
      return contents?.mainFrame.frames.find((frame) => frame.url !== contents.getURL())?.url;
    },
    fixtures.devinUrl,
  );
}

// executeJavaScript can hang forever when the renderer never runs the script
// (mid-navigation, hung isolate). Race it inside the evaluated callback so a
// hang becomes a test failure, not a worker-teardown timeout.
// (The 20 s literal is inlined because app.evaluate serializes the callback.)

export async function evaluateInView(
  app: ElectronApplication,
  urlPrefix: string,
  script: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, args: { urlPrefix: string; script: string }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(args.urlPrefix));
      if (!contents) throw new Error(`No webContents for ${args.urlPrefix}`);
      return Promise.race([
        contents.executeJavaScript(args.script),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `executeJavaScript timed out for ${args.urlPrefix}: ${args.script.slice(0, 80)}`,
                ),
              ),
            20_000,
          ),
        ),
      ]);
    },
    { urlPrefix, script },
  );
}

// React-compatible input fill: the native value setter + a bubbling 'input'
// event is what React's controlled-input onChange listens for.
export async function setInputValue(
  app: ElectronApplication,
  id: string,
  value: string,
): Promise<boolean> {
  return (await evaluateInShell(
    app,
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  )) as boolean;
}

export async function evaluateInShell(
  app: ElectronApplication,
  script: string,
): Promise<unknown> {
  return app.evaluate(async ({ webContents }, source: string) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().startsWith('app://shell/'));
    if (!contents) throw new Error('Shell WebContents not found');
    return Promise.race([
      contents.executeJavaScript(source),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`executeJavaScript timed out for shell: ${source.slice(0, 80)}`),
            ),
          20_000,
        ),
      ),
    ]);
  }, script);
}

export async function runInFrame(
  app: ElectronApplication,
  fixtures: FixtureServers,
  script: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, args: { devinUrl: string; script: string }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(args.devinUrl));
      const frame = contents?.mainFrame.frames.find((candidate) => candidate.url.endsWith('/frame'));
      if (!frame) throw new Error('Fixture iframe did not load');
      return frame.executeJavaScript(args.script);
    },
    { devinUrl: fixtures.devinUrl, script },
  );
}

export async function waitForTabCount(app: ElectronApplication, count: number): Promise<void> {
  await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(count);
}

export async function waitForTabTitle(app: ElectronApplication, title: string): Promise<void> {
  await expect
    .poll(async () => (await state(app)).tabs.tabs.some((tab) => tab.title.includes(title)))
    .toBe(true);
}

export async function openTab(app: ElectronApplication, url: string): Promise<string> {
  const id = await app.evaluate((_electron, targetUrl: string) => {
    return (
      globalThis as typeof globalThis & { __agentworkspace: { open(url: string): string } }
    ).__agentworkspace.open(targetUrl);
  }, url);
  if (typeof id !== 'string') throw new Error(`Could not open fixture tab at ${url}`);
  return id;
}

// Quit + close with hard ceilings, then kill the process if it's still
// alive — a hung quit() must not stall the worker teardown. Every step can
// throw synchronously when the connection is already half-closed, so each is
// individually wrapped.
export async function closeApp(app: ElectronApplication): Promise<void> {
  try {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.quit()),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    // connection gone or hung — fall through to close/kill
  }
  try {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  } catch {
    // ignore — kill below covers a lingering process
  }
  try {
    const proc = app.process();
    if (proc && proc.exitCode === null && !proc.killed) proc.kill();
  } catch {
    // no process handle available
  }
}

export async function readEvents(logFile: string): Promise<Array<Record<string, unknown>>> {
  const text = readFileSync(logFile, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function waitForEvent(
  logFile: string,
  event: string,
  decision?: string,
): Promise<void> {
  await expect
    .poll(async () =>
      (await readEvents(logFile)).some(
        (entry) => entry.event === event && (decision === undefined || entry.decision === decision),
      ),
    )
    .toBe(true);
}

export async function waitForEventCount(
  logFile: string,
  event: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await readEvents(logFile)).filter((entry) => entry.event === event).length)
    .toBeGreaterThanOrEqual(count);
}

export async function waitForDecision(
  logFile: string,
  decision: string,
  urlIncludes: string,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await expect
    .poll(async () => {
      found = (await readEvents(logFile)).find(
        (entry) =>
          entry.decision === decision &&
          typeof entry.url === 'string' &&
          entry.url.includes(urlIncludes),
      );
      return Boolean(found);
    })
    .toBe(true);
  return found!;
}

// Events that would have handed a URL to the system browser (`external` / `mailto`
// decisions), filtered to the GitHub-class fixture origins. Must always be empty (R7).
export async function githubExternalEvents(
  logFile: string,
  fixtures: FixtureServers,
): Promise<Array<Record<string, unknown>>> {
  const origins = fixtures.githubOrigins.split(',');
  return (await readEvents(logFile)).filter(
    (entry) =>
      (entry.decision === 'external' || entry.decision === 'mailto' || entry.event === 'external-open') &&
      typeof entry.url === 'string' &&
      origins.some((origin) => (entry.url as string).startsWith(origin)),
  );
}

export async function browserWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

export async function webContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
}

// Playwright Page for a hosted view (shell / devin / gh tab). Every WebContentsView is a
// CDP page target, so real pointer/keyboard input can be driven through it.
export async function pageFor(app: ElectronApplication, urlPrefix: string): Promise<Page> {
  let page: Page | undefined;
  await expect
    .poll(() => {
      page = app.context().pages().find((candidate) => candidate.url().startsWith(urlPrefix));
      return Boolean(page);
    })
    .toBe(true);
  return page!;
}

export function shellPage(app: ElectronApplication): Promise<Page> {
  return pageFor(app, 'app://shell/');
}

export async function tabPage(app: ElectronApplication, tabUrl: string): Promise<Page> {
  return pageFor(app, tabUrl);
}

// Real mouse click (optionally with Ctrl / middle button) on an element inside a hosted
// view. Uses raw input instead of `locator.click()` because Playwright's actionability
// checks wait for "scheduled navigations" that the main process intentionally cancels
// (will-navigate preventDefault), which would hang the test.
// Element geometry is read through Electron's executeJavaScript (not Playwright locators)
// for the same reason: after a cancelled navigation the Playwright frame stays "navigating".
export async function clickLink(
  app: ElectronApplication,
  page: Page,
  selector: string,
  options: { ctrl?: boolean; middle?: boolean } = {},
): Promise<void> {
  const urlPrefix = page.url();
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(async () => {
      try {
        box = (await evaluateInView(
          app,
          urlPrefix,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            // First line box: inline links may wrap, leaving the bounding-box centre empty.
            const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })()`,
        )) as typeof box;
      } catch {
        box = null;
      }
      return Boolean(box && box.width > 0 && box.height > 0);
    })
    .toBe(true);
  if (!box) throw new Error(`No bounding box for ${selector}`);
  const rect = box as { x: number; y: number; width: number; height: number };
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (options.ctrl) await page.keyboard.down('Control');
  await page.mouse.move(x, y);
  await page.mouse.down({ button: options.middle ? 'middle' : 'left' });
  await page.mouse.up({ button: options.middle ? 'middle' : 'left' });
  if (options.ctrl) await page.keyboard.up('Control');
}

// Real pointer drag of one tab onto another in the shell strip (dnd-kit PointerSensor:
// 5px activation distance, then horizontal moves, then release over the target).
// Requires both tabs fully inside the strip — no autoscroll heuristics; use
// keyboardReorderTab when the strip overflows.
export async function dragTab(page: Page, fromId: string, toId: string): Promise<void> {
  const from = page.locator(`[data-tab-id="${fromId}"]`);
  const to = page.locator(`[data-tab-id="${toId}"]`);
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const stripBox = await page.locator('#tabStrip').boundingBox();
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox || !stripBox) throw new Error('Tab elements not visible for drag');
  const inside = (b: { x: number; width: number }) =>
    b.x >= stripBox.x - 1 && b.x + b.width <= stripBox.x + stripBox.width + 1;
  if (!inside(fromBox) || !inside(toBox)) {
    throw new Error(
      `dragTab requires both tabs fully visible; strip overflows — widen the pane or use keyboardReorderTab (from ${JSON.stringify(fromBox)} to ${JSON.stringify(toBox)}, strip ${JSON.stringify(stripBox)})`,
    );
  }
  const orderBefore = await page.locator('#tabStrip [data-tab-id]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-tab-id')),
  );
  const startX = fromBox.x + fromBox.width / 2;
  const y = fromBox.y + fromBox.height / 2;
  const dir = Math.sign(toBox.x - fromBox.x) || 1;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  // 4 moves of 4px (> 5px activation distance) in the target direction.
  for (let i = 1; i <= 4; i += 1) {
    await page.mouse.move(startX + dir * i * 4, y);
    await page.waitForTimeout(30);
  }
  await page.mouse.move(toBox.x + toBox.width / 2 + (dir * toBox.width) / 4, y, { steps: 8 });
  await page.mouse.up();
  // Wait for the strip order to actually change rather than a fixed delay —
  // the reorder applies after dnd-kit's drop animation.
  try {
    await page.waitForFunction(
      (prev) => {
        const ids = [...document.querySelectorAll('#tabStrip [data-tab-id]')].map((el) =>
          el.getAttribute('data-tab-id'),
        );
        return ids.join(',') !== (prev as string[]).join(',');
      },
      orderBefore,
      { timeout: 5000 },
    );
  } catch {
    throw new Error(`Tab order did not change after drop: ${orderBefore.join(',')}`);
  }
}

// Deterministic reorder via the dnd-kit KeyboardSensor on the tab's drag handle:
// focus handle → Space (pick up) → ArrowLeft/Right → Space (drop).
export async function keyboardReorderTab(
  page: Page,
  tabId: string,
  direction: 'left' | 'right',
): Promise<void> {
  const orderBefore = await page.locator('#tabStrip [data-tab-id]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-tab-id')),
  );
  const handle = page.locator(`[data-tab-id="${tabId}"] .dragHandle`);
  await handle.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  await page.keyboard.press(direction === 'left' ? 'ArrowLeft' : 'ArrowRight');
  await page.waitForTimeout(120);
  await page.keyboard.press('Space');
  await page.waitForFunction(
    (prev) => {
      const ids = [...document.querySelectorAll('#tabStrip [data-tab-id]')].map((el) =>
        el.getAttribute('data-tab-id'),
      );
      return ids.join(',') !== (prev as string[]).join(',');
    },
    orderBefore,
    { timeout: 5000 },
  );
}

/**
 * Deterministic HTML5 drag & drop: dispatch a synthetic drag sequence with a
 * real DataTransfer so React handlers see the exact MIME types the app uses.
 * Playwright's dragTo drives the browser's native DnD pipeline, which flakes
 * on HTML5 draggable elements; this skips the input pipeline entirely.
 */
export async function dndMove(page: Page, sourceSel: string, targetSel: string) {
  await page.evaluate(
    ([src, tgt]) => {
      const source = document.querySelector(src as string);
      const target = document.querySelector(tgt as string);
      if (!source || !target) {
        throw new Error(`dndMove: missing element ${!source ? src : tgt}`);
      }
      const dataTransfer = new DataTransfer();
      const fire = (el: Element, type: string, cancelable = true) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable, dataTransfer }),
        );
      fire(source, 'dragstart');
      fire(target, 'dragover');
      fire(target, 'drop');
      fire(source, 'dragend');
    },
    [sourceSel, targetSel] as const,
  );
}

export const CLAUDE_FIXTURE_HOME = resolve(__dirname, '../fixtures/claude-home');

// §4.5/§5.4: launch with a COPY of the committed claude-home fixture — the
// SDK writes into CLAUDE_CONFIG_DIR, so specs never point at the source tree.
export async function launchWithClaudeFixture(
  fixtures: FixtureServers,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; profile: string; claudeHome: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    ...extraEnv,
  });
  return { app, profile, claudeHome };
}

