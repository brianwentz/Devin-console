import { describe, expect, it } from 'vitest';
import { mergeSettings, migrateSettingsRaw, parseSettingsFile, serializeSettingsFile } from '../../src/core/settings';
import { SettingsPatchSchema, SettingsSchema, type Settings } from '../../src/shared/ipc';

describe('parseSettingsFile', () => {
  it('parses a valid file unchanged', () => {
    const raw = {
      tenantUrl: 'https://tenant.example.com',
      apiBase: 'https://api.example.com',
      workspaces: ['C:\\work'],
      routing: { allowExternal: false },
      pane: { open: false, fraction: 0.4 },
      surface: 'local',
      tabs: { keepAliveHours: 48, maxLiveTabs: 12 },
    };
    const { settings, dropped } = parseSettingsFile(raw);
    expect(dropped).toEqual([]);
    expect(settings.tenantUrl).toBe('https://tenant.example.com');
    expect(settings.routing.allowExternal).toBe(false);
    expect(settings.pane).toEqual({ open: false, fraction: 0.4 });
    expect(settings.surface).toBe('local');
  });

  it('returns defaults for missing or non-object input (corrupt JSON path)', () => {
    for (const raw of [undefined, null, 'not json {{{', 42]) {
      const { settings, dropped } = parseSettingsFile(raw);
      expect(settings).toEqual(SettingsSchema.parse({}));
      expect(settings.tenantUrl).toBe('https://cloudbeds.devinenterprise.com');
      expect(dropped).toEqual(raw && typeof raw === 'object' ? dropped : []);
    }
  });

  it('drops only the invalid field and keeps the rest', () => {
    const { settings, dropped } = parseSettingsFile({
      tenantUrl: 42,
      apiBase: 'https://api.example.com',
      pane: { open: false, fraction: 0.4 },
      surface: 'local',
    });
    expect(dropped).toEqual(['tenantUrl']);
    expect(settings.tenantUrl).toBe('https://cloudbeds.devinenterprise.com');
    expect(settings.apiBase).toBe('https://api.example.com');
    expect(settings.pane).toEqual({ open: false, fraction: 0.4 });
    expect(settings.surface).toBe('local');
  });

  it('F3: rejects non-https tenant/api URLs (http only for localhost)', () => {
    const { settings, dropped } = parseSettingsFile({
      tenantUrl: 'file:///c:/evil',
      apiBase: 'http://remote.example.com',
      workspaces: [],
    });
    expect(dropped).toEqual(['tenantUrl', 'apiBase']);
    expect(settings.tenantUrl).toBe('https://cloudbeds.devinenterprise.com');
    expect(settings.apiBase).toBe('https://api.devin.ai');
    // http on loopback is allowed.
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:8080/x', 'http://[::1]:9']) {
      const result = parseSettingsFile({ tenantUrl: url });
      expect(result.dropped).toEqual([]);
      expect(result.settings.tenantUrl).toBe(url);
    }
  });
});

describe('mergeSettings', () => {
  const current: Settings = {
    ...SettingsSchema.parse({}),
    tenantUrl: 'https://x.example',
    pane: { open: false, fraction: 0.4 },
  };

  it('does not leak defaults into the patch schema', () => {
    expect(SettingsPatchSchema.parse({})).toEqual({});
    expect(SettingsPatchSchema.parse({ pane: { fraction: 0.6 } })).toEqual({
      pane: { fraction: 0.6 },
    });
    expect(SettingsPatchSchema.safeParse({ pane: { fraction: 1.5 } }).success).toBe(false);
  });

  it('updates only the patched pane field', () => {
    const next = mergeSettings(current, { pane: { fraction: 0.6 } });
    expect(next.tenantUrl).toBe('https://x.example');
    expect(next.pane).toEqual({ open: false, fraction: 0.6 });
  });

  it('updates only the patched tabs field', () => {
    const next = mergeSettings(current, { tabs: { keepAliveHours: 6 } });
    expect(next.tabs).toEqual({ keepAliveHours: 6, maxLiveTabs: 8 });
    const again = mergeSettings(next, { tabs: { maxLiveTabs: 20 } });
    expect(again.tabs).toEqual({ keepAliveHours: 6, maxLiveTabs: 20 });
  });

  it('updates only the patched routing field', () => {
    const next = mergeSettings(current, { routing: { allowExternal: false } });
    expect(next.routing.allowExternal).toBe(false);
    expect(next.tenantUrl).toBe('https://x.example');
    expect(next.pane).toEqual({ open: false, fraction: 0.4 });
  });

  it('is a no-op for an empty patch', () => {
    expect(mergeSettings(current, {})).toEqual(current);
  });

  it('returns current unchanged for an invalid patch', () => {
    expect(mergeSettings(current, { tenantUrl: 42 })).toBe(current);
  });
});

