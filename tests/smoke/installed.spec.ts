import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FuseV1Options, getCurrentFuseWire, FuseState } from '@electron/fuses';
import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { readEvents, waitForEventCount } from '../e2e/helpers';
import type { PublicState } from '../e2e/helpers';

// Installed-artifact smoke (plan §5 P3). Requires DEVIN_WORKSPACES_INSTALLED_EXE to
// point at the NSIS-installed "Devin Workspaces.exe"; scripts/smoke-install.ps1
// installs, runs this, and uninstalls.
//
// Why not `_electron.launch`? Playwright drives Electron through `--inspect=0`,
// which the shipped exe ignores because the EnableNodeCliInspectArguments fuse
// is off (by design). So the installed app is launched directly with
// `--remote-debugging-port=0` and driven over CDP through the shell page's
// contextBridge API (`window.devinworkspaces`), i.e. the same surface the UI uses.
// Main-process facts (isPackaged, webContents teardown) come from events.jsonl.
const executablePath = process.env.DEVIN_WORKSPACES_INSTALLED_EXE ?? '';
const evidenceDir = process.env.DEVIN_WORKSPACES_SMOKE_EVIDENCE ?? join(process.cwd(), 'docs', 'evidence');
const phase = process.env.DEVIN_WORKSPACES_SMOKE_PHASE ?? 'fresh'; // 'fresh' | 'upgrade'

test.skip(!executablePath, 'DEVIN_WORKSPACES_INSTALLED_EXE not set — run via scripts/smoke-install.ps1');

let fixtures: FixtureServers;
const evidence: Record<string, unknown> = {
  phase,
  executablePath,
  installerSizeBytes: process.env.DEVIN_WORKSPACES_SMOKE_INSTALLER_SIZE
    ? Number(process.env.DEVIN_WORKSPACES_SMOKE_INSTALLER_SIZE)
    : undefined,
  startedAt: new Date().toISOString(),
};

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `p3-smoke-${phase}.json`),
    JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2),
  );
});

function pathOf(url: unknown): string | undefined {
  try {
    return typeof url === 'string' ? new URL(url).pathname : undefined;
  } catch {
    return undefined;
  }
}

type Instance = { child: ChildProcess; browser: Browser; exited: Promise<number | null> };

