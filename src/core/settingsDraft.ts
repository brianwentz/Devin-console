import { isAllowedAppUrl } from './sessions';
import { validateLinkRule } from './linkRules';
import type { LinkRule, Settings, SettingsPatch } from '../shared/ipc';

export interface SettingsDraft {
  tenantUrl: string;
  apiBase: string;
  workspaces: string[];
  allowExternal: boolean;
  keepAliveHours: string;
  maxLiveTabs: string;
  sessionsOpen: boolean;
  sessionsMaxLiveViews: string;
  sessionsKeepAliveHours: string;
  terminalAllSurfaces: boolean;
  terminalShell: string;
  claudePath: string;
  claudeAutoArchiveDays: string;
  userId: string;
  orgId: string;
  linkRules: LinkRule[];
}

export type DraftField = keyof SettingsDraft;

export type SettingsTabId = 'general' | 'links' | 'passwords' | 'notifications' | 'updates';

export const DRAFT_TAB: Record<DraftField, SettingsTabId> = {
  tenantUrl: 'general',
  apiBase: 'general',
  workspaces: 'general',
  allowExternal: 'links',
  keepAliveHours: 'general',
  maxLiveTabs: 'general',
  sessionsOpen: 'general',
  sessionsMaxLiveViews: 'general',
  sessionsKeepAliveHours: 'general',
  terminalAllSurfaces: 'general',
  terminalShell: 'general',
  claudePath: 'general',
  claudeAutoArchiveDays: 'general',
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
    workspaces: [...settings.workspaces],
    allowExternal: settings.routing.allowExternal,
    keepAliveHours: String(settings.tabs.keepAliveHours),
    maxLiveTabs: String(settings.tabs.maxLiveTabs),
    sessionsOpen: settings.sessions.open,
    sessionsMaxLiveViews: String(settings.sessions.maxLiveViews),
    sessionsKeepAliveHours: String(settings.sessions.keepAliveHours),
    terminalAllSurfaces: settings.terminal.allSurfaces,
    terminalShell: settings.terminal.shell,
    claudePath: settings.claude.path ?? '',
    claudeAutoArchiveDays: String(settings.claude.autoArchiveDays),
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
    draft.workspaces.length !== base.workspaces.length ||
    draft.workspaces.some((workspace, index) => workspace !== base.workspaces[index]) ||
    draft.allowExternal !== base.allowExternal ||
    Number(draft.keepAliveHours) !== Number(base.keepAliveHours) ||
    Number(draft.maxLiveTabs) !== Number(base.maxLiveTabs) ||
    draft.sessionsOpen !== base.sessionsOpen ||
    Number(draft.sessionsMaxLiveViews) !== Number(base.sessionsMaxLiveViews) ||
    Number(draft.sessionsKeepAliveHours) !== Number(base.sessionsKeepAliveHours) ||
    draft.terminalAllSurfaces !== base.terminalAllSurfaces ||
    draft.terminalShell.trim() !== base.terminalShell ||
    draft.claudePath.trim() !== base.claudePath ||
    Number(draft.claudeAutoArchiveDays) !== Number(base.claudeAutoArchiveDays) ||
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
      workspaces: draft.workspaces,
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
      terminal: { allSurfaces: draft.terminalAllSurfaces, shell: draft.terminalShell.trim() },
      claude: {
        path: draft.claudePath.trim() || null,
        autoArchiveDays: claudeAutoArchive,
      },
      notifications: { userId: draft.userId.trim(), orgId: draft.orgId.trim() },
    },
  };
}

const PATH_TO_FIELD: Record<string, DraftField> = {
  tenantUrl: 'tenantUrl',
  apiBase: 'apiBase',
  workspaces: 'workspaces',
  'routing.allowExternal': 'allowExternal',
  'routing.rules': 'linkRules',
  'tabs.keepAliveHours': 'keepAliveHours',
  'tabs.maxLiveTabs': 'maxLiveTabs',
  'sessions.open': 'sessionsOpen',
  'sessions.maxLiveViews': 'sessionsMaxLiveViews',
  'sessions.keepAliveHours': 'sessionsKeepAliveHours',
  'terminal.allSurfaces': 'terminalAllSurfaces',
  'terminal.shell': 'terminalShell',
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