describe('P8 migration', () => {
  it('moves a legacy `tabs` snapshot to tabSnapshot', () => {
    const snapshot = { tabs: [{ id: 'a', url: 'https://x', title: 'x' }], activeId: 'a' };
    const { settings } = parseSettingsFile({ tabs: snapshot });
    expect(settings.tabSnapshot).toEqual(snapshot);
    expect(settings.tabs).toEqual({ keepAliveHours: 24, maxLiveTabs: 8 });
  });

  it('maps a non-default discardIdleMinutes to keepAliveHours', () => {
    expect(parseSettingsFile({ discardIdleMinutes: 90 }).settings.tabs.keepAliveHours).toBe(2);
    expect(parseSettingsFile({ discardIdleMinutes: 30 }).settings.tabs.keepAliveHours).toBe(24);
    expect(parseSettingsFile({ discardIdleMinutes: 5 }).settings.tabs.keepAliveHours).toBe(1);
    expect(parseSettingsFile({ discardIdleMinutes: 0 }).settings.tabs.keepAliveHours).toBe(1);
  });

  it('does not overwrite an explicit keepAliveHours', () => {
    const { settings } = parseSettingsFile({
      discardIdleMinutes: 60,
      tabs: { keepAliveHours: 10, maxLiveTabs: 4 },
    });
    expect(settings.tabs).toEqual({ keepAliveHours: 10, maxLiveTabs: 4 });
  });
});

describe('tab review settings', () => {
  it('defaults review.host, layout.reviewTerminalHeight and kinds.review', () => {
    const s = SettingsSchema.parse({});
    expect(s.review.host).toBe('local');
    expect(s.layout.reviewTerminalHeight).toBe(260);
    expect(s.notifications.kinds.review).toBe(true);
  });

  it('accepts local and wsl:<distro> hosts, repairs ssh:x to local keeping it raw', () => {
    expect(parseSettingsFile({ review: { host: 'wsl:Ubuntu' } }).settings.review.host).toBe('wsl:Ubuntu');
    const raw = { review: { host: 'ssh:x', future: 1 } };
    const { settings, dropped, invalid } = parseSettingsFile(raw);
    expect(settings.review.host).toBe('local');
    expect(dropped).toContain('review.host');
    const out = serializeSettingsFile(raw, settings, invalid, new Set());
    expect(out.review).toEqual({
      host: 'ssh:x',
      agent: 'claude',
      command: '/cb:review {github-url}',
      claudeMode: 'auto',
      devinMode: 'auto',
      cwd: null,
      future: 1,
    });
  });

  it('caps review.host at 200 characters', () => {
    expect(parseSettingsFile({ review: { host: `wsl:${'a'.repeat(196)}` } }).settings.review.host).toHaveLength(200);
    const long = parseSettingsFile({ review: { host: `wsl:${'a'.repeat(197)}` } });
    expect(long.settings.review.host).toBe('local');
    expect(long.dropped).toContain('review.host');
  });

  it('bounds layout.reviewTerminalHeight to 120..2000', () => {
    expect(parseSettingsFile({ layout: { reviewTerminalHeight: 50 } }).dropped).toContain('layout.reviewTerminalHeight');
    expect(parseSettingsFile({ layout: { reviewTerminalHeight: 2001 } }).dropped).toContain('layout.reviewTerminalHeight');
    expect(parseSettingsFile({ layout: { reviewTerminalHeight: 400 } }).settings.layout.reviewTerminalHeight).toBe(400);
  });
});

describe('F2 pane fraction migration', () => {
  // Legacy px widths were recorded against the 1400 px default window: 1400 - 56 - 6 = 1338.
  it('converts pane.width px to pane.fraction and drops width', () => {
    const { settings, dropped } = parseSettingsFile({ pane: { open: true, width: 500 } });
    expect(dropped).toEqual([]);
    expect(settings.pane.fraction).toBeCloseTo(500 / 1338, 6);
    expect(settings.pane.open).toBe(true);
    expect('width' in settings.pane).toBe(false);
  });

  it('clamps out-of-range px to [0, 1]', () => {
    expect(parseSettingsFile({ pane: { width: 5000 } }).settings.pane.fraction).toBe(1);
    expect(parseSettingsFile({ pane: { width: -20 } }).settings.pane.fraction).toBe(0);
  });

  it('keeps an explicit fraction when both are present', () => {
    const { settings } = parseSettingsFile({ pane: { width: 500, fraction: 0.7 } });
    expect(settings.pane.fraction).toBe(0.7);
  });

  it('falls back to the 0.5 default when width is not a finite number', () => {
    expect(parseSettingsFile({ pane: { width: 'wide' } }).settings.pane.fraction).toBe(0.5);
    expect(parseSettingsFile({ pane: { open: false } }).settings.pane).toEqual({
      open: false,
      fraction: 0.5,
    });
    expect(SettingsSchema.parse({}).pane).toEqual({ open: true, fraction: 0.5 });
  });

  it('migrateSettingsRaw strips width even when fraction already exists', () => {
    expect(migrateSettingsRaw({ pane: { width: 500, fraction: 0.3 } })).toEqual({
      pane: { fraction: 0.3 },
    });
  });
});

