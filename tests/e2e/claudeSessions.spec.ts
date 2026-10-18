import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, launchApp, launchWithClaudeFixture, shellPage, setInputValue } from './helpers';
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

    // --- folder create + move ---------------------------------------------
    await shell.locator('#sessionFolderNew').click();
    await shell.locator('#sessionFolderEdit').fill('Work');
    await shell.keyboard.press('Enter');
    await expect(shell.locator('[data-section-name="Work"]')).toBeVisible();
    await row(UA).click({ button: 'right' });
    const moveMenu = await h.claudeMenuItems();
    await h.claudeMenuClick(findMenuItem(moveMenu, 'Work')!.id);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UA)?.folder)
      .toBe('Work');

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
