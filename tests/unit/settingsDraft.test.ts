import { describe, expect, it } from 'vitest';
import {
  draftFromSettings,
  DRAFT_TAB,
  fieldErrorsFromIssues,
  firstErrorField,
  isDraftDirty,
  SETTINGS_TAB_ORDER,
  settingsTabForNotification,
  validateDraft,
  type DraftField,
  type SettingsDraft,
} from '../../src/core/settingsDraft';
import { mergeSettings } from '../../src/core/settings';
import { SettingsSchema } from '../../src/shared/ipc';

const defaults = SettingsSchema.parse({});

function draft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return { ...draftFromSettings(defaults), ...overrides };
}

describe('draftFromSettings', () => {
  it('round-trips: the patch merges back to equal settings', () => {
    const result = validateDraft(draftFromSettings(defaults));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const merged = mergeSettings(defaults, result.patch);
    expect(merged).toEqual(defaults);
  });

  it('maps every field', () => {
    const custom = mergeSettings(defaults, {
      tenantUrl: 'https://tenant.example.com',
      apiBase: 'https://api.example.com',
      workspaces: ['C:\\work'],
      routing: {
        allowExternal: false,
        rules: [{ id: 'r1', kind: 'prefix', pattern: 'https://x.example/', enabled: true }],
      },
      tabs: { keepAliveHours: 48, maxLiveTabs: 3 },
      sessions: { maxLiveViews: 4, keepAliveHours: 12 },
      terminal: { shell: 'pwsh.exe' },
      local: {
        devinPath: 'D:\\bin\\devin.exe',
        defaultWslDistro: 'Ubuntu-22.04',
        defaultMode: 'plan',
        pickerFolder: 'C:\\work',
      },
      notifications: { userId: 'user-1', orgId: 'org-2' },
      claude: {
        path: 'C:\\tools\\claude.exe',
        autoArchiveDays: 30,
        defaultPermissionMode: 'plan',
        model: 'claude-opus-4-1',
        keepAliveMinutes: 30,
        maxLiveAgents: 2,
        defaultWslDistro: 'Ubuntu-24.04',
        pickerFolder: '/home/u/ws',
      },
    });
    expect(draftFromSettings(custom)).toEqual({
      tenantUrl: 'https://tenant.example.com',
      apiBase: 'https://api.example.com',
      allowExternal: false,
      keepAliveHours: '48',
      maxLiveTabs: '3',
      usageDevinPollMinutes: '15',
      sessionsOpen: true,
      sessionsMaxLiveViews: '4',
      sessionsKeepAliveHours: '12',
      terminalShell: 'pwsh.exe',
      devinPath: 'D:\\bin\\devin.exe',
      localDefaultWslDistro: 'Ubuntu-22.04',
      localDefaultMode: 'plan',
      localPickerFolder: 'C:\\work',
      claudePath: 'C:\\tools\\claude.exe',
      claudeAutoArchiveDays: '30',
      claudePermissionMode: 'plan',
      claudeModel: 'claude-opus-4-1',
      claudeKeepAliveMinutes: '30',
      claudeMaxLiveAgents: '2',
      claudeDefaultWslDistro: 'Ubuntu-24.04',
      claudePickerFolder: '/home/u/ws',
      userId: 'user-1',
      orgId: 'org-2',
      linkRules: [{ id: 'r1', kind: 'prefix', pattern: 'https://x.example/', enabled: true }],
    });
  });
});