describe('F2 window placements', () => {
  it('defaults to an empty record and merges as a top-level replace', () => {
    const base = SettingsSchema.parse({});
    expect(base.windowPlacements).toEqual({});
    const placement = { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: false, savedAt: 10 };
    const merged = mergeSettings(base, { windowPlacements: { a: placement } });
    expect(merged.windowPlacements).toEqual({ a: placement });
    const replaced = mergeSettings(merged, { windowPlacements: { b: placement } });
    expect(replaced.windowPlacements).toEqual({ b: placement });
    expect(SettingsPatchSchema.safeParse({ windowPlacements: { a: { bounds: {} } } }).success).toBe(false);
  });

  it('drops an invalid windowPlacements field on repair but keeps the rest', () => {
    const { settings, dropped } = parseSettingsFile({ windowPlacements: 'nope', surface: 'local' });
    expect(dropped).toEqual(['windowPlacements']);
    expect(settings.windowPlacements).toEqual({});
    expect(settings.surface).toBe('local');
  });
});

describe('notifications settings (P5/P6)', () => {
  const DEFAULT_KINDS = {
    waiting: true,
    approval: true,
    blocked: true,
    finished: false,
    prOpened: true,
    prCompleted: true,
    update: true,
    usage: true,
    review: true,
  };
  it('defaults collect/banner on, org/user blank, kinds with finished off', () => {
    const base = SettingsSchema.parse({});
    expect(base.notifications).toEqual({
      collect: true,
      banner: true,
      orgId: '',
      userId: '',
      kinds: DEFAULT_KINDS,
    });
    const merged = mergeSettings(base, { notifications: { collect: false, banner: false } });
    expect(merged.notifications).toEqual({ collect: false, banner: false, orgId: '', userId: '', kinds: DEFAULT_KINDS });
    const withOrg = mergeSettings(merged, { notifications: { orgId: 'org-123' } });
    expect(withOrg.notifications.orgId).toBe('org-123');
    expect(withOrg.notifications.collect).toBe(false);
    const withUser = mergeSettings(withOrg, { notifications: { userId: 'user-123' } });
    expect(withUser.notifications.userId).toBe('user-123');
    expect(withUser.notifications.orgId).toBe('org-123');
    // kind patches merge deep (a single kind does not reset the rest)
    const kindsOff = mergeSettings(withOrg, { notifications: { kinds: { finished: true, prOpened: false } } });
    expect(kindsOff.notifications.kinds).toEqual({ ...DEFAULT_KINDS, finished: true, prOpened: false });
    expect(SettingsPatchSchema.safeParse({ notifications: { collect: 'yes' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ notifications: { kinds: { update: 'yes' } } }).success).toBe(false);
  });
  it('migrates notifications.enabled → collect', () => {
    const { settings } = parseSettingsFile({
      notifications: { enabled: false, orgId: 'org-9' },
    });
    expect(settings.notifications.collect).toBe(false);
    expect(settings.notifications.orgId).toBe('org-9');
    expect(settings.notifications).not.toHaveProperty('enabled');
    const { settings: on } = parseSettingsFile({ notifications: { enabled: true } });
    expect(on.notifications.collect).toBe(true);
  });
});

describe('prs settings (F1)', () => {
  it('defaults autoOpenTabs to true and toggles via a patch', () => {
    const base = SettingsSchema.parse({});
    expect(base.prs).toEqual({ autoOpenTabs: true });
    expect(SettingsPatchSchema.parse({})).not.toHaveProperty('prs');
    const off = mergeSettings(base, { prs: { autoOpenTabs: false } });
    expect(off.prs).toEqual({ autoOpenTabs: false });
    expect(off.notifications).toEqual(base.notifications);
    const on = mergeSettings(off, { prs: { autoOpenTabs: true } });
    expect(on.prs).toEqual({ autoOpenTabs: true });
    expect(mergeSettings(off, { notifications: { collect: false } }).prs).toEqual({ autoOpenTabs: false });
    expect(SettingsPatchSchema.safeParse({ prs: { autoOpenTabs: 'yes' } }).success).toBe(false);
    // A pre-F1 settings file without `prs` parses to the default.
    expect(parseSettingsFile({ tenantUrl: 'https://x.example' }).settings.prs).toEqual({ autoOpenTabs: true });
  });
});

describe('terminal dock settings (F5)', () => {
  it('defaults layout/terminal and merges shallowly', () => {
    const base = SettingsSchema.parse({});
    expect(base.layout).toEqual({ terminalOpen: false, terminalHeight: 280, reviewTerminalHeight: 260 });
    expect(base.terminal).toEqual({ shell: '' });

    const merged = mergeSettings(base, {
      layout: { terminalOpen: true },
      terminal: { shell: 'pwsh.exe -NoLogo' },
    });
    expect(merged.layout).toEqual({ terminalOpen: true, terminalHeight: 280, reviewTerminalHeight: 260 });
    expect(merged.terminal).toEqual({ shell: 'pwsh.exe -NoLogo' });
    const resized = mergeSettings(merged, { layout: { terminalHeight: 400, reviewTerminalHeight: 260 } });
    expect(resized.layout).toEqual({ terminalOpen: true, terminalHeight: 400, reviewTerminalHeight: 260 });
  });

  it('rejects a terminal height below the minimum', () => {
    expect(SettingsPatchSchema.safeParse({ layout: { terminalHeight: 60 } }).success).toBe(false);
    // ux3 S6: repair is leaf-granular inside structural blocks.
    const { settings, dropped, invalid } = parseSettingsFile({
      layout: { terminalOpen: true, terminalHeight: 60 },
    });
    expect(dropped).toEqual(['layout.terminalHeight']);
    expect(invalid).toEqual({ 'layout.terminalHeight': 60 });
    expect(settings.layout).toEqual({ terminalOpen: true, terminalHeight: 280, reviewTerminalHeight: 260 });
  });
});

describe('routing.rules', () => {
  const linkRule = (id: string) => ({
    id,
    kind: 'prefix' as const,
    pattern: 'https://x.example/',
    enabled: true,
  });

  it('defaults to an empty array', () => {
    expect(SettingsSchema.parse({}).routing).toEqual({ allowExternal: true, rules: [] });
  });

  it('mergeSettings replaces the whole rules array', () => {
    const base = mergeSettings(SettingsSchema.parse({}), {
      routing: { rules: [linkRule('a'), linkRule('b')] },
    });
    expect(base.routing.rules.map((r) => r.id)).toEqual(['a', 'b']);
    const replaced = mergeSettings(base, { routing: { rules: [linkRule('c')] } });
    expect(replaced.routing.rules.map((r) => r.id)).toEqual(['c']);
    // A patch without `rules` leaves the array alone.
    const untouched = mergeSettings(replaced, { routing: { allowExternal: false } });
    expect(untouched.routing).toEqual({ allowExternal: false, rules: [linkRule('c')] });
  });

  it('drops an oversized or invalid rules array on repair', () => {
    const oversized = {
      routing: {
        allowExternal: false,
        rules: Array.from({ length: 101 }, (_, i) => linkRule(`r${i}`)),
      },
    };
    const { settings, dropped } = parseSettingsFile(oversized);
    // ux3 S6: only the failing leaf is dropped; allowExternal survives.
    expect(dropped).toEqual(['routing.rules']);
    expect(settings.routing).toEqual({ allowExternal: false, rules: [] });
    const badRule = parseSettingsFile({
      routing: { rules: [{ id: 'x', kind: 'bogus', pattern: 'p', enabled: true }] },
    });
    expect(badRule.dropped).toEqual(['routing.rules']);
    expect(badRule.settings.routing.rules).toEqual([]);
  });

  it('rejects invalid rules in patches', () => {
    expect(
      SettingsPatchSchema.safeParse({
        routing: { rules: [{ id: '', kind: 'prefix', pattern: 'https://x/', enabled: true }] },
      }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({
        routing: { rules: [{ id: 'x', kind: 'prefix', pattern: '', enabled: true }] },
      }).success,
    ).toBe(false);
  });
});

describe('sessions settings', () => {
  it('defaults to open, width 260, no collapsed folders', () => {
    const settings = SettingsSchema.parse({});
    expect(settings.sessions).toEqual({
      open: true,
      width: 260,
      collapsedFolders: [],
      maxLiveViews: 6,
      keepAliveHours: 24,
      sessionOrder: {},
    });
  });

  it('parses explicit values and rejects out-of-range width', () => {
    const { settings, dropped } = parseSettingsFile({
      sessions: {
        open: false,
        width: 320,
        collapsedFolders: ['Alpha'],
        maxLiveViews: 4,
        keepAliveHours: 2,
      },
    });
    expect(dropped).toEqual([]);
    expect(settings.sessions).toEqual({
      open: false,
      width: 320,
      collapsedFolders: ['Alpha'],
      maxLiveViews: 4,
      keepAliveHours: 2,
      sessionOrder: {},
    });
    expect(
      parseSettingsFile({ sessions: { width: 9999 } }).settings.sessions.width,
    ).toBe(260);
  });

  it('patches collapsedFolders without touching open/width', () => {
    const base: Settings = {
      ...SettingsSchema.parse({}),
      sessions: {
        open: false,
        width: 300,
        collapsedFolders: [],
        maxLiveViews: 6,
        keepAliveHours: 24,
        sessionOrder: {},
      },
    };
    const next = mergeSettings(base, {
      sessions: { collapsedFolders: ['Alpha', 'pinned'], maxLiveViews: 3 },
    });
    expect(next.sessions).toEqual({
      open: false,
      width: 300,
      collapsedFolders: ['Alpha', 'pinned'],
      maxLiveViews: 3,
      keepAliveHours: 24,
      sessionOrder: {},
    });
  });

  it('rejects out-of-range pool fields', () => {
    expect(
      SettingsPatchSchema.safeParse({ sessions: { maxLiveViews: 0 } }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ sessions: { maxLiveViews: 21 } }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ sessions: { keepAliveHours: -1 } }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ sessions: { keepAliveHours: 168 } }).success,
    ).toBe(true);
  });
});

