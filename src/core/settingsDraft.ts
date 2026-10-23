import { normalizeBaseUrl } from './openhands';
import { isAllowedAppUrl } from './sessions';
import { validateLinkRule } from './linkRules';
import { isValidProfileDir } from './chromeBookmarks';
import type { ClaudePermissionMode, LinkRule, Settings, SettingsPatch } from '../shared/ipc';

// Mirrors ClaudePermissionModeSchema (kept here so the shell bundle needs no
// zod/ipc value import); the type annotation fails to compile if they diverge.
export const CLAUDE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const satisfies readonly ClaudePermissionMode[];

// Fallback option list for the local.defaultMode select — mirrors what
// `devin acp` advertises; the UI prefers the union of modes live agents
// report on their sessions and only uses this when none are known.
export const DEVIN_LOCAL_MODES = [
  { id: 'accept-edits', name: 'Code' },
  { id: 'smart', name: 'Smart' },
  { id: 'ask', name: 'Ask' },
  { id: 'plan', name: 'Plan' },
  { id: 'bypass', name: 'Bypass Permissions' },
] as const;

// Picker start-folder draft fields accept a Windows drive root, a UNC path, or
// a POSIX-absolute path (a WSL home is valid for a UNC-rooted picker).
export function isAbsolutePickerPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(value);
}

export interface SettingsDraft {
  tenantUrl: string;
  apiBase: string;
  allowExternal: boolean;
  keepAliveHours: string;
  maxLiveTabs: string;
  usageDevinPollMinutes: string;
  sessionsOpen: boolean;
  sessionsMaxLiveViews: string;
  sessionsKeepAliveHours: string;
  terminalShell: string;
  devinPath: string;
  localDefaultWslDistro: string;
  // '' = agent default (null in settings).
  localDefaultMode: string;
  localPickerFolder: string;
  claudePath: string;
  claudeAutoArchiveDays: string;
  claudePermissionMode: ClaudePermissionMode;
  claudeModel: string;
  claudeKeepAliveMinutes: string;
  claudeMaxLiveAgents: string;
  claudeDefaultWslDistro: string;
  claudePickerFolder: string;
  openhandsBaseUrl: string;
  openhandsPollSeconds: string;
  openhandsMaxLiveViews: string;
  openhandsKeepAliveHours: string;
  userId: string;
  orgId: string;
  linkRules: LinkRule[];
  // '' = Chrome's last used profile (null in settings).
  favoritesChromeProfile: string;
}

export type DraftField = keyof SettingsDraft;

export const SETTINGS_TAB_ORDER = [
  'general',
  'devin',
  'claude',
  'openhands',
  'links',
  'passwords',
  'notifications',
  'updates',
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_ORDER)[number];

export const DRAFT_TAB: Record<DraftField, SettingsTabId> = {
  tenantUrl: 'devin',
  apiBase: 'devin',
  allowExternal: 'links',
  keepAliveHours: 'links',
  maxLiveTabs: 'links',
  usageDevinPollMinutes: 'devin',
  sessionsOpen: 'general',
  sessionsMaxLiveViews: 'devin',
  sessionsKeepAliveHours: 'devin',
  terminalShell: 'general',
  devinPath: 'devin',
  localDefaultWslDistro: 'devin',
  localDefaultMode: 'devin',
  localPickerFolder: 'devin',
  claudePath: 'claude',
  claudeAutoArchiveDays: 'claude',
  claudePermissionMode: 'claude',
  claudeModel: 'claude',
  claudeKeepAliveMinutes: 'claude',
  claudeMaxLiveAgents: 'claude',
  claudeDefaultWslDistro: 'claude',
  claudePickerFolder: 'claude',
  openhandsBaseUrl: 'openhands',
  openhandsPollSeconds: 'openhands',
  openhandsMaxLiveViews: 'openhands',
  openhandsKeepAliveHours: 'openhands',
  userId: 'devin',
  orgId: 'devin',
  linkRules: 'links',
  favoritesChromeProfile: 'links',
};

// Notifications whose fix is a Devin Cloud setting (token, user id) open
// Settings on the Devin tab.
export function settingsTabForNotification(kind: string): SettingsTabId | null {
  return kind === 'auth' || kind === 'identity' ? 'devin' : null;
}

const FIELD_ORDER = Object.keys(DRAFT_TAB) as DraftField[];

export type DraftErrors = Partial<Record<DraftField, string>>;

