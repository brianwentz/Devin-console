import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  CLAUDE_FIXTURE_HOME,
  closeApp,
  dndMove,
  evaluateInShell,
  launchApp,
  launchWithClaudeFixture,
  readEvents,
  shellPage,
  setInputValue,
  waitForEvent,
} from './helpers';
import type { ClaudeState } from '../../src/shared/ipc';

// §5.4: the Claude sidebar end-to-end — same fixture tree as
// claudeRegistry.spec.ts, exercises the shell (sidebar DOM, menus, view,
// settings fields).

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const UA = '11111111-0000-4000-8000-00000000000a';
const UB = '11111111-0000-4000-8000-00000000000b';
const UC = '11111111-0000-4000-8000-00000000000c';

type MenuItem = {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
};

function findMenuItem(items: MenuItem[], label: string): MenuItem | undefined {
  for (const item of items) {
    if (item.label === label) return item;
    const nested = item.submenu && findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return undefined;
}

// Right-click a workspace section header (data-section-name = the stored path).
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

const sectionExists = (app: ElectronApplication, path: string) =>
  evaluateInShell(
    app,
    `[...document.querySelectorAll('[data-section-name]')].some((e) => e.getAttribute('data-section-name') === ${JSON.stringify(path)})`,
  );
const sectionLabel = (app: ElectronApplication, path: string) =>
  evaluateInShell(
    app,
    `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(path)})?.querySelector('[data-section-label]')?.textContent ?? ''`,
  );
const sectionHasRow = (app: ElectronApplication, sectionName: string, sessionId: string) =>
  evaluateInShell(
    app,
    `(() => {
      const sec = [...document.querySelectorAll('[data-section-name]')]
        .find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(sectionName)})?.closest('div.mb-px');
      return sec ? !!sec.querySelector('[data-session-id="${sessionId}"]') : false;
    })()`,
  );
// CSS selector for a workspace section: backslashes are escaped for the
// attr value so a Windows path still matches data-section-name.
const sectionSel = (path: string) =>
  `[data-section-name="${path.replace(/\\/g, '\\\\')}"]`;
const hostChipOf = (app: ElectronApplication, path: string) =>
  evaluateInShell(
    app,
    `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify(path)})?.querySelector('[data-host-chip]')?.textContent ?? null`,
  );

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    claudeState: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeState()) as Promise<ClaudeState>,
    claudeMenuItems: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeMenuItems()) as Promise<
        MenuItem[]
      >,
    claudeMenuClick: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.claudeMenuClick(v),
        id,
      ) as Promise<{ action: string | null }>,
    currentScope: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.currentScope()) as Promise<string>,
    setSurface: (surface: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.setSurface(v as never),
        surface,
      ),
    getSessionsBounds: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.getSessionsBounds()) as Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>,
    state: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.state()) as Promise<{
        surface: string;
        claudeSessionId: string | null;
      }>,
  };
}