describe('claude settings', () => {
  it('defaults to null path, no collapsed folders, archive hidden, auto-archive off', () => {
    const settings = SettingsSchema.parse({});
    expect(settings.claude).toEqual({
      path: null,
      collapsedFolders: [],
      showArchived: false,
      autoArchiveDays: 0,
      defaultPermissionMode: 'default',
      model: null,
      keepAliveMinutes: 15,
      maxLiveAgents: 3,
      lastSessionId: null,
      hooksEnabled: false,
      workspaces: [],
      workspaceLabels: {},
      defaultWslDistro: null,
      sessionOrder: {},
      pickerFolder: null,
    });
  });

  it('parses explicit values and clamps autoArchiveDays', () => {
    const { settings } = parseSettingsFile({
      claude: { path: 'C:\\tools\\claude.exe', showArchived: true, autoArchiveDays: 30 },
    });
    expect(settings.claude.path).toBe('C:\\tools\\claude.exe');
    expect(settings.claude.showArchived).toBe(true);
    expect(settings.claude.autoArchiveDays).toBe(30);
    expect(
      parseSettingsFile({ claude: { autoArchiveDays: 999 } }).settings.claude.autoArchiveDays,
    ).toBe(0);
  });

  it('patches one claude field without resetting the rest', () => {
    const base: Settings = {
      ...SettingsSchema.parse({}),
      claude: {
        ...SettingsSchema.parse({}).claude,
        path: '/usr/bin/claude',
      },
    };
    const next = mergeSettings(base, { claude: { showArchived: true } });
    expect(next.claude).toEqual({
      ...SettingsSchema.parse({}).claude,
      path: '/usr/bin/claude',
      showArchived: true,
      autoArchiveDays: 0,
    });
    expect(
      SettingsPatchSchema.safeParse({ claude: { autoArchiveDays: 366 } }).success,
    ).toBe(false);
  });
});