export function draftFromSettings(settings: Settings): SettingsDraft {
  return {
    tenantUrl: settings.tenantUrl,
    apiBase: settings.apiBase,
    allowExternal: settings.routing.allowExternal,
    keepAliveHours: String(settings.tabs.keepAliveHours),
    maxLiveTabs: String(settings.tabs.maxLiveTabs),
    usageDevinPollMinutes: String(settings.usage.devinPollMinutes),
    sessionsOpen: settings.sessions.open,
    sessionsMaxLiveViews: String(settings.sessions.maxLiveViews),
    sessionsKeepAliveHours: String(settings.sessions.keepAliveHours),
    terminalShell: settings.terminal.shell,
    devinPath: settings.local.devinPath ?? '',
    localDefaultWslDistro: settings.local.defaultWslDistro ?? '',
    localDefaultMode: settings.local.defaultMode ?? '',
    localPickerFolder: settings.local.pickerFolder ?? '',
    claudePath: settings.claude.path ?? '',
    claudeAutoArchiveDays: String(settings.claude.autoArchiveDays),
    claudePermissionMode: settings.claude.defaultPermissionMode,
    claudeModel: settings.claude.model ?? '',
    claudeKeepAliveMinutes: String(settings.claude.keepAliveMinutes),
    claudeMaxLiveAgents: String(settings.claude.maxLiveAgents),
    claudeDefaultWslDistro: settings.claude.defaultWslDistro ?? '',
    claudePickerFolder: settings.claude.pickerFolder ?? '',
    openhandsBaseUrl: settings.openhands.baseUrl,
    openhandsPollSeconds: String(settings.openhands.pollSeconds),
    openhandsMaxLiveViews: String(settings.openhands.maxLiveViews),
    openhandsKeepAliveHours: String(settings.openhands.keepAliveHours),
    userId: settings.notifications.userId,
    orgId: settings.notifications.orgId,
    linkRules: settings.routing.rules.map((rule) => ({ ...rule })),
    favoritesChromeProfile: settings.favorites.chromeProfile ?? '',
  };
}

function linkRulesEqual(a: LinkRule, b: LinkRule): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.pattern.trim() === b.pattern.trim() &&
    a.enabled === b.enabled
  );
}

export function isDraftDirty(draft: SettingsDraft, settings: Settings): boolean {
  const base = draftFromSettings(settings);
  return (
    draft.tenantUrl.trim() !== base.tenantUrl ||
    draft.apiBase.trim() !== base.apiBase ||
    draft.allowExternal !== base.allowExternal ||
    Number(draft.keepAliveHours) !== Number(base.keepAliveHours) ||
    Number(draft.maxLiveTabs) !== Number(base.maxLiveTabs) ||
    Number(draft.usageDevinPollMinutes) !== Number(base.usageDevinPollMinutes) ||
    draft.sessionsOpen !== base.sessionsOpen ||
    Number(draft.sessionsMaxLiveViews) !== Number(base.sessionsMaxLiveViews) ||
    Number(draft.sessionsKeepAliveHours) !== Number(base.sessionsKeepAliveHours) ||
    draft.terminalShell.trim() !== base.terminalShell ||
    draft.devinPath.trim() !== base.devinPath ||
    draft.localDefaultWslDistro !== base.localDefaultWslDistro ||
    draft.localDefaultMode.trim() !== base.localDefaultMode ||
    draft.localPickerFolder.trim() !== base.localPickerFolder ||
    draft.claudePath.trim() !== base.claudePath ||
    Number(draft.claudeAutoArchiveDays) !== Number(base.claudeAutoArchiveDays) ||
    draft.claudePermissionMode !== base.claudePermissionMode ||
    draft.claudeModel.trim() !== base.claudeModel ||
    Number(draft.claudeKeepAliveMinutes) !== Number(base.claudeKeepAliveMinutes) ||
    Number(draft.claudeMaxLiveAgents) !== Number(base.claudeMaxLiveAgents) ||
    draft.claudeDefaultWslDistro !== base.claudeDefaultWslDistro ||
    draft.claudePickerFolder.trim() !== base.claudePickerFolder ||
    draft.openhandsBaseUrl.trim() !== base.openhandsBaseUrl ||
    Number(draft.openhandsPollSeconds) !== Number(base.openhandsPollSeconds) ||
    Number(draft.openhandsMaxLiveViews) !== Number(base.openhandsMaxLiveViews) ||
    Number(draft.openhandsKeepAliveHours) !== Number(base.openhandsKeepAliveHours) ||
    draft.userId.trim() !== base.userId ||
    draft.orgId.trim() !== base.orgId ||
    draft.favoritesChromeProfile !== base.favoritesChromeProfile ||
    draft.linkRules.length !== base.linkRules.length ||
    draft.linkRules.some((rule, index) => !linkRulesEqual(rule, base.linkRules[index]!))
  );
}