test('claude sidebar: rows, filter, menus, view, surface round-trip', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);

    // --- panel ----------------------------------------------------------
    await expect(shell.locator('[data-sidebar="claude"]')).toBeVisible();
    expect(await h.getSessionsBounds()).not.toBeNull();
    await expect(shell.locator('#claudeStatus')).toHaveText(/ready · 3 sessions/);

    // --- rows ------------------------------------------------------------
    const row = (id: string) => shell.locator(`[data-session-id="${id}"]`);
    await expect(row(UA)).toHaveText(/Alpha custom/);
    await expect(row(UA)).toHaveAttribute('data-cwd', 'C:\\work\\alpha');
    await expect(row(UC)).toHaveAttribute('data-cwd', 'C:\\work\\beta');

    // --- filter narrows by cwd basename ----------------------------------
    await setInputValue(app, 'sessionSearch', 'alpha');
    await expect(shell.locator('[data-session-id]')).toHaveCount(2);
    await setInputValue(app, 'sessionSearch', '');
    await expect(shell.locator('[data-session-id]')).toHaveCount(3);

    // --- pin via the real right-click menu path --------------------------
    await row(UB).click({ button: 'right' });
    const pinMenu = await h.claudeMenuItems();
    const pin = findMenuItem(pinMenu, 'Pin');
    expect(pin).toBeTruthy();
    await h.claudeMenuClick(pin!.id);
    await expect(shell.locator('[data-section-name="pinned"]')).toBeVisible();
    await expect(row(UB)).toHaveAttribute('data-pinned', 'true');

    // --- workspace add → sessions file under it automatically (D8) --------
    await shell.locator('#workspaceAdd').click();
    await expect
      .poll(async () => (await h.claudeState()).folders)
      .toContain('C:\\work\\alpha');
    await expect.poll(async () => sectionExists(app, 'C:\\work\\alpha')).toBe(true);
    // alpha-cwd sessions file under the workspace (UB is pinned → the
    // 'pinned' section takes precedence); the beta session stays Recent.
    await expect.poll(async () => sectionHasRow(app, 'pinned', UB)).toBe(true);
    await expect.poll(async () => sectionHasRow(app, 'C:\\work\\alpha', UA)).toBe(true);
    await expect.poll(async () => sectionHasRow(app, 'recent', UC)).toBe(true);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UA)?.folder)
      .toBe('C:\\work\\alpha');

    // --- rename-session → inline editor → watcher refresh ------------------
    await row(UB).click({ button: 'right' });
    const renameMenu = await h.claudeMenuItems();
    await h.claudeMenuClick(findMenuItem(renameMenu, 'Rename…')!.id);
    await shell.locator('#sessionRenameEdit').fill('Renamed alpha two');
    await shell.keyboard.press('Enter');
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UB)?.title, {
        timeout: 4_000,
      })
      .toBe('Renamed alpha two');
    await expect(row(UB)).toHaveText(/Renamed alpha two/);

    // --- archive + show archived -------------------------------------------
    await row(UC).click({ button: 'right' });
    const archiveMenu = await h.claudeMenuItems();
    await h.claudeMenuClick(findMenuItem(archiveMenu, 'Archive')!.id);
    await expect.poll(async () => (await row(UC).count())).toBe(0);
    await shell.locator('#sessionsMenu').click();
    const headerMenu = await h.claudeMenuItems();
    const showArchived = findMenuItem(headerMenu, 'Show archived sessions');
    expect(showArchived).toBeTruthy();
    await h.claudeMenuClick(showArchived!.id);
    await expect(row(UC)).toBeVisible();
    await expect(row(UC)).toHaveAttribute('data-archived', 'true');

    // --- selection drives ClaudeView + scope -------------------------------
    await row(UA).click();
    await expect(shell.locator('[data-claude-view]')).toContainText('Alpha custom');
    await expect(shell.locator('[data-claude-view]')).toContainText('C:\\work\\alpha');
    await expect.poll(async () => h.currentScope()).toBe(`claude:${UA}`);
    expect((await h.state()).claudeSessionId).toBe(UA);

    // --- back to cloud: scope reverts, column stays open -------------------
    await h.setSurface('cloud');
    await expect.poll(async () => h.currentScope()).toBe('');
    expect(await h.getSessionsBounds()).not.toBeNull();
    await expect(shell.locator('[data-sidebar="cloud"]')).toBeVisible();

    // --- Settings fields round-trip into settings.json ----------------------
    await h.setSurface('settings');
    await setInputValue(app, 'claudePathInput', 'C:\\tools\\claude.exe');
    await setInputValue(app, 'claudeAutoArchiveInput', '30');
    // Leaving via the rail commits the dirty draft (requestSurface).
    await shell.locator('#cloudButton').click();
    await expect
      .poll(async () => {
        const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return settings.claude;
      })
      .toMatchObject({ path: 'C:\\tools\\claude.exe', autoArchiveDays: 30 });
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('rail button switches to the claude surface and persists it', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const shell = await shellPage(app);
    await shell.locator('#claudeButton').click();
    await expect.poll(async () => (await h.state()).surface).toBe('claude');
    await expect(shell.locator('#claudeButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(shell.locator('[data-claude-view]')).toBeVisible();
    await closeApp(app);

    // Surface persists across relaunch on the same profile.
    const app2 = await launchApp(
      profile,
      join(profile, 'events2.jsonl'),
      join(profile, 'downloads'),
      fixtures,
      { CLAUDE_CONFIG_DIR: claudeHome },
    );
    const h2 = hooks(app2);
    try {
      await expect.poll(async () => (await h2.state()).surface).toBe('claude');
      const shell2 = await shellPage(app2);
      await expect(shell2.locator('#claudeButton')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await app2.close().catch(() => undefined);
    }
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('claude workspaces: new-session-here, reorder, collapse, rename, remove', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
    // The fake SDK drives newSession → a real transcript row files itself.
    DEVIN_WORKSPACES_TEST_CLAUDE_SDK: join(process.cwd(), 'out/fixtures/fakeClaudeSdk.mjs'),
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    const shell = await shellPage(app);
    await expect(shell.locator('[data-sidebar="claude"]')).toBeVisible();

    // Two workspaces: alpha via the env picker seam, beta via the IPC arg.
    await shell.locator('#workspaceAdd').click();
    await expect
      .poll(async () => (await h.claudeState()).folders)
      .toContain('C:\\work\\alpha');
    await shell.evaluate(() =>
      (window as any).devinworkspaces.claudeWorkspaceAdd('C:\\work\\beta'),
    );
    await expect
      .poll(async () => (await h.claudeState()).folders)
      .toEqual(['C:\\work\\alpha', 'C:\\work\\beta']);

    // --- "New session here" on a workspace header opens a session in that
    // cwd without the picker (no transcript row until the first prompt, so
    // assert via the selection + the view's cwd display).
    await rightClickWorkspace(app, 'C:\\work\\alpha');
    const wsMenu = await h.claudeMenuItems();
    await h.claudeMenuClick(findMenuItem(wsMenu, 'New session here')!.id);
    await expect.poll(async () => (await h.state()).claudeSessionId).not.toBeNull();
    const createdId = (await h.state()).claudeSessionId;
    expect(createdId).not.toBe(UA);
    await expect.poll(async () => h.currentScope()).toBe(`claude:${createdId}`);
    await expect(shell.locator('[data-claude-view]')).toContainText('C:\\work\\alpha');

    // --- rename → label + settings.claude.workspaceLabels.
    await rightClickWorkspace(app, 'C:\\work\\alpha');
    const renameMenu = await h.claudeMenuItems();
    await h.claudeMenuClick(findMenuItem(renameMenu, 'Rename…')!.id);
    await shell.locator('#sessionFolderEdit').fill('Alpha ws');
    await shell.keyboard.press('Enter');
    await expect.poll(async () => sectionLabel(app, 'C:\\work\\alpha')).toBe('Alpha ws');
    await expect
      .poll(async () => {
        const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return settings.claude.workspaceLabels['C:\\work\\alpha'];
      })
      .toBe('Alpha ws');

    // --- DnD reorder → settings.claude.workspaces order flips.
    await dndMove(shell, sectionSel('C:\\work\\beta'), sectionSel('C:\\work\\alpha'));
    await expect
      .poll(async () => {
        const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return settings.claude.workspaces;
      })
      .toEqual(['C:\\work\\beta', 'C:\\work\\alpha']);

    // --- collapse persists in claude.collapsedFolders.
    await evaluateInShell(
      app,
      `[...document.querySelectorAll('[data-section-name]')].find((e) => e.getAttribute('data-section-name') === ${JSON.stringify('C:\\work\\beta')})?.click() ?? true`,
    );
    await expect
      .poll(async () => {
        const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return settings.claude.collapsedFolders;
      })
      .toContain('C:\\work\\beta');

    // --- Remove workspace via context menu → sessions fall back to Recent.
    await rightClickWorkspace(app, 'C:\\work\\beta');
    const removeMenu = await h.claudeMenuItems();
    await h.claudeMenuClick(findMenuItem(removeMenu, 'Remove workspace')!.id);
    await expect
      .poll(async () => {
        const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
        return settings.claude.workspaces;
      })
      .toEqual(['C:\\work\\alpha']);
    await expect.poll(async () => sectionExists(app, 'C:\\work\\beta')).toBe(false);
    await expect.poll(async () => sectionHasRow(app, 'recent', UC)).toBe(true);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('claude workspace migration: legacy registry folders → claude.workspaces', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-mig-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const logFile = join(profile, 'events.jsonl');
  // Legacy registry: 'Alpha folder' has two sessions (same cwd), 'Orphan' none.
  const legacyEntry = (folder: string) => ({
    id: UA,
    host: 'local',
    folder,
    pinned: false,
    archived: false,
    archivedAt: null,
    unarchivedAt: null,
    removed: false,
    removedAt: null,
    lastOpenedAt: null,
    prs: [],
  });
  writeFileSync(
    join(profile, 'claude-sessions.json'),
    JSON.stringify({
      version: 1,
      folders: ['Alpha folder', 'Orphan'],
      entries: {
        [UA]: legacyEntry('Alpha folder'),
        [UB]: { ...legacyEntry('Alpha folder'), id: UB },
      },
    }),
  );
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect
      .poll(async () => (await h.claudeState()).folders)
      .toEqual(['C:\\work\\alpha']);
    const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    expect(settings.claude.workspaces).toEqual(['C:\\work\\alpha']);
    expect(settings.claude.workspaceLabels['C:\\work\\alpha']).toBe('Alpha folder');
    // Alpha sessions file under the migrated workspace; UC (no folder) stays Recent.
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UA)?.folder)
      .toBe('C:\\work\\alpha');
    await waitForEvent(logFile, 'claude-folders-migrated');
    const mig = (await readEvents(logFile)).find((e) => e.event === 'claude-folders-migrated');
    expect((mig as any)?.detail).toMatchObject({ converted: 1, dropped: 1 });
    // Legacy fields are stripped from the persisted registry.
    await expect
      .poll(async () => {
        const reg = JSON.parse(readFileSync(join(profile, 'claude-sessions.json'), 'utf8'));
        return 'folders' in reg ? 'legacy' : 'stripped';
      })
      .toBe('stripped');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('claude WSL workspace: UNC workspace files a wsl session by linux cwd + host chip', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'devin-workspaces-e2e-wsl-'));
  const claudeHome = join(profile, 'claude-home');
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const uncRoot = mkdtempSync(join(tmpdir(), 'devin-workspaces-unc-'));
  // The fake distro's claude home: <root>\home\u\.claude
  const wslHome = join(uncRoot, 'home', 'u');
  mkdirSync(join(wslHome, '.claude', 'projects', '-home-u-ws'), { recursive: true });
  const WSL_ID = '22222222-0000-4000-8000-0000000000d1';
  writeFileSync(
    join(wslHome, '.claude', 'projects', '-home-u-ws', `${WSL_ID}.jsonl`),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/home/u/ws',
      sessionId: WSL_ID,
      version: '2.1.296',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: 'wsl session' },
      uuid: `${WSL_ID}-u1`,
      timestamp: '2026-10-10T10:00:00.000Z',
    }) + '\n',
  );
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    DEVIN_WORKSPACES_TEST_SESSIONS_OPEN: '1',
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT: uncRoot,
  });
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await expect
      .poll(
        async () =>
          (await h.claudeState()).sessions.some((s) => s.id === WSL_ID && s.host === 'wsl:Fake'),
      )
      .toBe(true);
    // Add the UNC workspace (uncRoot stands in for \\wsl.localhost\Fake).
    const shell = await shellPage(app);
    const wsPath = `${uncRoot}\\home\\u\\ws`;
    await shell.evaluate((_p) => (window as any).devinworkspaces.claudeWorkspaceAdd(_p), wsPath);
    await h.setSurface('claude');
    await expect
      .poll(async () => (await h.claudeState()).folders)
      .toContain(wsPath);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === WSL_ID)?.folder)
      .toBe(wsPath);
    await expect.poll(async () => sectionExists(app, wsPath)).toBe(true);
    await expect.poll(async () => hostChipOf(app, wsPath)).toBe('Fake');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(uncRoot, { recursive: true, force: true });
  }
});