describe('hosts settings', () => {
  it('parse({}) yields the hosts defaults', () => {
    const settings = SettingsSchema.parse({});
    expect(settings.hosts).toEqual({
      wslEnabled: true,
      wslDistros: null,
      overrides: {},
      ssh: [],
    });
  });

  it('patches hosts fields without resetting the rest', () => {
    const base = SettingsSchema.parse({});
    const next = mergeSettings(base, {
      hosts: { wslEnabled: false, wslDistros: ['Ubuntu-22.04'] },
    });
    expect(next.hosts.wslEnabled).toBe(false);
    expect(next.hosts.wslDistros).toEqual(['Ubuntu-22.04']);
    expect(next.hosts.overrides).toEqual({});
  });

  it('merges overrides per host and per field', () => {
    const base = mergeSettings(SettingsSchema.parse({}), {
      hosts: {
        overrides: {
          'wsl:Ubuntu-22.04': { claudePath: '/u/claude', home: '/home/b' },
          'wsl:Other': { envCaptureDisabled: true },
        },
      },
    });
    // A second patch to one host keeps its other fields and other hosts.
    const next = mergeSettings(base, {
      hosts: { overrides: { 'wsl:Ubuntu-22.04': { shell: '/bin/zsh' } } },
    });
    expect(next.hosts.overrides['wsl:Ubuntu-22.04']).toEqual({
      claudePath: '/u/claude',
      home: '/home/b',
      shell: '/bin/zsh',
    });
    expect(next.hosts.overrides['wsl:Other']).toEqual({ envCaptureDisabled: true });
  });

  it('rejects malformed hosts patches', () => {
    const current = SettingsSchema.parse({});
    expect(mergeSettings(current, { hosts: { wslEnabled: 'yes' } })).toBe(current);
    expect(
      SettingsPatchSchema.safeParse({ hosts: { wslDistros: 'Ubuntu' } }).success,
    ).toBe(false);
  });
});