export function validateDraft(
  draft: SettingsDraft,
): { ok: true; patch: SettingsPatch } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const tenantUrl = draft.tenantUrl.trim();
  const apiBase = draft.apiBase.trim();
  if (!isAllowedAppUrl(tenantUrl)) {
    errors.tenantUrl = 'Tenant URL must be an https URL (http allowed for localhost only)';
  }
  if (!isAllowedAppUrl(apiBase)) {
    errors.apiBase = 'API base must be an https URL (http allowed for localhost only)';
  }
  const keepAlive = Number(draft.keepAliveHours);
  if (!Number.isFinite(keepAlive) || keepAlive < 0 || keepAlive > 168) {
    errors.keepAliveHours = 'Keep-alive must be between 0 and 168 hours';
  }
  const maxLive = Number(draft.maxLiveTabs);
  if (!Number.isInteger(maxLive) || maxLive < 1 || maxLive > 40) {
    errors.maxLiveTabs = 'Max live tabs must be a whole number between 1 and 40';
  }
  const devinPoll = Number(draft.usageDevinPollMinutes);
  if (!Number.isInteger(devinPoll) || devinPoll < 5 || devinPoll > 240) {
    errors.usageDevinPollMinutes =
      'Usage check interval must be a whole number between 5 and 240 minutes';
  }
  const sessionsMaxLive = Number(draft.sessionsMaxLiveViews);
  if (!Number.isInteger(sessionsMaxLive) || sessionsMaxLive < 1 || sessionsMaxLive > 20) {
    errors.sessionsMaxLiveViews =
      'Cloud sessions kept loaded must be a whole number between 1 and 20';
  }
  const sessionsKeepAlive = Number(draft.sessionsKeepAliveHours);
  if (
    !Number.isFinite(sessionsKeepAlive) ||
    sessionsKeepAlive < 0 ||
    sessionsKeepAlive > 168
  ) {
    errors.sessionsKeepAliveHours =
      'Keep hidden Cloud sessions live for must be between 0 and 168 hours';
  }
  const claudeAutoArchive = Number(draft.claudeAutoArchiveDays);
  if (
    !Number.isInteger(claudeAutoArchive) ||
    claudeAutoArchive < 0 ||
    claudeAutoArchive > 365
  ) {
    errors.claudeAutoArchiveDays =
      'Auto-archive Claude sessions must be a whole number between 0 and 365 days';
  }
  const claudeKeepAlive = Number(draft.claudeKeepAliveMinutes);
  if (!Number.isInteger(claudeKeepAlive) || claudeKeepAlive < 1 || claudeKeepAlive > 240) {
    errors.claudeKeepAliveMinutes =
      'Claude keep-alive must be a whole number between 1 and 240 minutes';
  }
  const claudeMaxLive = Number(draft.claudeMaxLiveAgents);
  if (!Number.isInteger(claudeMaxLive) || claudeMaxLive < 1 || claudeMaxLive > 10) {
    errors.claudeMaxLiveAgents =
      'Max live Claude agents must be a whole number between 1 and 10';
  }
  for (const [index, rule] of draft.linkRules.entries()) {
    const pattern = rule.pattern.trim();
    if (!pattern) {
      errors.linkRules = `Rule ${index + 1}: pattern is required`;
      break;
    }
    const invalid = validateLinkRule({ kind: rule.kind, pattern });
    if (invalid) {
      errors.linkRules = `Rule ${index + 1}: ${invalid}`;
      break;
    }
  }
  // https only (sub-path allowed); stored normalised (no trailing slash).
  const openhandsBaseUrl = normalizeBaseUrl(draft.openhandsBaseUrl);
  if (openhandsBaseUrl === null) {
    errors.openhandsBaseUrl = 'OpenHands URL must be an https URL';
  }
  const openhandsPoll = Number(draft.openhandsPollSeconds);
  if (!Number.isInteger(openhandsPoll) || openhandsPoll < 10 || openhandsPoll > 600) {
    errors.openhandsPollSeconds =
      'OpenHands check interval must be a whole number between 10 and 600 seconds';
  }
  const openhandsMaxLive = Number(draft.openhandsMaxLiveViews);
  if (!Number.isInteger(openhandsMaxLive) || openhandsMaxLive < 1 || openhandsMaxLive > 20) {
    errors.openhandsMaxLiveViews =
      'OpenHands conversations kept loaded must be a whole number between 1 and 20';
  }
  const openhandsKeepAlive = Number(draft.openhandsKeepAliveHours);
  if (!Number.isInteger(openhandsKeepAlive) || openhandsKeepAlive < 0 || openhandsKeepAlive > 168) {
    errors.openhandsKeepAliveHours =
      'Keep hidden OpenHands conversations live for must be a whole number between 0 and 168 hours';
  }
  const localPickerFolder = draft.localPickerFolder.trim();
  const claudePickerFolder = draft.claudePickerFolder.trim();
  if (localPickerFolder && !isAbsolutePickerPath(localPickerFolder)) {
    errors.localPickerFolder = 'Enter an absolute folder path';
  }
  if (claudePickerFolder && !isAbsolutePickerPath(claudePickerFolder)) {
    errors.claudePickerFolder = 'Enter an absolute folder path';
  }
  const chromeProfile = draft.favoritesChromeProfile;
  if (chromeProfile && !isValidProfileDir(chromeProfile)) {
    errors.favoritesChromeProfile = 'Choose a Chrome profile from the list';
  }
  if (Object.keys(errors).length > 0 || openhandsBaseUrl === null) return { ok: false, errors };
  return {
    ok: true,
    patch: {
      tenantUrl,
      apiBase,
      routing: {
        allowExternal: draft.allowExternal,
        rules: draft.linkRules.map((rule) => ({ ...rule, pattern: rule.pattern.trim() })),
      },
      tabs: { keepAliveHours: keepAlive, maxLiveTabs: maxLive },
      usage: { devinPollMinutes: devinPoll },
      sessions: {
        open: draft.sessionsOpen,
        maxLiveViews: sessionsMaxLive,
        keepAliveHours: sessionsKeepAlive,
      },
      terminal: { shell: draft.terminalShell.trim() },
      local: {
        devinPath: draft.devinPath.trim() || null,
        defaultWslDistro: draft.localDefaultWslDistro || null,
        defaultMode: draft.localDefaultMode.trim() || null,
        pickerFolder: localPickerFolder || null,
      },
      claude: {
        path: draft.claudePath.trim() || null,
        autoArchiveDays: claudeAutoArchive,
        defaultPermissionMode: draft.claudePermissionMode,
        model: draft.claudeModel.trim() || null,
        keepAliveMinutes: claudeKeepAlive,
        maxLiveAgents: claudeMaxLive,
        defaultWslDistro: draft.claudeDefaultWslDistro || null,
        pickerFolder: claudePickerFolder || null,
      },
      openhands: {
        baseUrl: openhandsBaseUrl,
        pollSeconds: openhandsPoll,
        maxLiveViews: openhandsMaxLive,
        keepAliveHours: openhandsKeepAlive,
      },
      notifications: { userId: draft.userId.trim(), orgId: draft.orgId.trim() },
      favorites: { chromeProfile: chromeProfile || null },
    },
  };
}

