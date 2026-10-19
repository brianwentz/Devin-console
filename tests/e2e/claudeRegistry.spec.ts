import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { closeApp, CLAUDE_FIXTURE_HOME, launchApp, launchWithClaudeFixture, shellPage } from './helpers';
import type { ClaudeState } from '../../src/shared/ipc';

// §4.5: hook-driven claude sidebar e2e (the shell UI lands in PR 4). The app
// runs against a COPY of tests/fixtures/claude-home — never the committed
// tree, because the SDK writes into CLAUDE_CONFIG_DIR.

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

const FIXTURE_HOME = CLAUDE_FIXTURE_HOME;

type MenuItem = {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
};

function hooks(app: ElectronApplication) {
  const evaluate = (fn: () => unknown) => app.evaluate(fn);
  return {
    claudeState: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeState()) as Promise<ClaudeState>,
    claudeRefresh: () => evaluate(() => (globalThis as any).__devinworkspaces.claudeRefresh()),
    claudeSelect: (id: string | null) =>
      app.evaluate(
        (_e, v: string | null) => (globalThis as any).__devinworkspaces.claudeSelect(v),
        id,
      ),
    claudeMenuItems: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeMenuItems()) as Promise<
        MenuItem[]
      >,
    claudeMenuClick: (id: string) =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.claudeMenuClick(v),
        id,
      ) as Promise<{ action: string | null }>,
    claudeMutations: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeMutations()) as Promise<
        { op: string; payload: Record<string, unknown> }[]
      >,
    claudeConfigDir: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.claudeConfigDir()) as Promise<string>,
    currentScope: () =>
      evaluate(() => (globalThis as any).__devinworkspaces.currentScope()) as Promise<string>,
    setSurface: (surface: 'cloud' | 'local' | 'claude' | 'settings' | 'analytics') =>
      app.evaluate(
        (_e, v: string) => (globalThis as any).__devinworkspaces.setSurface(v as never),
        surface,
      ),
    setSettings: async (patch: unknown) => {
      const shell = await shellPage(app);
      await shell.evaluate((v: unknown) => (window as any).devinworkspaces.setSettings(v), patch);
    },
  };
}