describe('hosts.ssh (P3)', () => {
  it('accepts {alias, enabled} entries with canonical (lower-case) aliases', () => {
    const settings = SettingsSchema.parse({
      hosts: { ssh: [{ alias: 'box', enabled: true }, { alias: 'dev.example-1', enabled: false }] },
    });
    expect(settings.hosts.ssh).toEqual([
      { alias: 'box', enabled: true },
      { alias: 'dev.example-1', enabled: false },
    ]);
  });

  it('M4: lower-cases aliases and drops only malformed entries (the rest of the list survives)', () => {
    const settings = SettingsSchema.parse({
      hosts: {
        ssh: [
          { alias: ' Box ', enabled: true },
          ...['', '-oProxyCommand=x', 'a b', 'a;b', 'ssh://box', 'a/b'].map((alias) => ({ alias, enabled: true })),
          { alias: 'nobool' },
          'junk',
          { alias: 'BOX', enabled: false },
          { alias: 'dev', enabled: false },
        ],
      },
    });
    // Canonical, deduplicated (first wins), malformed entries gone.
    expect(settings.hosts.ssh).toEqual([
      { alias: 'box', enabled: true },
      { alias: 'dev', enabled: false },
    ]);
  });

  it('a patch replaces the ssh list and keeps the other hosts fields', () => {
    const base = mergeSettings(SettingsSchema.parse({}), { hosts: { wslEnabled: false } });
    const next = mergeSettings(base, { hosts: { ssh: [{ alias: 'box', enabled: true }] } });
    expect(next.hosts.ssh).toEqual([{ alias: 'box', enabled: true }]);
    expect(next.hosts.wslEnabled).toBe(false);
    expect(next.hosts.overrides).toEqual({});
  });

  it('an invalid alias drops only that entry: the valid ones and the rest of hosts are kept', () => {
    const raw = {
      hosts: { wslEnabled: false, ssh: [{ alias: 'ok', enabled: true }, { alias: '-bad', enabled: true }] },
    };
    const { settings, dropped } = parseSettingsFile(raw);
    expect(dropped).toEqual([]);
    expect(settings.hosts.ssh).toEqual([{ alias: 'ok', enabled: true }]);
    expect(settings.hosts.wslEnabled).toBe(false);
  });

  it('reserved aliases (ssh/local/wsl) are invalid in memory but preserved raw in the file (S6)', () => {
    const raw = {
      hosts: { ssh: [{ alias: 'box', enabled: true }, { alias: 'SSH', enabled: true, x: 1 }, { alias: 'local', enabled: false }] },
    };
    const { settings } = parseSettingsFile(raw);
    expect(settings.hosts.ssh).toEqual([{ alias: 'box', enabled: true }]);
    const out = serializeSettingsFile(raw, settings, {}, new Set(['hosts.ssh'])) as { hosts: { ssh: unknown[] } };
    expect(out.hosts.ssh).toEqual([
      { alias: 'box', enabled: true },
      { alias: 'SSH', enabled: true, x: 1 },
      { alias: 'local', enabled: false },
    ]);
  });

  it('a settings commit adding a reserved alias fails with a user-facing error', () => {
    for (const alias of ['ssh', 'Wsl']) {
      const parsed = SettingsPatchSchema.safeParse({ hosts: { ssh: [{ alias, enabled: true }] } });
      expect(parsed.success, alias).toBe(false);
      expect(parsed.error?.issues.map((i) => i.message).join(' '), alias).toMatch(/reserved/);
    }
    const ok = SettingsPatchSchema.safeParse({ hosts: { ssh: [{ alias: ' Box ', enabled: true }] } });
    expect(ok.success && ok.data.hosts?.ssh).toEqual([{ alias: 'box', enabled: true }]);
  });
});