const PATH_TO_FIELD: Record<string, DraftField> = {
  tenantUrl: 'tenantUrl',
  apiBase: 'apiBase',
  'routing.allowExternal': 'allowExternal',
  'routing.rules': 'linkRules',
  'tabs.keepAliveHours': 'keepAliveHours',
  'tabs.maxLiveTabs': 'maxLiveTabs',
  'usage.devinPollMinutes': 'usageDevinPollMinutes',
  'sessions.open': 'sessionsOpen',
  'sessions.maxLiveViews': 'sessionsMaxLiveViews',
  'sessions.keepAliveHours': 'sessionsKeepAliveHours',
  'terminal.shell': 'terminalShell',
  'local.devinPath': 'devinPath',
  'local.defaultWslDistro': 'localDefaultWslDistro',
  'local.defaultMode': 'localDefaultMode',
  'claude.path': 'claudePath',
  'claude.autoArchiveDays': 'claudeAutoArchiveDays',
  'claude.defaultPermissionMode': 'claudePermissionMode',
  'claude.model': 'claudeModel',
  'claude.keepAliveMinutes': 'claudeKeepAliveMinutes',
  'claude.maxLiveAgents': 'claudeMaxLiveAgents',
  'claude.defaultWslDistro': 'claudeDefaultWslDistro',
  'openhands.baseUrl': 'openhandsBaseUrl',
  'openhands.pollSeconds': 'openhandsPollSeconds',
  'openhands.maxLiveViews': 'openhandsMaxLiveViews',
  'openhands.keepAliveHours': 'openhandsKeepAliveHours',
  'notifications.userId': 'userId',
  'notifications.orgId': 'orgId',
  'favorites.chromeProfile': 'favoritesChromeProfile',
};

export function fieldErrorsFromIssues(
  issues: { path: readonly PropertyKey[]; message: string }[],
): { errors: DraftErrors; other: string[] } {
  const errors: DraftErrors = {};
  const other: string[] = [];
  for (const issue of issues) {
    const field = PATH_TO_FIELD[issue.path.join('.')];
    if (field) {
      errors[field] ??= issue.message;
    } else {
      other.push(issue.message);
    }
  }
  return { errors, other };
}

export function firstErrorField(errors: DraftErrors): DraftField | null {
  return FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null;
}
