import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { evaluateInShell, launchApp, readEvents, shellPage, state, waitForEventCount } from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test('tracks current session id from devin view navigation', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    await app.evaluate((_electron, url: string) => {
      (globalThis as typeof globalThis & {
        __agentworkspace: { loadDevinUrl(url: string): void };
      }).__agentworkspace.loadDevinUrl(url);
    }, `${fixtures.devinUrl}/sessions/abc123`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('abc123');
    await app.evaluate((_electron, url: string) => {
      (globalThis as typeof globalThis & {
        __agentworkspace: { loadDevinUrl(url: string): void };
      }).__agentworkspace.loadDevinUrl(url);
    }, `${fixtures.devinUrl}/`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(null);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('auto-collapses the pane below the minimum devin width', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const tabId = await app.evaluate((_electron, url: string) => {
      return (
        globalThis as typeof globalThis & { __agentworkspace: { open(url: string): string } }
      ).__agentworkspace.open(url);
    }, `${fixtures.githubUrl}/page/collapse`);
    expect((await state(app)).paneCollapsed).toBe(false);

    await app.evaluate((_electron) => {
      (globalThis as typeof globalThis & {
        __agentworkspace: { setWindowSize(w: number, h: number): void };
      }).__agentworkspace.setWindowSize(1000, 800);
    });
    await expect.poll(async () => (await state(app)).paneCollapsed).toBe(true);
    expect((await state(app)).paneOpen).toBe(true);
    const collapsedBounds = await app.evaluate((_electron, id: string) => {
      return (
        globalThis as typeof globalThis & {
          __agentworkspace: { getTabBounds(id: string): { width: number } | null };
        }
      ).__agentworkspace.getTabBounds(id);
    }, tabId);
    expect(collapsedBounds?.width).toBe(0);

    await app.evaluate((_electron) => {
      (globalThis as typeof globalThis & {
        __agentworkspace: { setWindowSize(w: number, h: number): void };
      }).__agentworkspace.setWindowSize(1400, 900);
    });
    await expect.poll(async () => (await state(app)).paneCollapsed).toBe(false);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('pane toggle resizes the window and keeps the devin column width', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-pane-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  type PaneHooks = {
    setWindowSize(w: number, h: number): void;
    getContentBounds(): { width: number; height: number } | null;
    layoutRects(): { devin: { width: number }; paneCollapsed: boolean };
    setPaneOpen(value: boolean): void;
  };
  type G = typeof globalThis & { __agentworkspace: PaneHooks };
  const contentWidth = (): Promise<number> =>
    app.evaluate(() => (globalThis as G).__agentworkspace.getContentBounds()!.width);
  const devinWidth = (): Promise<number> =>
    app.evaluate(() => (globalThis as G).__agentworkspace.layoutRects().devin.width);
  const setPane = (value: boolean): Promise<void> =>
    app.evaluate((_e, v: boolean) => (globalThis as G).__agentworkspace.setPaneOpen(v), value);
  try {
    await app.evaluate(() => (globalThis as G).__agentworkspace.setWindowSize(1400, 900));
    await expect.poll(contentWidth).toBe(1400);
    const devin = await devinWidth();

    await setPane(false);
    await expect.poll(contentWidth).toBe(56 + devin);
    await expect.poll(devinWidth).toBe(devin);
    expect((await state(app)).paneOpen).toBe(false);

    await setPane(true);
    await expect.poll(contentWidth).toBe(1400);
    await expect.poll(devinWidth).toBe(devin);
    expect((await state(app)).paneOpen).toBe(true);

    // Maximised: no window resize — the pane keeps splitting in-window.
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.maximize());
    await expect
      .poll(async () =>
        app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isMaximized()),
      )
      .toBe(true);
    const maximizedBounds = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0]!.getBounds(),
    );
    await setPane(false);
    await expect.poll(async () => (await state(app)).paneOpen).toBe(false);
    const afterToggleBounds = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0]!.getBounds(),
    );
    expect(afterToggleBounds).toEqual(maximizedBounds);
    await expect.poll(devinWidth).toBeGreaterThan(devin);
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.unmaximize());
    await expect
      .poll(async () =>
        app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isMaximized()),
      )
      .toBe(false);

    const events = await readEvents(logFile);
    const toggles = events.filter(
      (entry) =>
        entry.event === 'pane-toggle' &&
        (entry.detail as { resized?: boolean } | undefined)?.resized === true,
    );
    expect(toggles.length).toBeGreaterThanOrEqual(2);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('renders a custom title bar with the tab strip inside', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    const shell = await shellPage(app);
    await expect(shell.locator('#titleBar')).toBeVisible();
    await expect(shell.locator('#navBar')).toHaveCount(0);
    const devinBounds = await app.evaluate(() =>
      (globalThis as typeof globalThis & {
        __agentworkspace: { getDevinBounds(): { y: number; height: number } | null };
      }).__agentworkspace.getDevinBounds(),
    );
    expect(devinBounds?.y).toBe(36);

    const tabId = await app.evaluate((_electron, url: string) => {
      return (
        globalThis as typeof globalThis & { __agentworkspace: { open(url: string): string } }
      ).__agentworkspace.open(url);
    }, `${fixtures.githubUrl}/page/titlebar`);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(tabId);
    const tabBounds = await app.evaluate((_electron, id: string) => {
      return (
        globalThis as typeof globalThis & {
          __agentworkspace: {
            getTabBounds(id: string): { y: number; height: number } | null;
            getDevinBounds(): { y: number; height: number } | null;
          };
        }
      ).__agentworkspace.getTabBounds(id);
    }, tabId);
    expect(tabBounds?.y).toBe(36);
    expect(tabBounds?.height).toBe(devinBounds?.height);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('persists settings across relaunch', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  let app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    // 0.9 of the 1338 px available at 1400 px would be 1204 px — more than the
    // MIN_DEVIN_WIDTH guard allows (698 px). The layout clamps what it renders, but
    // the stored preference must stay exactly what was set, across a restart.
    await evaluateInShell(
      app,
      `window.agentworkspace.setSettings({ pane: { fraction: 0.9 } })`,
    );
    await expect.poll(async () => (await state(app)).paneFraction).toBe(0.9);
    expect((await state(app)).paneCollapsed).toBe(false);
    expect(existsSync(join(profile, 'settings.json'))).toBe(true);

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
    const persisted = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    expect(persisted.pane.fraction).toBe(0.9);
    expect(persisted.pane.width).toBeUndefined();

    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    expect((await state(app)).paneFraction).toBe(0.9);
    // Still unclamped after the first syncFromState of the new run.
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 2);
    await app.close();
    const afterRestart = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    expect(afterRestart.pane.fraction).toBe(0.9);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('splitter drag live-resizes hosted views without raising the shell', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-drag-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    await app.evaluate((_electron, url: string) => {
      return (
        globalThis as typeof globalThis & { __agentworkspace: { open(url: string): string } }
      ).__agentworkspace.open(url);
    }, `${fixtures.githubUrl}/page/drag`);
    const shell = await shellPage(app);
    await expect(shell.locator('#splitter')).toBeVisible();
    type H = {
      childViews(): Array<{ bounds: { width: number }; url: string | null }>;
      getDevinBounds(): { width: number; height: number } | null;
    };
    const orderBefore = (await app.evaluate(() =>
      (globalThis as typeof globalThis & { __agentworkspace: H }).__agentworkspace.childViews()
        .map((v) => v.url?.startsWith('app://shell') ? 'shell' : 'hosted'),
    ));
    const devinBefore = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __agentworkspace: H }).__agentworkspace.getDevinBounds(),
    );
    expect(devinBefore).toBeTruthy();

    const box = (await shell.locator('#splitter').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + 120;
    await shell.mouse.move(cx, cy);
    await shell.mouse.down();
    await shell.mouse.move(cx + 100, cy, { steps: 4 });

    // Mid-drag (button still down): no restack, but the devin view resizes.
    const orderMid = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __agentworkspace: H }).__agentworkspace.childViews()
        .map((v) => (v.url?.startsWith('app://shell') ? 'shell' : 'hosted')),
    );
    expect(orderMid).toEqual(orderBefore);
    await expect
      .poll(async () =>
        (
          await app.evaluate(() =>
            (
              globalThis as typeof globalThis & { __agentworkspace: H }
            ).__agentworkspace.getDevinBounds(),
          )
        )?.width,
      )
      .toBeGreaterThan(devinBefore!.width);

    await shell.mouse.up();
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some((entry) => entry.event === 'drag-end'),
      )
      .toBe(true);
    const orderAfter = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __agentworkspace: H }).__agentworkspace.childViews()
        .map((v) => (v.url?.startsWith('app://shell') ? 'shell' : 'hosted')),
    );
    expect(orderAfter).toEqual(orderBefore);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('splitter renders as a hairline and swells on hover/drag', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-thin-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const shell = await shellPage(app);
    const line = shell.locator('#splitter .splitter-line');
    await expect(shell.locator('#splitter')).toBeVisible();

    // The gutter keeps the 6 px hit area; the painted line is a hairline.
    expect((await shell.locator('#splitter').boundingBox())!.width).toBe(6);
    await expect.poll(async () => (await line.boundingBox())?.width).toBe(1);

    // Hover swells the line to the full gutter.
    const box = (await shell.locator('#splitter').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + 120;
    await shell.mouse.move(cx, cy);
    await expect.poll(async () => (await line.boundingBox())?.width).toBe(6);

    // Drag keeps it thick even with the pointer off the gutter.
    await shell.mouse.down();
    await expect
      .poll(async () => shell.locator('#splitter').getAttribute('data-dragging'))
      .toBe('true');
    await shell.mouse.move(cx + 120, cy, { steps: 3 });
    await expect.poll(async () => (await line.boundingBox())?.width).toBe(6);

    await shell.mouse.up();
    await expect
      .poll(async () => shell.locator('#splitter').getAttribute('data-dragging'))
      .toBe('false');
    await expect.poll(async () => (await line.boundingBox())?.width).toBe(1);

    // The sessions-column splitter shares the styling when the sidebar is open.
    const sessionsLine = shell.locator('#sessionsSplitter .splitter-line');
    await expect(shell.locator('#sessionsSplitter')).toBeVisible();
    await expect.poll(async () => (await sessionsLine.boundingBox())?.width).toBe(1);
    const sBox = (await shell.locator('#sessionsSplitter').boundingBox())!;
    await shell.mouse.move(sBox.x + sBox.width / 2, sBox.y + 120);
    await expect.poll(async () => (await sessionsLine.boundingBox())?.width).toBe(6);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('migrates legacy spike-state.json into settings.json', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(
    join(profile, 'spike-state.json'),
    JSON.stringify({ paneOpen: true, paneWidth: 500, surface: 'cloud', tabs: { tabs: [], activeId: null } }),
  );
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const current = await state(app);
    // Legacy paneWidth 500 px → fraction 500 / (1400 - 56 - 6).
    expect(current.paneFraction).toBeCloseTo(0.374, 2);
    expect(existsSync(join(profile, 'settings.json'))).toBe(true);
    expect(existsSync(join(profile, 'spike-state.json'))).toBe(false);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('window placement restores content bounds exactly once, then stays stable', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-place-'));
  const logFile = join(profile, 'events.jsonl');
  const env = {
    AGENT_WORKSPACE_TEST_PLACEMENT: '1',
    AGENT_WORKSPACE_TEST_WINDOW_SIZE: '1410x910',
  };
  const bounds = async (app: Parameters<typeof state>[0]) =>
    app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentBounds());
  try {
    let app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, env);
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    // The launch-0 forced setContentSize emits a resize; the debounced save
    // writes the content bounds under this display key.
    await expect
      .poll(async () => {
        const saved = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return Object.keys(saved.windowPlacements ?? {}).length;
      })
      .toBe(1);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();

    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, env);
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const restored = await bounds(app);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();

    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, env);
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const again = await bounds(app);
    // No compounding growth: launch 3's content equals launch 2's exactly.
    expect(again).toEqual(restored);
    // And the restore lands within a few DIP of the requested size
    // (fractional-DIP rounding at 125% snaps once, then converges).
    expect(Math.abs(restored.width - 1410)).toBeLessThanOrEqual(4);
    expect(Math.abs(restored.height - 910)).toBeLessThanOrEqual(4);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