describe('ux2 P0 — new local/claude workspace keys and removed-key migration', () => {
  it('defaults the new keys on parse({})', () => {
    const settings = SettingsSchema.parse({});
    expect(settings.local).toEqual({
      devinPath: null,
      defaultWslDistro: null,
      defaultMode: null,
      workspaceLabels: {},
      collapsedWorkspaces: [],
      sessionOrder: {},
      pickerFolder: null,
    });
    expect(settings.claude.workspaces).toEqual([]);
    expect(settings.claude.workspaceLabels).toEqual({});
    expect(settings.claude.defaultWslDistro).toBeNull();
  });

  it('patches the new keys', () => {
    const base = SettingsSchema.parse({});
    const next = mergeSettings(base, {
      local: {
        defaultWslDistro: 'Ubuntu-22.04',
        workspaceLabels: { 'C:\\ws': 'main' },
        collapsedWorkspaces: ['C:\\ws'],
      },
      claude: {
        workspaces: ['/home/u/ws'],
        workspaceLabels: { '/home/u/ws': 'ws' },
        defaultWslDistro: 'Ubuntu-24.04',
      },
    });
    expect(next.local.defaultWslDistro).toBe('Ubuntu-22.04');
    expect(next.local.workspaceLabels).toEqual({ 'C:\\ws': 'main' });
    expect(next.local.collapsedWorkspaces).toEqual(['C:\\ws']);
    expect(next.claude.workspaces).toEqual(['/home/u/ws']);
    expect(next.claude.defaultWslDistro).toBe('Ubuntu-24.04');
  });

  it('migrates hosts.defaultWslDistro to local + claude where absent', () => {
    const { settings } = parseSettingsFile({
      hosts: { defaultWslDistro: 'Ubuntu-22.04' },
    });
    expect(settings.local.defaultWslDistro).toBe('Ubuntu-22.04');
    expect(settings.claude.defaultWslDistro).toBe('Ubuntu-22.04');
    expect('defaultWslDistro' in settings.hosts).toBe(false);
  });

  it('keeps an already-set claude.defaultWslDistro during migration', () => {
    const { settings } = parseSettingsFile({
      hosts: { defaultWslDistro: 'Ubuntu-22.04' },
      claude: { defaultWslDistro: 'Ubuntu-24.04' },
    });
    expect(settings.claude.defaultWslDistro).toBe('Ubuntu-24.04');
    expect(settings.local.defaultWslDistro).toBe('Ubuntu-22.04');
  });

  it('old files with terminal.allSurfaces still parse and drop the key', () => {
    const { settings, dropped } = parseSettingsFile({
      terminal: { allSurfaces: true, shell: 'pwsh.exe' },
    });
    expect(dropped).toEqual([]);
    expect(settings.terminal).toEqual({ shell: 'pwsh.exe' });
    expect('allSurfaces' in settings.terminal).toBe(false);
  });
});

