// Quiet mode (plans/quiet-tests.md): test-mode launches run invisible —
// opacity 0, skip-taskbar, never activated — so a full suite doesn't take
// over the desktop. These specs pin the mode's own invariants: the log
// event, the window state, that screenshots still capture content, and that
// window geometry round-trips (the two things parked-window options broke).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchApp, readEvents, shellPage } from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const windowInfo = (app: ElectronApplication) =>
  app.evaluate(
    ({ BaseWindow }) => ({
      opacity: BaseWindow.getAllWindows()[0]?.getOpacity() ?? -1,
      focused: BaseWindow.getAllWindows()[0]?.isFocused() ?? null,
      visible: BaseWindow.getAllWindows()[0]?.isVisible() ?? null,

      bounds: BaseWindow.getAllWindows()[0]?.getContentBounds() ?? null,
    }),
  ) as Promise<{
    opacity: number;
    focused: boolean | null;
    visible: boolean | null;
    bounds: { width: number; height: number } | null;
  }>;

test('quiet (default): invisible + never activated; screenshot still renders; geometry round-trips', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-quiet-'));
  const logFile = join(profile, 'events.jsonl');
  // Pin '1' so the case is quiet even when the whole suite runs headed
  // (test:e2e:headed exports DEVIN_WORKSPACES_TEST_QUIET=0 process-wide).
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_TEST_QUIET: '1',
  });
  try {
    const shell = await shellPage(app);
    const info = await windowInfo(app);
    expect(info.opacity).toBe(0);
    expect(info.focused).toBe(false);
    const events = await readEvents(logFile);
    expect(events.some((e) => e.event === 'window-quiet')).toBe(true);

    // The window still renders: a CDP screenshot succeeds, and the compositor
    // output (capturePage → raw bitmap) has real dimensions and more than one
    // colour. Pixel facts, not PNG byte counts — compression varies per machine.
    const shot = await shell.screenshot();
    expect(shot.length).toBeGreaterThan(0);
    const render = await app.evaluate(async () => {
      const contents = (globalThis as any).__devinworkspaces.getShellWebContents() as
        Electron.WebContents;
      const image = await contents.capturePage();
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const colours = new Set<number>();
      // Sample every 97th pixel (BGRA) — enough to see chrome vs. content.
      for (let i = 0; i < bitmap.length && colours.size < 3; i += 4 * 97) {
        colours.add((bitmap[i]! << 16) | (bitmap[i + 1]! << 8) | bitmap[i + 2]!);
      }
      return { width, height, distinctColours: colours.size };
    });
    expect(render.width).toBeGreaterThan(1000);
    expect(render.height).toBeGreaterThan(600);
    expect(render.distinctColours).toBeGreaterThan(1);

    // Geometry still round-trips (the parked-window approach broke this).
    await app.evaluate(
      (_e, size) =>
        (globalThis as any).__devinworkspaces.setWindowSize(size.w, size.h),
      { w: 1000, h: 800 },
    );
    const small = (await windowInfo(app)).bounds!;
    expect(Math.abs(small.width - 1000)).toBeLessThanOrEqual(1);
    expect(small.height).toBe(800);
    await app.evaluate(
      (_e, size) =>
        (globalThis as any).__devinworkspaces.setWindowSize(size.w, size.h),
      { w: 1400, h: 900 },
    );
    const full = (await windowInfo(app)).bounds!;
    expect(full.width).toBe(1400);
    expect(full.height).toBe(900);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('DEVIN_WORKSPACES_TEST_QUIET=0: headed run keeps the window visible', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-headed-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    DEVIN_WORKSPACES_TEST_QUIET: '0',
  });
  try {
    await shellPage(app);
    const info = await windowInfo(app);
    expect(info.opacity).toBe(1);
    expect(info.visible).toBe(true);
    const events = await readEvents(logFile);
    expect(events.some((e) => e.event === 'window-quiet')).toBe(false);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