function findMenuItem(items: MenuItem[], label: string): MenuItem | undefined {
  for (const item of items) {
    if (item.label === label) return item;
    const nested = item.submenu && findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return undefined;
}

// Right-click path without the PR-4 sidebar: ask the shell bridge for the
// same contextMenu() items a row right-click would produce.
async function openClaudeMenu(
  app: ElectronApplication,
  arg: { kind: 'session' | 'workspace' | 'header'; sessionId?: string; path?: string },
): Promise<MenuItem[]> {
  const shell = await shellPage(app);
  // The invoke stays open until a claudeMenuClick resolves it — don't await.
  void shell.evaluate(
    (a) =>
      (window as any).devinworkspaces.claudeContextMenu({ ...a, x: 10, y: 10 }),
    arg,
  );
  const h = hooks(app);
  await expect.poll(async () => (await h.claudeMenuItems()).length).toBeGreaterThan(0);
  return h.claudeMenuItems();
}


test('claudeState reaches ready with the fixture sessions and title precedence', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const state = await h.claudeState();
    expect(state.sessions).toHaveLength(3);
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    // custom-title > ai-title (summary) > firstPrompt.
    expect(byId.get(UA)?.title).toBe('Alpha custom');
    expect(byId.get(UB)?.title).toBe('Alpha summary title');
    expect(byId.get(UC)?.title).toBe('Beta first prompt');
    expect(byId.get(UA)?.cwd).toBe('C:\\work\\alpha');
    expect(byId.get(UC)?.gitBranch).toBe('feature');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a new transcript file in the config dir is listed within a second', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const added = '11111111-0000-4000-8000-00000000000d';
    cpSync(
      join(FIXTURE_HOME, 'projects', 'C--work-beta', `${UC}.jsonl`),
      join(claudeHome, 'projects', 'C--work-beta', `${added}.jsonl`),
    );
    await expect
      .poll(async () => (await h.claudeState()).sessions.length, { timeout: 1_000, intervals: [100] })
      .toBe(4);
    const added_row = (await h.claudeState()).sessions.find((s) => s.id === added);
    expect(added_row?.cwd).toBe('C:\\work\\beta');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('pin + workspace persist across a relaunch (ux2 D8)', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    // Add the workspace covering the alpha cwd via the same IPC the sidebar uses.
    const shell = await shellPage(app);
    await shell.evaluate(() =>
      (window as any).devinworkspaces.claudeWorkspaceAdd('C:\\work\\alpha'),
    );
    await expect
      .poll(async () => (await h.claudeState()).folders)
      .toContain('C:\\work\\alpha');

    const menu = await openClaudeMenu(app, { kind: 'session', sessionId: UA });
    const pin = findMenuItem(menu, 'Pin');
    expect(pin).toBeTruthy();
    await h.claudeMenuClick(pin!.id);

    await expect
      .poll(async () =>
        JSON.stringify(
          (await h.claudeState()).sessions.find((s) => s.id === UA),
        ),
      )
      .toContain('"isPinned":true');
    const row = (await h.claudeState()).sessions.find((s) => s.id === UA);
    expect(row?.isPinned).toBe(true);
    // The workspace folder is derived from cwd — never stored in the registry.
    expect(row?.folder).toBe('C:\\work\\alpha');
    // Registry saves are debounced ~200 ms — poll until the file lands.
    await expect
      .poll(async () => {
        try {
          const stored = JSON.parse(
            readFileSync(join(profile, 'claude-sessions.json'), 'utf8'),
          );
          return stored.entries[UA];
        } catch {
          return undefined;
        }
      })
      .toMatchObject({ pinned: true });
    const stored = JSON.parse(
      readFileSync(join(profile, 'claude-sessions.json'), 'utf8'),
    );
    expect('folders' in stored).toBe(false);
    expect('folder' in (stored.entries[UA] ?? {})).toBe(false);
  } finally {
    await closeApp(app);
  }

  // Relaunch against the same profile + fixture copy — pin + filing survive.
  const app2 = await launchApp(
    profile,
    join(profile, 'events2.jsonl'),
    join(profile, 'downloads'),
    fixtures,
    { CLAUDE_CONFIG_DIR: claudeHome },
  );
  const h2 = hooks(app2);
  try {
    await expect.poll(async () => (await h2.claudeState()).status).toBe('ready');
    const row = (await h2.claudeState()).sessions.find((s) => s.id === UA);
    expect(row?.isPinned).toBe(true);
    expect(row?.folder).toBe('C:\\work\\alpha');
    expect((await h2.claudeState()).folders).toContain('C:\\work\\alpha');
  } finally {
    await app2.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('remove from list hides the row; a newer transcript mtime brings it back', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const menu = await openClaudeMenu(app, { kind: 'session', sessionId: UC });
    const remove = findMenuItem(menu, 'Remove from list');
    expect(remove).toBeTruthy();
    await h.claudeMenuClick(remove!.id);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UC))
      .toBeUndefined();

    // Someone resumes it elsewhere: appended content + a strictly newer mtime
    // flips the entry back via the un-remove rule.
    const file = join(claudeHome, 'projects', 'C--work-beta', `${UC}.jsonl`);
    appendFileSync(
      file,
      JSON.stringify({ type: 'custom-title', customTitle: 'Resumed beta', sessionId: UC }) + '\n',
    );
    const future = new Date(Date.now() + 2_000);
    utimesSync(file, future, future);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UC)?.title, {
        timeout: 3_000,
      })
      .toBe('Resumed beta');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('delete transcript removes the file and drops the row (test-mode auto-confirm)', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    const menu = await openClaudeMenu(app, { kind: 'session', sessionId: UB });
    const del = findMenuItem(menu, 'Delete transcript…');
    expect(del).toBeTruthy();
    await h.claudeMenuClick(del!.id);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UB))
      .toBeUndefined();
    expect(existsSync(join(claudeHome, 'projects', 'C--work-alpha', `${UB}.jsonl`))).toBe(false);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('autoArchiveDays archives an idle session; showArchived reveals it', async () => {
  const { app, profile, claudeHome } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    // Age the beta fixture past the auto-archive threshold.
    const file = join(claudeHome, 'projects', 'C--work-beta', `${UC}.jsonl`);
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(file, old, old);

    await h.setSettings({ claude: { autoArchiveDays: 30 } });
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    // The archived row is filtered out of the snapshot while showArchived is
    // off; the registry file records the flag.
    await expect
      .poll(async () => {
        try {
          return JSON.parse(readFileSync(join(profile, 'claude-sessions.json'), 'utf8'))
            .entries[UC]?.archived;
        } catch {
          return undefined;
        }
      })
      .toBe(true);
    expect((await h.claudeState()).sessions).toHaveLength(2);
    // …revealed by the header-menu checkbox.
    const menu = await openClaudeMenu(app, { kind: 'header' });
    const show = findMenuItem(menu, 'Show archived sessions');
    expect(show).toBeTruthy();
    await h.claudeMenuClick(show!.id);
    await expect
      .poll(async () => (await h.claudeState()).sessions.find((s) => s.id === UC)?.isArchived)
      .toBe(true);
    expect((await h.claudeState()).showArchived).toBe(true);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('selecting a session drives currentScope to claude:<id>', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures);
  const h = hooks(app);
  try {
    await expect.poll(async () => (await h.claudeState()).status).toBe('ready');
    await h.setSurface('claude');
    await h.claudeSelect(UA);
    await expect.poll(async () => h.currentScope()).toBe(`claude:${UA}`);
    // Back on cloud the scope reverts to the cloud selection/global.
    await h.setSurface('cloud');
    await expect.poll(async () => h.currentScope()).toBe('');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