describe('ux3 S0 — sessionOrder + pickerFolder contracts', () => {
  it('round-trips sessionOrder through mergeSettings on all three surfaces', () => {
    const base = SettingsSchema.parse({});
    const next = mergeSettings(base, {
      local: { sessionOrder: { 'C:\\ws': ['l2', 'l1'] } },
      sessions: { sessionOrder: { Alpha: ['c3', 'c1'], recent: ['c9'] } },
      claude: { sessionOrder: { '/home/u/ws': ['k1'] } },
    });
    expect(next.local.sessionOrder).toEqual({ 'C:\\ws': ['l2', 'l1'] });
    expect(next.sessions.sessionOrder).toEqual({ Alpha: ['c3', 'c1'], recent: ['c9'] });
    expect(next.claude.sessionOrder).toEqual({ '/home/u/ws': ['k1'] });
    // untouched surface keeps its default
    const again = mergeSettings(next, { local: { sessionOrder: { 'C:\\ws': ['l1'] } } });
    expect(again.sessions.sessionOrder).toEqual(next.sessions.sessionOrder);
  });

  it('rejects a malformed sessionOrder', () => {
    expect(
      SettingsPatchSchema.safeParse({ local: { sessionOrder: { x: 'not-array' } } }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({
        sessions: { sessionOrder: { x: Array(501).fill('id') } },
      }).success,
    ).toBe(false);
  });

  it('round-trips local.pickerFolder + claude.pickerFolder (null and set)', () => {
    const base = SettingsSchema.parse({});
    expect(base.local.pickerFolder).toBeNull();
    expect(base.claude.pickerFolder).toBeNull();
    const next = mergeSettings(base, {
      local: { pickerFolder: 'C:\\work' },
      claude: { pickerFolder: '\\\\wsl.localhost\\Ubuntu\\home\\u' },
    });
    expect(next.local.pickerFolder).toBe('C:\\work');
    expect(next.claude.pickerFolder).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u');
    expect(next.local.devinPath).toBeNull();
    const cleared = mergeSettings(next, { local: { pickerFolder: null } });
    expect(cleared.local.pickerFolder).toBeNull();
    expect(cleared.claude.pickerFolder).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u');
  });

  it('round-trips local.defaultMode (null default, mode id, empty leaf dropped)', () => {
    const base = SettingsSchema.parse({});
    expect(base.local.defaultMode).toBeNull();
    const { settings, dropped } = parseSettingsFile({ local: { defaultMode: 'plan' } });
    expect(dropped).toEqual([]);
    expect(settings.local.defaultMode).toBe('plan');
    const next = mergeSettings(base, { local: { defaultMode: 'smart' } });
    expect(next.local.defaultMode).toBe('smart');
    const cleared = mergeSettings(next, { local: { defaultMode: null } });
    expect(cleared.local.defaultMode).toBeNull();
    // '' fails min(1): leaf-repair drops just this leaf at dotted-path granularity.
    const bad = parseSettingsFile({ local: { defaultMode: '', devinPath: 'D:\\devin.exe' } });
    expect(bad.dropped).toEqual(['local.defaultMode']);
    expect(bad.settings.local.defaultMode).toBeNull();
    expect(bad.settings.local.devinPath).toBe('D:\\devin.exe');
  });
});

describe('R40 L1: hosts.ssh raw entries keep their form and unknown fields (ux3 S6)', () => {
  it('a mixed-case entry keeps its raw alias + unknown fields; memory (enabled) wins; a later duplicate is kept raw', () => {
    const raw = {
      hosts: {
        ssh: [
          { alias: 'MyBox', enabled: true, future: 1 },
          { alias: 'other', enabled: true },
          { alias: 'MYBOX', enabled: false, dup: true },
        ],
      },
    };
    const { settings } = parseSettingsFile(raw);
    expect(settings.hosts.ssh).toEqual([
      { alias: 'mybox', enabled: true },
      { alias: 'other', enabled: true },
    ]);
    const value = mergeSettings(settings, {
      hosts: { ssh: [{ alias: 'mybox', enabled: false }, { alias: 'other', enabled: true }] },
    });
    const out = serializeSettingsFile(raw, value, {}, new Set(['hosts.ssh'])) as { hosts: { ssh: unknown[] } };
    expect(out.hosts.ssh).toEqual([
      { alias: 'MyBox', enabled: false, future: 1 },
      { alias: 'other', enabled: true },
      { alias: 'MYBOX', enabled: false, dup: true },
    ]);
    // Reloading the written file gives the same in-memory list.
    expect(parseSettingsFile(out).settings.hosts.ssh).toEqual([
      { alias: 'mybox', enabled: false },
      { alias: 'other', enabled: true },
    ]);
  });
  it('removing a host drops its raw entry and its raw duplicates', () => {
    const raw = { hosts: { ssh: [{ alias: 'Box', enabled: true, x: 1 }, { alias: 'BOX', enabled: true }, { alias: '-bad', enabled: true }] } };
    const { settings } = parseSettingsFile(raw);
    const value = { ...settings, hosts: { ...settings.hosts, ssh: [] } };
    const out = serializeSettingsFile(raw, value, {}, new Set(['hosts.ssh'])) as { hosts: { ssh: unknown[] } };
    expect(out.hosts.ssh).toEqual([{ alias: '-bad', enabled: true }]);
  });
});

describe('review agent settings', () => {
  it('defaults the six review fields', () => {
    expect(parseSettingsFile({}).settings.review).toEqual({
      host: 'local',
      agent: 'claude',
      command: '/cb:review {github-url}',
      claudeMode: 'auto',
      devinMode: 'auto',
      cwd: null,
    });
  });

  it('drops a command without the token, keeping the raw value on save', () => {
    const raw = { review: { command: '/x', future: 1 } };
    const { settings, dropped, invalid } = parseSettingsFile(raw);
    expect(settings.review.command).toBe('/cb:review {github-url}');
    expect(dropped).toContain('review.command');
    expect(invalid['review.command']).toBe('/x');
    const out = serializeSettingsFile(raw, settings, invalid, new Set());
    expect(out.review).toEqual({
      host: 'local',
      agent: 'claude',
      command: '/x',
      claudeMode: 'auto',
      devinMode: 'auto',
      cwd: null,
      future: 1,
    });
  });

  it('drops an unknown devin mode', () => {
    const r = parseSettingsFile({ review: { devinMode: 'plan' } });
    expect(r.dropped).toContain('review.devinMode');
    expect(r.settings.review.devinMode).toBe('auto');
  });
});
