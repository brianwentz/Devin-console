import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { _electron, type ElectronApplication } from 'playwright';
import { startFixtureServers } from '../tests/fixtures/http';

type ShellStateLike = {
  paneOpen: boolean;
  paneFraction: number;
  tabs: { activeId: string | null; tabs: Array<{ id: string; title: string; url: string }> };
};

const evidenceDir = resolve('docs/evidence');
const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
const electronBinary = requireFromRepo('electron') as unknown as string;
const scales = process.env.AGENT_WORKSPACE_OS_SCALE
  ? [Number(process.env.AGENT_WORKSPACE_OS_SCALE)]
  : [1, 1.5, 2];

function xdotool(args: string[], capture = false): string {
  const output = execFileSync('xdotool', args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  return typeof output === 'string' ? output.trim() : '';
}

function importScreenshot(path: string): void {
  execFileSync('import', ['-window', 'root', path], { stdio: 'ignore' });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function getState(app: ElectronApplication): Promise<ShellStateLike> {
  return app.evaluate(() => (globalThis as typeof globalThis & { __agentworkspace: { state(): ShellStateLike } }).__agentworkspace.state());
}

async function readEvents(path: string): Promise<Array<Record<string, any>>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

async function waitForEvent(
  path: string,
  predicate: (event: Record<string, any>) => boolean,
  count = 1,
): Promise<Array<Record<string, any>>> {
  await expect
    .poll(async () => (await readEvents(path)).filter(predicate).length)
    .toBeGreaterThanOrEqual(count);
  return (await readEvents(path)).filter(predicate);
}

function windowId(app: ElectronApplication): string {
  const pid = app.process().pid;
  const ids = xdotool(['search', '--onlyvisible', '--pid', String(pid)], true).split('\n').filter(Boolean);
  if (ids.length === 0) throw new Error(`No visible X11 window for Electron PID ${pid}`);
  return ids[0] as string;
}

async function runScale(scale: number, devinUrl: string, githubUrl: string): Promise<void> {
  if (process.env.DISPLAY !== ':0') {
    throw new Error(`OS-input proof requires DISPLAY=:0 (received ${process.env.DISPLAY ?? 'unset'})`);
  }
  const profile = mkdtempSync(join(tmpdir(), `agent-workspace-os-${String(scale).replace('.', '-')}-`));
  const downloadDir = join(profile, 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const label = String(scale * 100);
  const eventFile = join(evidenceDir, `os-input-${label}.jsonl`);
  const screenshot = join(evidenceDir, `os-input-${label}-mid-drag.png`);
  const summaryFile = join(evidenceDir, `os-input-${label}.json`);
  writeFileSync(eventFile, '', 'utf8');

  let app: ElectronApplication | null = null;
  try {
    const launched = await _electron.launch({
      executablePath: electronBinary,
      args: [process.cwd()],
      timeout: 30_000,
      env: {
        ...process.env,
        AGENT_WORKSPACE_TEST: '1',
        AGENT_WORKSPACE_TENANT_URL: devinUrl,
        AGENT_WORKSPACE_TEST_GITHUB_ORIGINS: new URL(githubUrl).origin,
        AGENT_WORKSPACE_USER_DATA: profile,
        AGENT_WORKSPACE_LOG: eventFile,
        AGENT_WORKSPACE_DOWNLOAD_DIR: downloadDir,
        AGENT_WORKSPACE_ALLOW_EXTERNAL: '0',
        AGENT_WORKSPACE_SCALE: String(scale),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    app = launched;
    await expect.poll(async () => launched.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await expect
      .poll(() =>
        launched.evaluate(
          ({ webContents }, url: string) =>
            webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(url)),
          devinUrl,
        ),
      )
      .toBe(true);

    await launched.evaluate((_electron, url: string) => {
      return (globalThis as typeof globalThis & { __agentworkspace: { open(value: string): string } }).__agentworkspace.open(url);
    }, `${githubUrl}/page/os-one`);
    await launched.evaluate((_electron, url: string) => {
      return (globalThis as typeof globalThis & { __agentworkspace: { open(value: string): string } }).__agentworkspace.open(url);
    }, `${githubUrl}/page/os-two`);
    await expect.poll(async () =>
      (await getState(launched)).tabs.tabs.filter((tab) => tab.title.startsWith('GitHub fixture')).length,
    ).toBe(2);

    const id = windowId(launched);
    xdotool(['windowfocus', id]);
    xdotool(['windowmove', id, '40', '40']);
    const geometry = xdotool(['getwindowgeometry', '--shell', id], true);
    const width = Number(/WIDTH=(\d+)/.exec(geometry)?.[1] ?? 0);
    const height = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1] ?? 0);
    const devicePixelRatio = await launched.evaluate(({ webContents }, url: string) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
      return contents?.executeJavaScript('window.devicePixelRatio');
    }, devinUrl);
    const point = (x: number, y: number) => [
      '--window',
      id,
      String(Math.round(x * scale)),
      String(Math.round(y * scale)),
    ];
    const moveTo = (x: number, y: number) => xdotool(['mousemove', '--sync', ...point(x, y)]);
    const clickAt = (x: number, y: number) => {
      moveTo(x, y);
      xdotool(['click', '--clearmodifiers', '1']);
    };
    const key = (chord: string) => xdotool(['key', '--clearmodifiers', chord]);

    // F2: the pane is stored as a fraction of (1400 - rail - splitter); convert for pointer math.
    const panePx = (fraction: number) => Math.round(fraction * (1400 - 56 - 6));
    const startingWidth = panePx((await getState(launched)).paneFraction);
    const firstStartX = 1400 - startingWidth - 3;
    moveTo(firstStartX, 300);
    xdotool(['mousedown', '1']);
    await delay(250);
    moveTo(650, 300);
    await delay(350);
    importScreenshot(screenshot);
    moveTo(600, 300);
    xdotool(['mouseup', '1']);
    const firstEnd = await waitForEvent(
      eventFile,
      (event) => event.event === 'drag-end' && event.detail?.x === 600,
    );
    const widthAfterDevinRelease = panePx((await getState(launched)).paneFraction);
    expect(widthAfterDevinRelease).not.toBe(startingWidth);
    expect(panePx(firstEnd.at(-1)?.detail?.paneFraction)).not.toBe(startingWidth);

    const secondStartX = 1400 - widthAfterDevinRelease - 3;
    moveTo(secondStartX, 300);
    xdotool(['mousedown', '1']);
    await delay(200);
    moveTo(1200, 300);
    xdotool(['mouseup', '1']);
    const secondEnd = await waitForEvent(
      eventFile,
      (event) =>
        event.event === 'drag-end' && panePx(event.detail?.paneFraction) !== widthAfterDevinRelease,
    );
    const widthAfterGithubRelease = panePx((await getState(launched)).paneFraction);
    expect(widthAfterGithubRelease).not.toBe(widthAfterDevinRelease);
    expect(panePx(secondEnd.at(-1)?.detail?.paneFraction)).not.toBe(widthAfterDevinRelease);

    const escapeStartX = 1400 - widthAfterGithubRelease - 3;
    moveTo(escapeStartX, 300);
    xdotool(['mousedown', '1']);
    await delay(200);
    moveTo(700, 300);
    key('Escape');
    xdotool(['mouseup', '1']);
    await waitForEvent(
      eventFile,
      (event) => event.event === 'drag-cancel' && event.detail?.reason === 'escape',
    );
    expect(panePx((await getState(launched)).paneFraction)).toBe(widthAfterGithubRelease);

    clickAt(24, 30);
    key('ctrl+shift+g');
    await waitForEvent(eventFile, (event) => event.event === 'shortcut' && event.view === 'shell');
    expect((await getState(launched)).paneOpen).toBe(false);
    key('ctrl+shift+g');
    await expect.poll(async () => (await getState(launched)).paneOpen).toBe(true);

    clickAt(400, 200);
    key('ctrl+shift+g');
    await waitForEvent(eventFile, (event) => event.event === 'shortcut' && event.view === 'devin');
    expect((await getState(launched)).paneOpen).toBe(false);
    key('ctrl+shift+g');
    await expect.poll(async () => (await getState(launched)).paneOpen).toBe(true);

    clickAt(1200, 200);
    const activeId = (await getState(launched)).tabs.activeId;
    if (!activeId) throw new Error('No active GitHub tab');
    key('ctrl+shift+g');
    await waitForEvent(eventFile, (event) => event.event === 'shortcut' && event.view === `gh:${activeId}`);

    clickAt(24, 30);
    key('ctrl+shift+g');
    await expect.poll(async () => (await getState(launched)).paneOpen).toBe(true);
    clickAt(1200, 200);
    key('ctrl+Tab');
    key('ctrl+shift+Tab');
    key('alt+Left');
    key('alt+Right');
    key('ctrl+r');
    key('F5');
    const widthBeforeKeyboardResize = panePx((await getState(launched)).paneFraction);
    const resizeEvents = await readEvents(eventFile);
    const resizeEventCount = resizeEvents.filter(
      (event) =>
        event.event === 'shortcut' &&
        event.view.startsWith('gh:') &&
        event.detail?.control === true &&
        event.detail?.shift === true,
    ).length;
    key('ctrl+shift+bracketright');
    await waitForEvent(
      eventFile,
      (event) =>
        event.event === 'shortcut' &&
        event.view.startsWith('gh:') &&
        event.detail?.control === true &&
        event.detail?.shift === true,
      resizeEventCount + 1,
    );
    await expect
      .poll(async () => panePx((await getState(launched)).paneFraction))
      .not.toBe(widthBeforeKeyboardResize);
    key('ctrl+shift+bracketleft');
    await expect
      .poll(async () => panePx((await getState(launched)).paneFraction))
      .toBe(widthBeforeKeyboardResize);

    const currentTabs = (await getState(launched)).tabs.tabs;
    const activeAfterShortcuts = (await getState(launched)).tabs.activeId;
    if (!activeAfterShortcuts) throw new Error('No active GitHub tab after shortcut cycling');
    key('ctrl+w');
    await expect.poll(async () =>
      (await getState(launched)).tabs.tabs.length,
    ).toBe(currentTabs.length - 1);
    await waitForEvent(eventFile, (event) =>
      event.event === 'shortcut' && event.view.startsWith('gh:') && event.detail?.key.toLowerCase() === 'w',
    );

    await launched.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEvent(eventFile, (event) => event.event === 'window-close-complete');
    await launched.close();
    app = null;

    const events = await readEvents(eventFile);
    const summary = {
      scale,
      devicePixelRatio,
      window: { width, height },
      firstDrag: { releaseRegion: 'devin', x: firstEnd.at(-1)?.detail?.x, paneWidth: widthAfterDevinRelease },
      secondDrag: { releaseRegion: 'github', x: secondEnd.at(-1)?.detail?.x, paneWidth: widthAfterGithubRelease },
      escape: { restoredWidth: widthAfterGithubRelease },
      shortcutViews: [...new Set(events.filter((event) => event.event === 'shortcut').map((event) => event.view))],
      screenshot,
      eventLog: eventFile,
      status: 'passed',
    };
    writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    if (app) await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.env.DISPLAY !== ':0') {
    throw new Error(`Expected DISPLAY=:0, received ${process.env.DISPLAY ?? '(unset)'}`);
  }
  for (const command of ['xdotool', 'import']) {
    execFileSync('which', [command], { stdio: 'ignore' });
  }
  const fixtures = await startFixtureServers();
  try {
    for (const scale of scales) await runScale(scale, fixtures.devinUrl, fixtures.githubUrl);
  } finally {
    await fixtures.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