async function launchInstalled(profile: string, logFile: string): Promise<Instance> {
  const child = spawn(executablePath, ['--remote-debugging-port=0'], {
    env: {
      ...process.env,
      DEVIN_WORKSPACES_TEST: '1',
      DEVIN_WORKSPACES_TENANT_URL: fixtures.devinUrl,
      DEVIN_WORKSPACES_TEST_GITHUB_ORIGINS: new URL(fixtures.githubUrl).origin,
      DEVIN_WORKSPACES_USER_DATA: profile,
      DEVIN_WORKSPACES_LOG: logFile,
      DEVIN_WORKSPACES_DOWNLOAD_DIR: join(profile, 'downloads'),
      DEVIN_WORKSPACES_ALLOW_EXTERNAL: '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`No "DevTools listening" line within 60 s. stderr:\n${stderr}`)),
      60_000,
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stdout?.on('data', () => undefined); // keep the pipe drained
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited early with code ${code}. stderr:\n${stderr}`));
    });
  });
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 30_000 });
  return { child, browser, exited };
}

async function pageTargets(browser: Browser): Promise<string[]> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos
      .filter((target) => target.type === 'page')
      .map((target) => target.url);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function shellPage(browser: Browser): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      found = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith('app://shell/'));
      return Boolean(found);
    })
    .toBe(true);
  return found as Page;
}

async function hooksReady(shell: Page): Promise<void> {
  await expect
    .poll(async () => shell.evaluate(() => typeof (window as any).devinworkspaces?.getState === 'function'))
    .toBe(true);
}

async function shellState(shell: Page): Promise<PublicState> {
  return shell.evaluate(() => (window as any).devinworkspaces.getState() as Promise<PublicState>);
}

// Graceful close: WM_CLOSE → BaseWindow 'close' → shutdown() → settings flushed, app.quit().
async function quit(instance: Instance, logFile: string, closes: number): Promise<void> {
  await instance.browser.close().catch(() => undefined);
  const pid = instance.child.pid;
  if (pid) spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
  await waitForEventCount(logFile, 'window-close-complete', closes);
  const code = await Promise.race([
    instance.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
  ]);
  if (code === 'timeout') {
    instance.child.kill();
    throw new Error('Installed app did not exit within 20 s after WM_CLOSE');
  }
}

test('installed exe has the expected fuse wire', async () => {
  expect(existsSync(executablePath)).toBe(true);
  const wire = await getCurrentFuseWire(executablePath);
  const fuses = {
    runAsNode: wire[FuseV1Options.RunAsNode],
    cookieEncryption: wire[FuseV1Options.EnableCookieEncryption],
    nodeOptions: wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
    nodeCliInspect: wire[FuseV1Options.EnableNodeCliInspectArguments],
    asarIntegrity: wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    onlyLoadAppFromAsar: wire[FuseV1Options.OnlyLoadAppFromAsar],
  };
  evidence.fuses = fuses;
  expect(fuses.runAsNode).toBe(FuseState.DISABLE);
  expect(fuses.cookieEncryption).toBe(FuseState.ENABLE);
  expect(fuses.nodeOptions).toBe(FuseState.DISABLE);
  expect(fuses.nodeCliInspect).toBe(FuseState.DISABLE);
  expect(fuses.asarIntegrity).toBe(FuseState.ENABLE);
  expect(fuses.onlyLoadAppFromAsar).toBe(FuseState.ENABLE);
});

test('installed resources carry the Agent SDK unpacked, without the platform binary', () => {
  const resources = join(dirname(executablePath), 'resources', 'app.asar.unpacked', 'node_modules');
  evidence.unpackedSdk = existsSync(join(resources, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'));
  evidence.unpackedPlatformPackage = existsSync(
    join(resources, '@anthropic-ai', 'claude-agent-sdk-win32-x64'),
  );
  expect(evidence.unpackedSdk).toBe(true);
  expect(evidence.unpackedPlatformPackage).toBe(false);
});

test('installed app launches, creates views, and persists across relaunch', async () => {
  const profile =
    process.env.DEVIN_WORKSPACES_SMOKE_PROFILE ?? join(tmpdir(), `devin-workspaces-smoke-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const logFile = join(profile, 'events.jsonl');
  const persistedUrl = `${fixtures.githubUrl}/page/persisted`;
  const upgrade = phase === 'upgrade';
  evidence.profile = profile;

  if (upgrade) {
    // The profile written by the 'fresh' pass must have survived re-running the installer.
    expect(existsSync(join(profile, 'settings.json'))).toBe(true);
    const before = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    // Simulate a pre-fraction profile (a build that still persisted pane.width)
    // so the upgrade launch exercises the width→fraction migration.
    before.pane = { open: before.pane?.open ?? true, width: 500 };
    writeFileSync(join(profile, 'settings.json'), JSON.stringify(before));
    evidence.settingsBeforeUpgradeLaunch = before;
    expect(before.pane?.width).toBe(500);
    // Fixture ports differ between runs; the persisted URL keeps the old port.
    // P8: the snapshot lives at settings.tabSnapshot (settings.tabs is settings).
    expect(pathOf(before.tabSnapshot?.tabs?.[0]?.url)).toBe('/page/persisted');
  }
  rmSync(logFile, { force: true });

  let instance = await launchInstalled(profile, logFile);
  let open = true;
  try {
    let shell = await shellPage(instance.browser);
    await hooksReady(shell);
    // Main-process facts come from the event log: the updater guard logs isPackaged.
    await waitForEventCount(logFile, 'updater-disabled', 1);
    const updaterEvent = (await readEvents(logFile)).find((e) => e.event === 'updater-disabled');
    evidence.updaterEvent = updaterEvent;
    expect((updaterEvent?.detail as any)?.isPackaged).toBe(true);
    evidence.pid = instance.child.pid;

    if (upgrade) {
      // Tab + pane fraction restored from the pre-upgrade profile.
      await expect.poll(async () => (await shellState(shell)).tabs.tabs.length).toBe(1);
      const restored = await shellState(shell);
      expect(restored.paneFraction).toBeCloseTo(0.374, 2);
      expect(pathOf(restored.tabs.tabs[0]?.url)).toBe('/page/persisted');
      await expect.poll(async () => (await pageTargets(instance.browser)).length).toBe(3);
      evidence.restoredAfterUpgrade = restored;
      await quit(instance, logFile, 1);
      open = false;
      return;
    }

    // Fresh install: the packaged app can load the external (unpacked) Agent
    // SDK. CDP cannot evaluate in the Electron main process, so the test-only
    // 'test:hook' bridge dispatches into the main-side __devinworkspaces hooks.
    const probe = (await shell.evaluate(() =>
      (window as any).devinworkspaces.testHook('claudeSdkProbe'),
    )) as { ok: boolean; ms: number; hasListSessions: boolean };
    evidence.claudeSdkProbe = probe;
    expect(probe.ok).toBe(true);
    expect(probe.hasListSessions).toBe(true);
    await expect.poll(async () =>
      (await readEvents(logFile)).some((e) => e.event === 'claude-sdk-load' && (e.detail as any)?.ok === true),
    ).toBe(true);

    // Fresh install: shell + devin views only.
    await expect.poll(async () => (await pageTargets(instance.browser)).length).toBe(2);
    const urls = await pageTargets(instance.browser);
    evidence.initialViews = urls;
    expect(urls.some((url) => url.startsWith('app://shell/'))).toBe(true);
    expect(urls.some((url) => url.startsWith(fixtures.devinUrl))).toBe(true);

    // 0.374 ≈ 500 px of the 1338 px available at the 1400 px default window.
    await shell.evaluate(() => (window as any).devinworkspaces.setSettings({ pane: { fraction: 0.374 } }));
    await expect.poll(async () => (await shellState(shell)).paneFraction).toBeCloseTo(0.374, 2);
    await shell.evaluate((url: string) => (window as any).devinworkspaces.openLink(url), persistedUrl);
    await expect
      .poll(async () => (await shellState(shell)).tabs.tabs.some((tab) => tab.title.includes('persisted')))
      .toBe(true);
    const opened = await shellState(shell);
    const tabId = opened.tabs.tabs[0]?.id;
    expect(tabId).toBeTruthy();
    await expect.poll(async () => (await pageTargets(instance.browser)).length).toBe(3);
    evidence.afterOpen = { state: opened, views: await pageTargets(instance.browser) };

    await quit(instance, logFile, 1);
    open = false;
    expect(existsSync(join(profile, 'settings.json'))).toBe(true);
    const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    evidence.settingsAfterFirstRun = settings;
    expect(settings.pane?.fraction).toBeCloseTo(0.374, 2);
    expect(settings.pane?.width).toBeUndefined();
    expect(settings.tabSnapshot?.tabs?.[0]?.url).toBe(persistedUrl);
    // Separate partitions exist on disk.
    expect(existsSync(join(profile, 'Partitions', 'devin'))).toBe(true);
    expect(existsSync(join(profile, 'Partitions', 'github'))).toBe(true);

    instance = await launchInstalled(profile, logFile);
    open = true;
    shell = await shellPage(instance.browser);
    await hooksReady(shell);
    await expect.poll(async () => (await shellState(shell)).tabs.tabs.length).toBe(1);
    const restored = await shellState(shell);
    expect(restored.paneFraction).toBeCloseTo(0.374, 2);
    expect(restored.tabs.activeId).toBe(tabId);
    expect(restored.tabs.tabs[0]?.url).toBe(persistedUrl);
    await expect.poll(async () => (await pageTargets(instance.browser)).length).toBe(3);
    evidence.restoredAfterRelaunch = restored;

    await quit(instance, logFile, 2);
    open = false;
    const events = await readEvents(logFile);
    const closes = events.filter((entry) => entry.event === 'window-close-complete');
    expect(closes.length).toBe(2);
    expect(closes.every((entry) => (entry.detail as any)?.webContentsCountAfter === 0)).toBe(true);
    evidence.eventCount = events.length;
    evidence.closeEvents = closes;
  } finally {
    if (open) {
      await instance.browser.close().catch(() => undefined);
      instance.child.kill();
    }
    if (!process.env.DEVIN_WORKSPACES_SMOKE_PROFILE) rmSync(profile, { recursive: true, force: true });
  }
});
