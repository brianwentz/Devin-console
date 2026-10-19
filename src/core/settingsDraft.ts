import { isAllowedAppUrl } from './sessions';
import { validateLinkRule } from './linkRules';
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

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(value);
}

export interface SettingsDraft {
  tenantUrl: string;
  apiBase: string;
  allowExternal: boolean;
  keepAliveHours: string;
  maxLiveTabs: string;
  sessionsOpen: boolean;
  sessionsMaxLiveViews: string;
  sessionsKeepAliveHours: string;
  terminalShell: string;
  devinPath: string;
  localDefaultWslDistro: string;
  claudePath: string;
  claudeAutoArchiveDays: string;
  claudePermissionMode: ClaudePermissionMode;
  claudeModel: string;
  claudeKeepAliveMinutes: string;
  claudeMaxLiveAgents: string;
  claudeDefaultWslDistro: string;
  userId: string;
  orgId: string;
  linkRules: LinkRule[];
}

export type DraftField = keyof SettingsDraft;

export type SettingsTabId =
  | 'general'
  | 'local'
  | 'claude'
  | 'links'
  | 'passwords'
  | 'notifications'
  | 'updates';

export const DRAFT_TAB: Record<DraftField, SettingsTabId> = {
  tenantUrl: 'general',
  apiBase: 'general',
  allowExternal: 'links',
  keepAliveHours: 'general',
  maxLiveTabs: 'general',
  sessionsOpen: 'general',
  sessionsMaxLiveViews: 'general',
  sessionsKeepAliveHours: 'general',
  terminalShell: 'general',
  devinPath: 'local',
  localDefaultWslDistro: 'local',
  claudePath: 'claude',
  claudeAutoArchiveDays: 'claude',
  claudePermissionMode: 'claude',
  claudeModel: 'claude',
  claudeKeepAliveMinutes: 'claude',
  claudeMaxLiveAgents: 'claude',
  claudeDefaultWslDistro: 'claude',
  userId: 'notifications',
  orgId: 'notifications',
  linkRules: 'links',
};

const FIELD_ORDER = Object.keys(DRAFT_TAB) as DraftField[];

export type DraftErrors = Partial<Record<DraftField, string>>;

export function draftFromSettings(settings: Settings): SettingsDraft {
  return {
    tenantUrl: settings.tenantUrl,
    apiBase: settings.apiBase,
    allowExternal: settings.routing.allowExternal,
    keepAliveHours: String(settings.tabs.keepAliveHours),
    maxLiveTabs: String(settings.tabs.maxLiveTabs),
    sessionsOpen: settings.sessions.open,
    sessionsMaxLiveViews: String(settings.sessions.maxLiveViews),
    sessionsKeepAliveHours: String(settings.sessions.keepAliveHours),
    terminalShell: settings.terminal.shell,
    devinPath: settings.local.devinPath ?? '',
    localDefaultWslDistro: settings.local.defaultWslDistro ?? '',
    claudePath: settings.claude.path ?? '',
    claudeAutoArchiveDays: String(settings.claude.autoArchiveDays),
    claudePermissionMode: settings.claude.defaultPermissionMode,
    claudeModel: settings.claude.model ?? '',
    claudeKeepAliveMinutes: String(settings.claude.keepAliveMinutes),
    claudeMaxLiveAgents: String(settings.claude.maxLiveAgents),
    claudeDefaultWslDistro: settings.claude.defaultWslDistro ?? '',
    userId: settings.notifications.userId,
    orgId: settings.notifications.orgId,
    linkRules: settings.routing.rules.map((rule) => ({ ...rule })),
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
    draft.sessionsOpen !== base.sessionsOpen ||
    Number(draft.sessionsMaxLiveViews) !== Number(base.sessionsMaxLiveViews) ||
    Number(draft.sessionsKeepAliveHours) !== Number(base.sessionsKeepAliveHours) ||
    draft.terminalShell.trim() !== base.terminalShell ||
    draft.devinPath.trim() !== base.devinPath ||
    draft.localDefaultWslDistro !== base.localDefaultWslDistro ||
    draft.claudePath.trim() !== base.claudePath ||
    Number(draft.claudeAutoArchiveDays) !== Number(base.claudeAutoArchiveDays) ||
    draft.claudePermissionMode !== base.claudePermissionMode ||
    draft.claudeModel.trim() !== base.claudeModel ||
    Number(draft.claudeKeepAliveMinutes) !== Number(base.claudeKeepAliveMinutes) ||
    Number(draft.claudeMaxLiveAgents) !== Number(base.claudeMaxLiveAgents) ||
    draft.claudeDefaultWslDistro !== base.claudeDefaultWslDistro ||
    draft.userId.trim() !== base.userId ||
    draft.orgId.trim() !== base.orgId ||
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
  if (Object.keys(errors).length > 0) return { ok: false, errors };
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
      sessions: {
        open: draft.sessionsOpen,
        maxLiveViews: sessionsMaxLive,
        keepAliveHours: sessionsKeepAlive,
      },
      terminal: { shell: draft.terminalShell.trim() },
      local: {
        devinPath: draft.devinPath.trim() || null,
        defaultWslDistro: draft.localDefaultWslDistro || null,
      },
      claude: {
        path: draft.claudePath.trim() || null,
        autoArchiveDays: claudeAutoArchive,
        defaultPermissionMode: draft.claudePermissionMode,
        model: draft.claudeModel.trim() || null,
        keepAliveMinutes: claudeKeepAlive,
        maxLiveAgents: claudeMaxLive,
        defaultWslDistro: draft.claudeDefaultWslDistro || null,
      },
      notifications: { userId: draft.userId.trim(), orgId: draft.orgId.trim() },
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
  'sessions.open': 'sessionsOpen',
  'sessions.maxLiveViews': 'sessionsMaxLiveViews',
  'sessions.keepAliveHours': 'sessionsKeepAliveHours',
  'terminal.shell': 'terminalShell',
  'local.devinPath': 'devinPath',
  'local.defaultWslDistro': 'localDefaultWslDistro',
  'claude.path': 'claudePath',
  'claude.autoArchiveDays': 'claudeAutoArchiveDays',
  'claude.defaultPermissionMode': 'claudePermissionMode',
  'claude.model': 'claudeModel',
  'claude.keepAliveMinutes': 'claudeKeepAliveMinutes',
  'claude.maxLiveAgents': 'claudeMaxLiveAgents',
  'claude.defaultWslDistro': 'claudeDefaultWslDistro',
  'notifications.userId': 'userId',
  'notifications.orgId': 'orgId',
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
