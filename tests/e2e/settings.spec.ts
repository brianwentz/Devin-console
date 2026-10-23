import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  launchApp,
  readEvents,
  setInputValue,
  state,
  waitForEvent,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launch(
  profile: string,
  logFile: string,
  extraEnv: Record<string, string> = {},
) {
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, extraEnv);
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return app;
}

async function quit(app: ElectronApplication, profile: string): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const shell = (app: ElectronApplication, expr: string) => evaluateInShell(app, expr);
const clickTab = (app: ElectronApplication, id: string) =>
  shell(app, `document.querySelector('[data-settings-tab="${id}"]').click()`);
const selectedTab = (app: ElectronApplication) =>
  shell(
    app,
    `document.querySelector('#settingsTabs [role="tab"][aria-selected="true"]')?.dataset.settingsTab`,
  );
const hasEl = (app: ElectronApplication, id: string) =>
  shell(app, `Boolean(document.getElementById('${id}'))`);

test('settings has seven tabs and switches panels', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => (await state(app)).surface).toBe('settings');
    await expect
      .poll(async () =>
        shell(
          app,
          `[...document.querySelectorAll('#settingsTabs [role="tab"]')].map((el) => el.dataset.settingsTab).join(',')`,
        ),
      )
      .toBe('general,devin,claude,links,passwords,notifications,updates');
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('#settingsTabs [role="tab"]')].map((el) => el.textContent).join('|')`,
      ),
    ).toBe('General|Devin|Claude Code|Link Handling|Passwords|Notifications|Updates');
    expect(await selectedTab(app)).toBe('general');
    // General keeps the hosts, sessions column and shell rows; the GitHub tab
    // pool moved to Link Handling and the Cloud rows to Devin.
    await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
    expect(await hasEl(app, 'keepAliveInput')).toBe(false);
    expect(await hasEl(app, 'tenantUrlInput')).toBe(false);
    expect(
      await shell(app, `document.getElementById('settingsPanel-general').textContent`),
    ).not.toContain('Linked Context');

    await clickTab(app, 'devin');
    await expect.poll(async () => selectedTab(app)).toBe('devin');
    for (const id of [
      'tenantUrlInput',
      'apiBaseInput',
      'patInput',
      'sessionsMaxLiveViews',
      'sessionsKeepAliveHours',
    ]) {
      await expect.poll(async () => hasEl(app, id), id).toBe(true);
    }
    expect(await hasEl(app, 'keepAliveInput')).toBe(false);
    expect(await hasEl(app, 'settingsPanel-devin')).toBe(true);

    await clickTab(app, 'links');
    await expect.poll(async () => selectedTab(app)).toBe('links');
    await expect.poll(async () => hasEl(app, 'keepAliveInput')).toBe(true);
    expect(await shell(app, `document.getElementById('settingsPanel-links').textContent`)).toContain(
      'Linked Context',
    );

    await clickTab(app, 'notifications');
    await expect.poll(async () => selectedTab(app)).toBe('notifications');
    await expect.poll(async () => hasEl(app, 'notificationsCollectInput')).toBe(true);
    expect(await hasEl(app, 'patInput')).toBe(false);
    expect(await hasEl(app, 'tenantUrlInput')).toBe(false);
    expect(
      await shell(
        app,
        `document.getElementById('settingsPanel-notifications')?.getAttribute('role')`,
      ),
    ).toBe('tabpanel');
  } finally {
    await quit(app, profile);
  }
});

// Each moved field lives in its section; devin-cloud renders before devin-local.
test('moved fields sit in their Devin and Link Handling sections', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, { FAKE_WSL_DISTROS: 'Fake:Running:default' });
  const inSection = (section: string, id: string) =>
    shell(
      app,
      `Boolean(document.querySelector('[data-settings-section="${section}"] #${id}'))`,
    );
  const MOVED = [
    'patInput',
    'patSave',
    'patClear',
    'patStatus',
    'userIdInput',
    'orgIdInput',
    'usageDevinPollMinutes',
    'keepAliveInput',
    'maxLiveTabsInput',
    'prAutoOpenTabsInput',
  ];
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
    for (const id of MOVED) expect(await hasEl(app, id), `general: ${id}`).toBe(false);

    const layout: Array<[tab: string, section: string, ids: string[]]> = [
      [
        'devin',
        'devin-cloud',
        [
          'tenantUrlInput',
          'apiBaseInput',
          'patInput',
          'patSave',
          'patClear',
          'patStatus',
          'userIdInput',
          'orgIdInput',
          'usageDevinPollMinutes',
          'sessionsMaxLiveViews',
          'sessionsKeepAliveHours',
        ],
      ],
      [
        'devin',
        'devin-local',
        ['devinPathInput', 'localDefaultModeSelect', 'localPickerFolderInput', 'localAgentsSummary'],
      ],
      ['links', 'links-linked-context', ['keepAliveInput', 'maxLiveTabsInput', 'prAutoOpenTabsInput']],
    ];
    for (const [tab, section, ids] of layout) {
      await clickTab(app, tab);
      await expect.poll(async () => selectedTab(app)).toBe(tab);
      for (const id of ids) {
        await expect.poll(async () => inSection(section, id), `${section}: ${id}`).toBe(true);
      }
      // DOM order inside the section follows the layout list.
      expect(
        await shell(
          app,
          `[...document.querySelectorAll('[data-settings-section="${section}"] [id]')].map((el) => el.id).filter((id) => ${JSON.stringify(ids)}.includes(id)).join(',')`,
        ),
      ).toBe(ids.join(','));
    }
    await clickTab(app, 'devin');
    await expect.poll(async () => selectedTab(app)).toBe('devin');
    await expect
      .poll(async () => inSection('devin-local', 'localDefaultWslDistroSelect'))
      .toBe(true);
    // HostsPointer has no id; assert on its text inside the section.
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('[data-settings-section="devin-local"] p')].some((el) => el.textContent.includes('Per-host CLI paths and shell overrides are under General'))`,
      ),
    ).toBe(true);
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('[data-settings-section]')].map((el) => el.dataset.settingsSection).join(',')`,
      ),
    ).toBe('devin-cloud,devin-local');
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('[data-settings-section] h3')].map((el) => el.textContent).join('|')`,
      ),
    ).toBe('Devin Cloud|Devin Local');

    await clickTab(app, 'notifications');
    await expect.poll(async () => hasEl(app, 'notificationsCollectInput')).toBe(true);
    for (const id of MOVED) expect(await hasEl(app, id), `notifications: ${id}`).toBe(false);
  } finally {
    await quit(app, profile);
  }
});