describe('isDraftDirty', () => {
  it('is clean for a fresh draft', () => {
    expect(isDraftDirty(draftFromSettings(defaults), defaults)).toBe(false);
  });

  it('is dirty when a field changes', () => {
    expect(isDraftDirty(draft({ tenantUrl: 'https://other.example.com' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ devinPath: 'C:\\x\\devin.exe' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ localDefaultWslDistro: 'Ubuntu-22.04' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ localDefaultMode: 'smart' }), defaults)).toBe(true);
    // '' maps to the null default; whitespace-only stays clean.
    expect(isDraftDirty(draft({ localDefaultMode: '   ' }), defaults)).toBe(false);
    expect(isDraftDirty(draft({ claudeKeepAliveMinutes: '30' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ claudeMaxLiveAgents: '5' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ claudeDefaultWslDistro: 'Ubuntu-22.04' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ allowExternal: false }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ maxLiveTabs: '9' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ userId: 'user-9' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ claudePath: 'C:\\x\\claude.exe' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ claudeAutoArchiveDays: '7' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ claudePermissionMode: 'acceptEdits' }), defaults)).toBe(true);
    expect(isDraftDirty(draft({ claudeModel: 'claude-sonnet-4-5' }), defaults)).toBe(true);
    // Blank model equals the null default; whitespace-only is clean too.
    expect(isDraftDirty(draft({ claudeModel: '   ' }), defaults)).toBe(false);
  });

  it('round-trips claude fields into the patch', () => {
    const result = validateDraft(
      draft({ claudePath: '  C:\\tools\\claude.exe  ', claudeAutoArchiveDays: '45' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.claude).toEqual({
      path: 'C:\\tools\\claude.exe',
      autoArchiveDays: 45,
      defaultPermissionMode: 'default',
      model: null,
      keepAliveMinutes: 15,
      maxLiveAgents: 3,
      defaultWslDistro: null,
      pickerFolder: null,
    });
    // Blank path clears the override.
    const cleared = validateDraft(draft({ claudePath: '  ' }));
    expect(cleared.ok && cleared.patch.claude?.path).toBe(null);
    // Permission mode + model round-trip; blank / whitespace model → null.
    const modeAndModel = validateDraft(
      draft({ claudePermissionMode: 'bypassPermissions', claudeModel: '  claude-opus-4-1  ' }),
    );
    expect(modeAndModel.ok && modeAndModel.patch.claude).toEqual({
      path: null,
      autoArchiveDays: 0,
      defaultPermissionMode: 'bypassPermissions',
      model: 'claude-opus-4-1',
      keepAliveMinutes: 15,
      maxLiveAgents: 3,
      defaultWslDistro: null,
      pickerFolder: null,
    });
    const blankModel = validateDraft(draft({ claudeModel: '   ' }));
    expect(blankModel.ok && blankModel.patch.claude?.model).toBe(null);
    const withModel = mergeSettings(defaults, {
      claude: { model: 'claude-opus-4-1', defaultPermissionMode: 'plan' },
    });
    expect(draftFromSettings(withModel).claudeModel).toBe('claude-opus-4-1');
    expect(draftFromSettings(withModel).claudePermissionMode).toBe('plan');
    const roundTrip = validateDraft(draftFromSettings(withModel));
    expect(roundTrip.ok && mergeSettings(defaults, roundTrip.patch)).toEqual(withModel);
    for (const value of ['-1', '366', '1.5', 'x']) {
      const bad = validateDraft(draft({ claudeAutoArchiveDays: value }));
      expect(bad.ok).toBe(false);
      if (bad.ok) continue;
      expect(bad.errors.claudeAutoArchiveDays).toBeTruthy();
    }
  });

  it('treats whitespace-only changes in trimmed fields as clean', () => {
    expect(isDraftDirty(draft({ terminalShell: '   ' }), defaults)).toBe(false);
    expect(isDraftDirty(draft({ userId: '  ', orgId: '\t' }), defaults)).toBe(false);
  });

  it('round-trips the five ux2 fields and routes their errors to the claude tab', () => {
    const result = validateDraft(
      draft({
        devinPath: '  D:\\bin\\devin.exe  ',
        localDefaultWslDistro: 'Ubuntu-22.04',
        claudeKeepAliveMinutes: '30',
        claudeMaxLiveAgents: '5',
        claudeDefaultWslDistro: 'Ubuntu-24.04',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.local).toEqual({
      devinPath: 'D:\\bin\\devin.exe',
      defaultWslDistro: 'Ubuntu-22.04',
      defaultMode: null,
      pickerFolder: null,
    });
    expect(result.patch.claude).toMatchObject({
      keepAliveMinutes: 30,
      maxLiveAgents: 5,
      defaultWslDistro: 'Ubuntu-24.04',
    });
    // Blank clears to null.
    const blank = validateDraft(draft({ devinPath: '  ', claudeDefaultWslDistro: '' }));
    expect(blank.ok && blank.patch.local?.devinPath).toBe(null);
    expect(blank.ok && blank.patch.claude?.defaultWslDistro).toBe(null);

    const badKeepAlive = validateDraft(draft({ claudeKeepAliveMinutes: '0' }));
    expect(badKeepAlive.ok).toBe(false);
    if (badKeepAlive.ok) return;
    expect(badKeepAlive.errors.claudeKeepAliveMinutes).toBeTruthy();
    const keepAliveField = firstErrorField(badKeepAlive.errors);
    expect(keepAliveField && DRAFT_TAB[keepAliveField]).toBe('claude');

    const badMaxLive = validateDraft(draft({ claudeMaxLiveAgents: '11' }));
    expect(badMaxLive.ok).toBe(false);
    if (badMaxLive.ok) return;
    expect(badMaxLive.errors.claudeMaxLiveAgents).toBeTruthy();
    const maxLiveField = firstErrorField(badMaxLive.errors);
    expect(maxLiveField && DRAFT_TAB[maxLiveField]).toBe('claude');
  });
});

describe('validateDraft', () => {
  it('produces the full patch shape on success', () => {
    const result = validateDraft(
      draft({ terminalShell: '  pwsh.exe -l  ', userId: ' u1 ', orgId: ' o1 ' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual({
      tenantUrl: defaults.tenantUrl,
      apiBase: defaults.apiBase,
      routing: { allowExternal: true, rules: [] },
      tabs: { keepAliveHours: 24, maxLiveTabs: 8 },
      usage: { devinPollMinutes: 15 },
      sessions: { open: true, maxLiveViews: 6, keepAliveHours: 24 },
      terminal: { shell: 'pwsh.exe -l' },
      local: { devinPath: null, defaultWslDistro: null, defaultMode: null, pickerFolder: null },
      claude: {
        path: null,
        autoArchiveDays: 0,
        defaultPermissionMode: 'default',
        model: null,
        keepAliveMinutes: 15,
        maxLiveAgents: 3,
        defaultWslDistro: null,
        pickerFolder: null,
      },
      notifications: { userId: 'u1', orgId: 'o1' },
    });
  });

  it('rejects a non-https tenant URL', () => {
    const result = validateDraft(draft({ tenantUrl: 'ftp://bad' }));
    expect(result).toEqual({
      ok: false,
      errors: {
        tenantUrl: 'Tenant URL must be an https URL (http allowed for localhost only)',
      },
    });
  });

  it('rejects a non-https API base', () => {
    const result = validateDraft(draft({ apiBase: 'http://remote.example.com' }));
    expect(result).toEqual({
      ok: false,
      errors: { apiBase: 'API base must be an https URL (http allowed for localhost only)' },
    });
  });

  it('rejects an out-of-range keep-alive', () => {
    for (const value of ['-1', '169', 'abc']) {
      const result = validateDraft(draft({ keepAliveHours: value }));
      expect(result).toEqual({
        ok: false,
        errors: { keepAliveHours: 'Keep-alive must be between 0 and 168 hours' },
      });
    }
  });

  it('rejects a non-integer or out-of-range max live tabs', () => {
    for (const value of ['0', '41', '2.5', 'x']) {
      const result = validateDraft(draft({ maxLiveTabs: value }));
      expect(result).toEqual({
        ok: false,
        errors: { maxLiveTabs: 'Max live tabs must be a whole number between 1 and 40' },
      });
    }
  });

  it('collects multiple field errors at once', () => {
    const result = validateDraft(draft({ tenantUrl: 'ftp://bad', maxLiveTabs: '0' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.tenantUrl).toBeTruthy();
    expect(result.errors.maxLiveTabs).toBeTruthy();
  });
});

describe('fieldErrorsFromIssues', () => {
  it('maps zod issue paths to draft fields', () => {
    const { errors, other } = fieldErrorsFromIssues([
      { path: ['tenantUrl'], message: 'bad tenant' },
      { path: ['tabs', 'keepAliveHours'], message: 'bad keepalive' },
      { path: ['notifications', 'userId'], message: 'bad user' },
      { path: ['terminal', 'shell'], message: 'bad shell' },
      { path: ['claude', 'model'], message: 'bad model' },
      { path: ['claude', 'defaultPermissionMode'], message: 'bad mode' },
    ]);
    expect(errors).toEqual({
      tenantUrl: 'bad tenant',
      keepAliveHours: 'bad keepalive',
      userId: 'bad user',
      terminalShell: 'bad shell',
      claudeModel: 'bad model',
      claudePermissionMode: 'bad mode',
    });
    expect(other).toEqual([]);
  });

  it('sends unmapped paths to other', () => {
    const { errors, other } = fieldErrorsFromIssues([
      { path: ['pane', 'fraction'], message: 'bad fraction' },
      { path: [], message: 'whole-object failure' },
    ]);
    expect(errors).toEqual({});
    expect(other).toEqual(['bad fraction', 'whole-object failure']);
  });
});

describe('DRAFT_TAB / firstErrorField', () => {
  it('covers every draft field', () => {
    const draftKeys = Object.keys(draftFromSettings(defaults)) as DraftField[];
    expect(Object.keys(DRAFT_TAB).sort()).toEqual(draftKeys.sort());
    expect(DRAFT_TAB.localPickerFolder).toBe('devin');
    expect(DRAFT_TAB.claudePickerFolder).toBe('claude');
    expect(DRAFT_TAB.allowExternal).toBe('links');
    // Devin tab: the Devin Cloud and Devin Local sections share one tab.
    for (const field of [
      'tenantUrl',
      'apiBase',
      'sessionsMaxLiveViews',
      'sessionsKeepAliveHours',
      'usageDevinPollMinutes',
      'userId',
      'orgId',
      'devinPath',
      'localDefaultWslDistro',
      'localDefaultMode',
      'localPickerFolder',
    ] as const) {
      expect(DRAFT_TAB[field]).toBe('devin');
    }
    // Linked Context (GitHub tab pool) lives on Link Handling.
    expect(DRAFT_TAB.keepAliveHours).toBe('links');
    expect(DRAFT_TAB.maxLiveTabs).toBe('links');
    for (const field of [
      'claudePath',
      'claudeAutoArchiveDays',
      'claudePermissionMode',
      'claudeModel',
      'claudeKeepAliveMinutes',
      'claudeMaxLiveAgents',
      'claudeDefaultWslDistro',
    ] as const) {
      expect(DRAFT_TAB[field]).toBe('claude');
    }
  });

  it('routes every field to a real tab, and the tab order is fixed', () => {
    expect(SETTINGS_TAB_ORDER).toEqual([
      'general',
      'devin',
      'claude',
      'links',
      'passwords',
      'notifications',
      'updates',
    ]);
    for (const tab of Object.values(DRAFT_TAB)) {
      expect(SETTINGS_TAB_ORDER).toContain(tab);
    }
  });

  it('returns the first erroring field in SettingsDraft key order', () => {
    expect(firstErrorField({})).toBeNull();
    expect(firstErrorField({ maxLiveTabs: 'x', tenantUrl: 'y' })).toBe('tenantUrl');
    expect(firstErrorField({ orgId: 'x', userId: 'y' })).toBe('userId');
  });
});

describe('settingsTabForNotification', () => {
  it.each([
    ['auth', 'devin'],
    ['identity', 'devin'],
    ['usage', null],
    ['update', null],
    ['waiting', null],
    ['approval', null],
    ['blocked', null],
    ['finished', null],
    ['pr-opened', null],
    ['pr-completed', null],
  ] as const)('%s -> %s', (kind, tab) => {
    expect(settingsTabForNotification(kind)).toBe(tab);
  });
});

describe('link rules draft field', () => {
  const linkRule = (overrides = {}) => ({
    id: 'r1',
    kind: 'prefix' as const,
    pattern: 'https://jira.example.com/browse/',
    enabled: true,
    ...overrides,
  });

  it('is dirty when rules are added, removed, or edited', () => {
    expect(isDraftDirty(draft({ linkRules: [linkRule()] }), defaults)).toBe(true);
    const withRule = mergeSettings(defaults, { routing: { rules: [linkRule()] } });
    expect(isDraftDirty(draftFromSettings(withRule), withRule)).toBe(false);
    expect(
      isDraftDirty(
        { ...draftFromSettings(withRule), linkRules: [linkRule({ enabled: false })] },
        withRule,
      ),
    ).toBe(true);
    expect(isDraftDirty({ ...draftFromSettings(withRule), linkRules: [] }, withRule)).toBe(true);
  });

  it('treats whitespace-only pattern changes as clean', () => {
    const withRule = mergeSettings(defaults, { routing: { rules: [linkRule()] } });
    const dirty = { ...draftFromSettings(withRule) };
    dirty.linkRules = [linkRule({ pattern: '  https://jira.example.com/browse/  ' })];
    expect(isDraftDirty(dirty, withRule)).toBe(false);
  });

  it('validates each rule and reports the first failure with its index', () => {
    const result = validateDraft(
      draft({
        linkRules: [
          linkRule({ id: 'a' }),
          linkRule({ id: 'b', kind: 'regex', pattern: '([' }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.linkRules).toMatch(/^Rule 2: Invalid regular expression: /);
  });

  it('requires a non-empty pattern', () => {
    const result = validateDraft(draft({ linkRules: [linkRule({ pattern: '   ' })] }));
    expect(result).toEqual({ ok: false, errors: { linkRules: 'Rule 1: pattern is required' } });
  });

  it('emits trimmed rules in the patch', () => {
    const result = validateDraft(
      draft({ linkRules: [linkRule({ pattern: '  https://x.example/  ' })] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.routing?.rules).toEqual([
      linkRule({ pattern: 'https://x.example/' }),
    ]);
  });
});

describe('pickerFolder draft fields (ux3 S0)', () => {
  it('maps settings <-> draft (empty = unset)', () => {
    const withFolders = mergeSettings(defaults, {
      local: { pickerFolder: 'C:\\work' },
      claude: { pickerFolder: '\\\\wsl.localhost\\Ubuntu\\home\\u' },
    });
    const d = draftFromSettings(withFolders);
    expect(d.localPickerFolder).toBe('C:\\work');
    expect(d.claudePickerFolder).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u');
    const result = validateDraft(d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.local?.pickerFolder).toBe('C:\\work');
    expect(result.patch.claude?.pickerFolder).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u');
    // blank -> null in the patch
    const blank = validateDraft(draft({}));
    expect(blank.ok).toBe(true);
    if (!blank.ok) return;
    expect(blank.patch.local?.pickerFolder).toBeNull();
    expect(blank.patch.claude?.pickerFolder).toBeNull();
  });

  it('accepts drive, UNC and posix-absolute paths; rejects relative', () => {
    for (const value of [
      'C:\\x',
      'd:/x',
      '\\\\wsl.localhost\\Ubuntu\\home\\u',
      '\\\\server\\share',
      '/home/u',
    ]) {
      const result = validateDraft(
        draft({ localPickerFolder: value, claudePickerFolder: value }),
      );
      expect(result.ok, value).toBe(true);
    }
    for (const value of ['relative\\x', './x', '..\\up', 'home/u']) {
      const result = validateDraft(draft({ localPickerFolder: value }));
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors.localPickerFolder).toBe('Enter an absolute folder path');
      const r2 = validateDraft(draft({ claudePickerFolder: value }));
      expect(r2.ok, value).toBe(false);
      if (!r2.ok) expect(r2.errors.claudePickerFolder).toBe('Enter an absolute folder path');
    }
  });
});


describe('localDefaultMode draft field', () => {
  it("maps '' <-> null and round-trips a mode id through the patch", () => {
    expect(draftFromSettings(defaults).localDefaultMode).toBe('');
    const withMode = mergeSettings(defaults, { local: { defaultMode: 'plan' } });
    expect(draftFromSettings(withMode).localDefaultMode).toBe('plan');

    const set = validateDraft(draft({ localDefaultMode: '  smart  ' }));
    expect(set.ok && set.patch.local?.defaultMode).toBe('smart');
    const cleared = validateDraft(draft({ localDefaultMode: '   ' }));
    expect(cleared.ok && cleared.patch.local?.defaultMode).toBe(null);

    const roundTrip = validateDraft(draftFromSettings(withMode));
    expect(roundTrip.ok && mergeSettings(defaults, roundTrip.patch)).toEqual(withMode);
  });

  it('routes its errors to the devin tab', () => {
    expect(DRAFT_TAB.localDefaultMode).toBe('devin');
    const { errors } = fieldErrorsFromIssues([
      { path: ['local', 'defaultMode'], message: 'bad mode' },
    ]);
    expect(errors.localDefaultMode).toBe('bad mode');
  });
});
