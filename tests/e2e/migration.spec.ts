import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  CLAUDE_FIXTURE_HOME,
  closeApp,
  launchApp,
  launchWithClaudeFixture,
  readEvents,
  state,
} from './helpers';
import { buildHooksBlock } from '../../src/core/claudeHooks';

// Devin Workspaces → Agent Workspace profile migration: a staged legacy
// profile is moved onto the (not-yet-existing) new userData dir via
// AGENT_WORKSPACE_TEST_MIGRATE_FROM, partitions are renamed, and the global
// ~/.claude hook block is rewritten from the legacy to the new URL prefix.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const LEGACY_PREFIX = '/devin-workspaces/hook/';

function stageLegacyProfile(root: string): { legacy: string; userData: string } {
  const legacy = join(root, 'devin-workspaces');
  const userData = join(root, 'agent-workspace'); // must NOT exist
  mkdirSync(join(legacy, 'Partitions', 'devin'), { recursive: true });
  writeFileSync(join(legacy, 'Partitions', 'devin', 'marker.txt'), 'keep');
  writeFileSync(join(legacy, 'notifications.json'), '[]');
  writeFileSync(
    join(legacy, 'settings.json'),
    JSON.stringify({ pane: { fraction: 0.42 }, claude: { hooksEnabled: true } }),
  );
  return { legacy, userData };
}

function stageClaudeHome(claudeHome: string): void {
  cpSync(CLAUDE_FIXTURE_HOME, claudeHome, { recursive: true });
  const legacyBlock = buildHooksBlock({ port: 1234, auth: { kind: 'token', token: 'old' } }) as {
    hooks: Record<string, { hooks: { url: string }[] }[]>;
  };
  const legacyStopGroups = legacyBlock.hooks.Stop!.map((group) => ({
    ...group,
    hooks: group.hooks.map((h) => ({
      ...h,
      url: h.url.replace('/agent-workspace/hook/', LEGACY_PREFIX),
    })),
  }));
  writeFileSync(
    join(claudeHome, 'settings.json'),
    JSON.stringify(
      {
        keepMe: 'untouched',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }, ...legacyStopGroups],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(claudeHome, 'settings.json.devin-workspaces.bak'), '{"orig":true}');
}

test('migrates a legacy devin-workspaces profile, partitions and claude hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-migration-'));
  const { legacy, userData } = stageLegacyProfile(root);
  const claudeHome = join(root, 'claude-home');
  stageClaudeHome(claudeHome);

  const logFile = join(root, 'events.jsonl');
  const app = await launchApp(userData, logFile, join(root, 'downloads'), fixtures, {
    CLAUDE_CONFIG_DIR: claudeHome,
    AGENT_WORKSPACE_TEST_MIGRATE_FROM: legacy,
  });
  try {
    // (1) the staged settings value is live in the app
    await expect.poll(async () => (await state(app)).paneFraction).toBe(0.42);

    // (2)+(3) the profile moved wholesale, partition renamed, legacy dir gone
    expect(existsSync(join(userData, 'Partitions', 'cloud', 'marker.txt'))).toBe(true);
    expect(existsSync(join(userData, 'Partitions', 'devin'))).toBe(false);
    expect(existsSync(legacy)).toBe(false);

    // (4) one profile-migrated event
    await expect
      .poll(async () => (await readEvents(logFile)).some((e) => e.event === 'profile-migrated'))
      .toBe(true);
    const migrated = (await readEvents(logFile)).find((e) => e.event === 'profile-migrated');
    expect(migrated?.detail).toMatchObject({ method: 'rename', partition: true });

    // (5) the global hook block is rewritten to the new prefix; foreign hook
    // and unrelated key survive
    const claudeSettings = join(claudeHome, 'settings.json');
    await expect
      .poll(async () => readFileSync(claudeSettings, 'utf8').includes('/agent-workspace/hook/'))
      .toBe(true);
    const merged = readFileSync(claudeSettings, 'utf8');
    expect(merged).not.toContain(LEGACY_PREFIX);
    expect(merged).toContain('echo foreign');
    expect(merged).toContain('keepMe');

    // (6) the one-time backup moved to the new name
    expect(existsSync(`${claudeSettings}.agent-workspace.bak`)).toBe(true);
    expect(existsSync(`${claudeSettings}.devin-workspaces.bak`)).toBe(false);
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some((e) => e.event === 'claude-hooks-backup-migrated'),
      )
      .toBe(true);
    // Claude log details never carry a configDir path.
    const backupMigrated = (await readEvents(logFile)).find(
      (e) => e.event === 'claude-hooks-backup-migrated',
    );
    expect(JSON.stringify(backupMigrated?.detail ?? {})).not.toContain('settings.json');
  } finally {
    await closeApp(app);
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not migrate when the destination exists or the legacy dir is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-migration-skip-'));
  const { legacy, userData } = stageLegacyProfile(root);
  const logFile = join(root, 'events.jsonl');

  // First launch migrates.
  let app = await launchApp(userData, logFile, join(root, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_MIGRATE_FROM: legacy,
  });
  try {
    await expect.poll(async () => (await state(app)).paneFraction).toBe(0.42);
  } finally {
    await closeApp(app);
  }
  expect(
    (await readEvents(logFile)).filter((e) => e.event === 'profile-migrated'),
  ).toHaveLength(1);

  // Relaunch: destination now exists and MIGRATE_FROM points at a missing dir
  // — no second migration event, settings intact.
  app = await launchApp(userData, logFile, join(root, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_MIGRATE_FROM: join(root, 'does-not-exist'),
  });
  try {
    await expect.poll(async () => (await state(app)).paneFraction).toBe(0.42);
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    expect(
      (await readEvents(logFile)).filter((e) => e.event === 'profile-migrated'),
    ).toHaveLength(1);
  } finally {
    await closeApp(app);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the hook server accepts the legacy /devin-workspaces/hook/ path', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
  });
  try {
    const evaluate = (fn: () => unknown) => app.evaluate(fn);
    await expect
      .poll(async () =>
        evaluate(() => (globalThis as any).__agentworkspace.claudeHookInfo()),
      )
      .not.toBeNull();

    const post = (path: string) =>
      app.evaluate(
        (_e, a: { path: string }) =>
          (globalThis as any).__agentworkspace.claudePostHookPath(a.path, {
            session_id: 'legacy-uuid',
            cwd: 'C:\\work\\alpha',
          }),
        { path },
      ) as Promise<{ ok: boolean; status?: number }>;

    const legacy = await post('/devin-workspaces/hook/Stop');
    expect(legacy).toMatchObject({ ok: true, status: 200 });
    const current = await post('/agent-workspace/hook/Stop');
    expect(current).toMatchObject({ ok: true, status: 200 });
    const health = await app.evaluate(
      (_e) =>
        new Promise((resolve) => {
          const info = (globalThis as any).__agentworkspace.claudeHookInfo();
          fetch(`http://127.0.0.1:${info.port}/devin-workspaces/hook/health`)
            .then((r) => resolve(r.status))
            .catch(() => resolve(0));
        }),
    );
    expect(health).toBe(200);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});