test('editing a field commits implicitly on tab switch', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
    await clickTab(app, 'links');
    await expect.poll(async () => hasEl(app, 'keepAliveInput')).toBe(true);

    expect(await setInputValue(app, 'keepAliveInput', '48')).toBe(true);
    await clickTab(app, 'passwords');
    await expect
      .poll(async () => (await state(app)).settings.tabs.keepAliveHours)
      .toBe(48);
    await waitForEvent(logFile, 'settings-commit');
    const commit = (await readEvents(logFile))
      .filter((e) => e.event === 'settings-commit')
      .pop();
    expect((commit?.detail as any)?.ok).toBe(true);
    expect(await selectedTab(app)).toBe('passwords');
  } finally {
    await quit(app, profile);
  }
});

test('a validation failure keeps the tab and flags the field', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'devin');
    await expect.poll(async () => hasEl(app, 'tenantUrlInput')).toBe(true);

    await setInputValue(app, 'tenantUrlInput', 'ftp://bad');
    await clickTab(app, 'passwords');
    // Tab switch is refused; the field is flagged, focused, and the error banner shows.
    await expect.poll(async () => selectedTab(app)).toBe('devin');
    await expect
      .poll(async () =>
        shell(app, `document.getElementById('tenantUrlInput')?.getAttribute('aria-invalid')`),
      )
      .toBe('true');
    await expect.poll(async () => shell(app, `document.activeElement?.id`)).toBe('tenantUrlInput');
    await expect
      .poll(async () => shell(app, `Boolean(document.getElementById('settingsError'))`))
      .toBe(true);
    await expect
      .poll(async () => shell(app, `Boolean(document.getElementById('tenantUrlInputError'))`))
      .toBe(true);
    expect((await readEvents(logFile)).some((e) => e.event === 'tenant-changed')).toBe(false);

    // Leaving Settings through the rail is refused the same way and the
    // error routing lands on the Devin tab (DRAFT_TAB.tenantUrl === 'devin').
    await shell(app, `document.getElementById('cloudButton').click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await state(app)).surface).toBe('settings');
    expect(await selectedTab(app)).toBe('devin');
    expect(await shell(app, `document.activeElement?.id`)).toBe('tenantUrlInput');

    // A valid value saves and the switch goes through. The fixture URL is a
    // real change (settings.tenantUrl defaults to the cloud tenant) and the
    // resulting devin-view reload lands back on the fixture origin.
    await setInputValue(app, 'tenantUrlInput', fixtures.devinUrl);
    await clickTab(app, 'passwords');
    await expect.poll(async () => selectedTab(app)).toBe('passwords');
    await expect
      .poll(async () => (await state(app)).settings.tenantUrl)
      .toBe(fixtures.devinUrl);
  } finally {
    await quit(app, profile);
  }
});

test('a validation failure blocks leaving Settings via the rail', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
    await clickTab(app, 'links');
    await expect.poll(async () => hasEl(app, 'maxLiveTabsInput')).toBe(true);

    await setInputValue(app, 'maxLiveTabsInput', '0');
    await shell(app, `document.getElementById('cloudButton').click()`);
    await expect
      .poll(async () => shell(app, `Boolean(document.getElementById('settingsError'))`))
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await state(app)).surface).toBe('settings');
    // The error routes to Link Handling (DRAFT_TAB.maxLiveTabs === 'links').
    expect(await selectedTab(app)).toBe('links');
    expect(
      await shell(app, `document.getElementById('maxLiveTabsInput')?.getAttribute('aria-invalid')`),
    ).toBe('true');
    await expect.poll(async () => shell(app, `document.activeElement?.id`)).toBe('maxLiveTabsInput');
  } finally {
    await quit(app, profile);
  }
});

test('an invalid user id routes the error to the Devin tab', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'devin');
    await expect.poll(async () => hasEl(app, 'userIdInput')).toBe(true);

    // notifications.userId is capped at 128 characters by the settings schema.
    await setInputValue(app, 'userIdInput', `user-${'x'.repeat(200)}`);
    await clickTab(app, 'passwords');
    await expect
      .poll(async () =>
        shell(app, `document.getElementById('userIdInput')?.getAttribute('aria-invalid')`),
      )
      .toBe('true');
    expect(await selectedTab(app)).toBe('devin');
    await expect.poll(async () => shell(app, `document.activeElement?.id`)).toBe('userIdInput');
    expect(await hasEl(app, 'userIdInputError')).toBe(true);
    expect((await settingsOf(app)).notifications.userId).toBe('');
  } finally {
    await quit(app, profile);
  }
});

test('the PR auto-open checkbox on Link Handling saves instantly', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'links');
    await expect.poll(async () => hasEl(app, 'prAutoOpenTabsInput')).toBe(true);
    expect((await settingsOf(app)).prs.autoOpenTabs).toBe(true);
    expect(await shell(app, `document.getElementById('prAutoOpenTabsInput').checked`)).toBe(true);

    await shell(app, `document.getElementById('prAutoOpenTabsInput').click()`);
    await expect.poll(async () => (await settingsOf(app)).prs.autoOpenTabs).toBe(false);
    await expect
      .poll(async () => shell(app, `document.getElementById('prAutoOpenTabsInput').checked`))
      .toBe(false);
    // Instant-save, not the draft: no tab switch and no draft commit happened.
    expect(await selectedTab(app)).toBe('links');
    expect((await readEvents(logFile)).some((e) => e.event === 'settings-commit')).toBe(false);
  } finally {
    await quit(app, profile);
  }
});

test('updates tab renders release notes for current and available versions', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await shell(app, `document.querySelector('[data-settings-tab="updates"]').click()`);
    await expect
      .poll(async () =>
        shell(app, `document.getElementById('releasesLink')?.getAttribute('href')`),
      )
      .toBe('https://github.com/brianwentz/agent-workspace/releases');

    // The fixture serves notes for v<pkg.version>: rendered markdown, no
    // "available" card until an update is pending.
    await expect
      .poll(async () =>
        shell(
          app,
          `document.getElementById('releaseNotesCurrent')?.getAttribute('data-notes-state')`,
        ),
      )
      .toBe('ok');
    await expect
      .poll(async () =>
        shell(app, `Boolean(document.querySelector('#releaseNotesCurrent strong'))`),
      )
      .toBe(true);
    expect(await shell(app, `Boolean(document.getElementById('releaseNotesAvailable'))`)).toBe(
      false,
    );
    await waitForEvent(logFile, 'release-notes');
    const entry = (await readEvents(logFile))
      .filter((e) => e.event === 'release-notes')
      .pop();
    expect((entry?.detail as any)?.ok).toBe(true);
    expect(readFileSync(logFile, 'utf8')).not.toContain('bold item');

    // An available update adds its card above the current-version card.
    await app.evaluate(
      (_e, v: string) => (globalThis as any).__agentworkspace.simulateUpdateAvailable(v),
      '9.9.9',
    );
    await expect
      .poll(async () =>
        shell(
          app,
          `document.getElementById('releaseNotesAvailable')?.getAttribute('data-notes-state')`,
        ),
      )
      .toBe('ok');
    const order = (await shell(
      app,
      `[...document.querySelectorAll('[data-notes-state]')].map((el) => el.id).join(',')`,
    )) as string;
    expect(order).toBe('releaseNotesAvailable,releaseNotesCurrent');
  } finally {
    await quit(app, profile);
  }
});

test('updates tab reports missing release notes on a non-2xx response', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  // Point the releases base at a path the fixture never serves (non-2xx).
  const app = await launch(profile, logFile, {
    AGENT_WORKSPACE_TEST_RELEASES_URL: `${fixtures.apiUrl}/nope`,
  });
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await shell(app, `document.querySelector('[data-settings-tab="updates"]').click()`);
    await expect
      .poll(async () =>
        shell(
          app,
          `document.getElementById('releaseNotesCurrent')?.getAttribute('data-notes-state')`,
        ),
      )
      .toBe('missing');
    await expect
      .poll(async () =>
        shell(app, `document.getElementById('releaseNotesCurrent')?.textContent`),
      )
      .toContain('Release notes unavailable.');
    const entry = (await readEvents(logFile))
      .filter((e) => e.event === 'release-notes')
      .pop();
    expect((entry?.detail as any)?.ok).toBe(false);
  } finally {
    await quit(app, profile);
  }
});

// PublicState types settings loosely; the P3 tabs read these two sections.
const settingsOf = async (app: ElectronApplication) =>
  (await state(app)).settings as unknown as {
    local: { defaultWslDistro: string | null };
    claude: { hooksEnabled: boolean; keepAliveMinutes: number; defaultWslDistro: string | null };
    notifications: { userId: string };
    prs: { autoOpenTabs: boolean };
  };
const readSettings = (profile: string) =>
  JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
// React's <select onChange> listens for the native 'change' event.
const setSelectValue = (app: ElectronApplication, id: string, value: string) =>
  shell(
    app,
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );

test('Devin tab renders the devin path and the agents summary', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'devin');
    await expect.poll(async () => selectedTab(app)).toBe('devin');
    await expect.poll(async () => hasEl(app, 'devinPathInput')).toBe(true);
    expect(await hasEl(app, 'localAgentsSummary')).toBe(true);
    expect(await hasEl(app, 'settingsPanel-devin')).toBe(true);
    // No fake distros by default → the select is replaced by the muted line.
    expect(await hasEl(app, 'localDefaultWslDistroSelect')).toBe(false);
    expect(await shell(app, `document.getElementById('settingsPanel-devin').textContent`)).toContain(
      'No WSL distros detected.',
    );
    // The Devin tab carries the Cloud rows but not the GitHub tab pool.
    expect(await hasEl(app, 'tenantUrlInput')).toBe(true);
    expect(await hasEl(app, 'keepAliveInput')).toBe(false);
    // Neither the Claude controls nor the Cloud rows live on General.
    await clickTab(app, 'general');
    await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
    expect(await hasEl(app, 'claudePathInput')).toBe(false);
    expect(await hasEl(app, 'tenantUrlInput')).toBe(false);
  } finally {
    await quit(app, profile);
  }
});

test('Claude Code tab renders the moved and new controls', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'claude');
    await expect.poll(async () => selectedTab(app)).toBe('claude');
    await expect.poll(async () => hasEl(app, 'claudePathInput')).toBe(true);
    for (const id of [
      'claudeAutoArchiveInput',
      'claudePermissionModeDefault',
      'claudeModelInput',
      'claudeKeepAliveInput',
      'claudeMaxLiveAgentsInput',
      'claudeHooksEnabledMirror',
    ]) {
      expect(await hasEl(app, id), id).toBe(true);
    }
    expect(await hasEl(app, 'claudeDefaultWslDistroSelect')).toBe(false);

    // An out-of-range max-live value blocks the tab switch and flags the field.
    await setInputValue(app, 'claudeMaxLiveAgentsInput', '11');
    await clickTab(app, 'general');
    await expect.poll(async () => selectedTab(app)).toBe('claude');
    await expect
      .poll(async () =>
        shell(
          app,
          `document.getElementById('claudeMaxLiveAgentsInput')?.getAttribute('aria-invalid')`,
        ),
      )
      .toBe('true');
    await expect.poll(async () => hasEl(app, 'claudeMaxLiveAgentsInputError')).toBe(true);
    await expect.poll(async () => hasEl(app, 'settingsError')).toBe(true);

    // Fixing it plus a keep-alive change saves and persists to settings.json.
    await setInputValue(app, 'claudeMaxLiveAgentsInput', '4');
    await setInputValue(app, 'claudeKeepAliveInput', '45');
    await clickTab(app, 'general');
    await expect.poll(async () => selectedTab(app)).toBe('general');
    await expect.poll(async () => (await settingsOf(app)).claude.keepAliveMinutes).toBe(45);
    await expect.poll(async () => readSettings(profile).claude).toMatchObject({
      keepAliveMinutes: 45,
      maxLiveAgents: 4,
    });
  } finally {
    await quit(app, profile);
  }
});

test('the hooks mirror and the Notifications checkbox reflect each other', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const checked = (id: string) => shell(app, `document.getElementById('${id}')?.checked`);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'claude');
    await expect.poll(async () => hasEl(app, 'claudeHooksEnabledMirror')).toBe(true);
    const initial = (await checked('claudeHooksEnabledMirror')) as boolean;
    expect((await settingsOf(app)).claude.hooksEnabled).toBe(initial);

    await shell(app, `document.getElementById('claudeHooksEnabledMirror').click()`);
    await expect
      .poll(async () => (await settingsOf(app)).claude.hooksEnabled)
      .toBe(!initial);
    await expect.poll(async () => checked('claudeHooksEnabledMirror')).toBe(!initial);

    await clickTab(app, 'notifications');
    await expect.poll(async () => hasEl(app, 'claudeHooksToggle')).toBe(true);
    expect(await checked('claudeHooksToggle')).toBe(!initial);

    await shell(app, `document.getElementById('claudeHooksToggle').click()`);
    await expect
      .poll(async () => (await settingsOf(app)).claude.hooksEnabled)
      .toBe(initial);
    await clickTab(app, 'claude');
    await expect.poll(async () => hasEl(app, 'claudeHooksEnabledMirror')).toBe(true);
    expect(await checked('claudeHooksEnabledMirror')).toBe(initial);
  } finally {
    await quit(app, profile);
  }
});

test('both distro selects list the fake distro and persist independently', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, { FAKE_WSL_DISTROS: 'Fake:Running:default' });
  const options = (id: string) =>
    shell(app, `[...document.querySelectorAll('#${id} option')].map((o) => o.value).join(',')`);
  try {
    await expect
      .poll(async () => (await state(app)).hosts.some((h) => h.id === 'wsl:Fake'), {
        timeout: 30_000,
      })
      .toBe(true);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'devin');
    await expect.poll(async () => hasEl(app, 'localDefaultWslDistroSelect')).toBe(true);
    expect(await options('localDefaultWslDistroSelect')).toBe(',Fake');
    expect(await setSelectValue(app, 'localDefaultWslDistroSelect', 'Fake')).toBe(true);
    await expect
      .poll(async () => shell(app, `document.getElementById('localDefaultWslDistroSelect').value`))
      .toBe('Fake');

    await clickTab(app, 'claude');
    await expect.poll(async () => selectedTab(app)).toBe('claude');
    await expect.poll(async () => hasEl(app, 'claudeDefaultWslDistroSelect')).toBe(true);
    expect(await options('claudeDefaultWslDistroSelect')).toBe(',Fake');
    expect(
      await shell(app, `document.getElementById('claudeDefaultWslDistroSelect').value`),
    ).toBe('');

    await expect.poll(async () => (await settingsOf(app)).local.defaultWslDistro).toBe('Fake');
    const persisted = readSettings(profile);
    expect(persisted.local.defaultWslDistro).toBe('Fake');
    expect(persisted.claude.defaultWslDistro ?? null).toBeNull();
  } finally {
    await quit(app, profile);
  }
});

test('a dirty draft is flushed on quit', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
  await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
  await clickTab(app, 'links');
  await expect.poll(async () => hasEl(app, 'maxLiveTabsInput')).toBe(true);
  await setInputValue(app, 'maxLiveTabsInput', '7');

  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);

  const flush = (await readEvents(logFile)).find((e) => e.event === 'settings-flush');
  expect(flush).toBeTruthy();
  expect((flush!.detail as any).pending).toBe(true);
  expect((flush!.detail as any).ok).toBe(true);
  expect((flush!.detail as any).timedOut).toBe(false);
  const persisted = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as {
    tabs: { maxLiveTabs: number };
  };
  expect(persisted.tabs.maxLiveTabs).toBe(7);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

// ux3 S6: a build only rewrites what it understands — keys written by a
// newer build (or an unknown value for a known key) come back out unchanged.
test('settings.json keeps unknown keys and an invalid untouched value across a run', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-settings-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      future: { x: 1 },
      // showArchived is invalid here and has no Settings-page field, so the
      // form commit below never touches it (the draft covers claude.model etc.).
      claude: { futureField: true, showArchived: 'yes', model: 'opus-x' },
      tabs: { keepAliveHours: 24, maxLiveTabs: 8 },
    }),
  );
  const app = await launch(profile, logFile);
  await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
  await expect.poll(async () => hasEl(app, 'terminalShellInput')).toBe(true);
  await clickTab(app, 'links');
  await expect.poll(async () => hasEl(app, 'maxLiveTabsInput')).toBe(true);
  // The invalid leaf fell back to its default in memory; the rest of the block survived.
  const loaded = (await state(app)).settings;
  expect(loaded.claude).toMatchObject({ showArchived: false, model: 'opus-x' });
  await setInputValue(app, 'maxLiveTabsInput', '7');
  await clickTab(app, 'passwords');
  await waitForEvent(logFile, 'settings-commit');

  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);

  const persisted = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  expect(persisted.tabs.maxLiveTabs).toBe(7);
  expect(persisted.future).toEqual({ x: 1 });
  expect(persisted.claude.futureField).toBe(true);
  expect(persisted.claude.showArchived).toBe('yes');
  expect(persisted.claude.model).toBe('opus-x');
  const events = await readEvents(logFile);
  const preserved = events.filter((e) => e.event === 'store-preserved');
  expect(preserved.some((e) => (e.detail as any)?.store === 'settings')).toBe(true);
  const settingsPreserved = preserved.find((e) => (e.detail as any)?.store === 'settings');
  expect((settingsPreserved!.detail as any).keys).toEqual(
    expect.arrayContaining(['future', 'claude.futureField']),
  );
  const repaired = events.find((e) => e.event === 'settings-repaired');
  expect((repaired?.detail as any)).toMatchObject({ dropped: ['claude.showArchived'], preserved: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

// Task 14: the OpenHands API key is a sibling secret field — writing or
// clearing one never touches the other. The test only checks which base64
// fields are present in secrets.json; it never decrypts them.
test('secrets.json keeps devinPat and openhandsApiKey independent', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-secrets-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  const hook = (name: string, ...args: unknown[]) =>
    app.evaluate(
      async (_electron, [n, a]) => (globalThis as any).__agentworkspace[n as string](...(a as unknown[])),
      [name, args] as [string, unknown[]],
    );
  const secrets = () => JSON.parse(readFileSync(join(profile, 'secrets.json'), 'utf8'));

  await hook('secretsSetOpenHands', 'oh-key-1');
  expect(Object.keys(secrets()).sort()).toEqual(['openhandsApiKey', 'version']);
  const ohBlob = secrets().openhandsApiKey as string;
  expect(ohBlob.length).toBeGreaterThan(0);

  // Saving the Devin token leaves the OpenHands key unchanged.
  await hook('setPat', 'devin-pat-1');
  expect(Object.keys(secrets()).sort()).toEqual(['devinPat', 'openhandsApiKey', 'version']);
  expect(secrets().openhandsApiKey).toBe(ohBlob);

  // Clearing the Devin token leaves the OpenHands key in place.
  await hook('clearPat');
  expect(Object.keys(secrets()).sort()).toEqual(['openhandsApiKey', 'version']);
  expect(secrets().openhandsApiKey).toBe(ohBlob);

  // Reverse: clearing the OpenHands key leaves the Devin token in place.
  await hook('setPat', 'devin-pat-2');
  const patBlob = secrets().devinPat as string;
  await hook('secretsSetOpenHands', null);
  expect(Object.keys(secrets()).sort()).toEqual(['devinPat', 'version']);
  expect(secrets().devinPat).toBe(patBlob);

  await quit(app, profile);
});
