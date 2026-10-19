import { describe, expect, it } from 'vitest';
import {
  draftFromSettings,
  DRAFT_TAB,
  fieldErrorsFromIssues,
  firstErrorField,
  isDraftDirty,
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
      terminal: { allSurfaces: true, shell: 'pwsh.exe' },
      notifications: { userId: 'user-1', orgId: 'org-2' },
      claude: {
        path: 'C:\\tools\\claude.exe',
        autoArchiveDays: 30,
        defaultPermissionMode: 'plan',
        model: 'claude-opus-4-1',
      },
    });
    expect(draftFromSettings(custom)).toEqual({
      tenantUrl: 'https://tenant.example.com',
      apiBase: 'https://api.example.com',
      workspaces: ['C:\\work'],
      allowExternal: false,
      keepAliveHours: '48',
      maxLiveTabs: '3',
      sessionsOpen: true,
      sessionsMaxLiveViews: '4',
      sessionsKeepAliveHours: '12',
      terminalAllSurfaces: true,
      terminalShell: 'pwsh.exe',
      defaultWslDistro: '',
      claudePath: 'C:\\tools\\claude.exe',
      claudeAutoArchiveDays: '30',
      claudePermissionMode: 'plan',
      claudeModel: 'claude-opus-4-1',
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
    expect(isDraftDirty(draft({ workspaces: ['C:\\x'] }), defaults)).toBe(true);
    // Element-wise: joined-equal but differently-split lists are dirty.
    const joined = mergeSettings(defaults, { workspaces: ['ab'] });
    expect(
      isDraftDirty(
        { ...draftFromSettings(joined), workspaces: ['a', 'b'] },
        joined,
      ),
    ).toBe(true);
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
      workspaces: [],
      routing: { allowExternal: true, rules: [] },
      tabs: { keepAliveHours: 24, maxLiveTabs: 8 },
      sessions: { open: true, maxLiveViews: 6, keepAliveHours: 24 },
      terminal: { allSurfaces: false, shell: 'pwsh.exe -l' },
      hosts: { defaultWslDistro: null },
      claude: { path: null, autoArchiveDays: 0, defaultPermissionMode: 'default', model: null },
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
    expect(DRAFT_TAB.userId).toBe('notifications');
    expect(DRAFT_TAB.orgId).toBe('notifications');
    expect(DRAFT_TAB.tenantUrl).toBe('general');
    expect(DRAFT_TAB.allowExternal).toBe('links');
  });

  it('returns the first erroring field in SettingsDraft key order', () => {
    expect(firstErrorField({})).toBeNull();
    expect(firstErrorField({ maxLiveTabs: 'x', tenantUrl: 'y' })).toBe('tenantUrl');
    expect(firstErrorField({ orgId: 'x', userId: 'y' })).toBe('userId');
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
