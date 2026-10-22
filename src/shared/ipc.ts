import { z } from 'zod';
import { DEFAULT_PANE_FRACTION, DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT } from '../core/layout';
import { NotificationSourceSchema, PROVIDER_SURFACES } from '../core/providers';
import { isAllowedAppUrl } from '../core/sessions';
import { RESERVED_SSH_ALIAS_MESSAGE, SSH_ALIAS_CANONICAL_RE, isReservedSshAlias } from '../core/execHost';

// Execution hosts: 'local' is this machine, 'wsl:<distro>' runs inside WSL,
// 'ssh:<alias>' on a remote machine reached through ssh.exe (canonical,
// lower-case alias — OpenSSH matches Host patterns case-insensitively).
export const HostIdSchema = z.string().regex(/^(local|wsl:[A-Za-z0-9._-]+|ssh:[a-z0-9._][a-z0-9._-]*)$/);
export type HostId = z.infer<typeof HostIdSchema>;

// Per-host status pushed to the shell (never carries env values or paths in
// the log-safe fields beyond what the user configured).
export const HostStatusSchema = z.object({
  id: HostIdSchema,
  kind: z.enum(['local', 'wsl', 'ssh']),
  label: z.string(),
  state: z.enum(['ready', 'probing', 'stopped', 'disabled', 'error']),
  error: z.string().nullable(),
  probedAt: z.string().nullable(),
  home: z.string().nullable(),
  shell: z.string().nullable(),
  /** Node version from the probe line; null when the distro has no Node. */
  node: z.string().nullable(),
  claude: z.object({ path: z.string().nullable(), version: z.string().nullable() }),
  devin: z.object({ path: z.string().nullable() }),
  shellEnv: z.object({ ok: z.boolean(), count: z.number().int(), ms: z.number() }).nullable(),
  hooks: z.enum(['ok', 'unreachable', 'untested']),
  gh: z.boolean(),
  /** Remote helper (WSL / SSH); absent while no helper bundle ships or for the local host. */
  helper: z
    .object({
      state: z.enum(['absent', 'starting', 'ready', 'reconnecting', 'degraded', 'node-missing', 'unsupported-node']),
      watchMode: z.enum(['watch', 'poll']).nullable(),
    })
    .optional(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;

export const IpcChannels = {
  stateGet: 'state:get',
  stateUpdate: 'state:update',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsCommit: 'settings:commit',
  settingsFlush: 'settings:flush',
  settingsFlushDone: 'settings:flushDone',
  paneToggle: 'pane:toggle',
  tabActivate: 'tab:activate',
  tabClose: 'tab:close',
  tabReorder: 'tab:reorder',
  tabsCloseScope: 'tabs:closeScope',
  tabsListScopes: 'tabs:listScopes',
  tabsReloadMenu: 'tabs:reloadMenu',
  tabsTabMenu: 'tabs:tabMenu',
  navAction: 'nav:action',
  surfaceSet: 'surface:set',
  linkOpen: 'link:open',
  layoutDragStart: 'layout:dragStart',
  layoutDragMove: 'layout:dragMove',
  layoutDragEnd: 'layout:dragEnd',
  layoutDragCancel: 'layout:dragCancel',
  layoutDragReset: 'layout:dragReset',
  credentialsList: 'credentials:list',
  credentialsSave: 'credentials:save',
  credentialsUpdate: 'credentials:update',
  credentialsDelete: 'credentials:delete',
  credentialsReveal: 'credentials:reveal',
  // Autofill: hosted views ask for accounts/fills; the shell drives the picker.
  autofillQuery: 'autofill:query',
  autofillPicker: 'autofill:picker',
  autofillFill: 'autofill:fill',
  autofillPick: 'autofill:pick',
  autofillPickerClose: 'autofill:pickerClose',
  autofillSubmitted: 'autofill:submitted',
  autofillPromptResolve: 'autofill:promptResolve',
  // P5 extras
  secretsHasPat: 'secrets:hasPat',
  secretsSetPat: 'secrets:setPat',
  secretsClearPat: 'secrets:clearPat',
  prsList: 'prs:list',
  prsMarkRead: 'prs:markRead',
  prsMarkAllRead: 'prs:markAllRead',
  prsRemove: 'prs:remove',
  prsClear: 'prs:clear',
  prsOpen: 'prs:open',
  prsPanel: 'prs:panel',
  // P6 notification center
  notificationsList: 'notifications:list',
  notificationsMarkRead: 'notifications:markRead',
  notificationsMarkAllRead: 'notifications:markAllRead',
  notificationsRemove: 'notifications:remove',
  notificationsClear: 'notifications:clear',
  notificationsOpen: 'notifications:open',
  notificationsPanel: 'notifications:panel',
  notificationBanner: 'notifications:banner',
  // Service-user identity resolution
  notificationsIdentity: 'notifications:identity',
  notificationsIdentityReset: 'notifications:identityReset',
  // App version / auto-update status
  updateInstall: 'update:install',
  updateCheck: 'update:check',
  updateReleaseNotes: 'update:releaseNotes',
  localState: 'local:state',
  localUpdate: 'local:update',
  localWorkspaceAdd: 'local:workspace:add',
  localWorkspaceRemove: 'local:workspace:remove',
  localWorkspacePick: 'local:workspace:pick',
  localSessionNew: 'local:session:new',
  localSessionList: 'local:session:list',
  localSessionLoad: 'local:session:load',
  localSessionDelete: 'local:session:delete',
  localSessionDeleteAll: 'local:session:deleteAll',
  localPrompt: 'local:prompt',
  localCancel: 'local:cancel',
  localPermission: 'local:permission',
  localOpenLink: 'local:openLink',
  localActiveSession: 'local:activeSession',
  localWorkspaceReorder: 'local:workspaceReorder',
  localSessionReorder: 'local:sessionReorder',
  localWorkspaceRename: 'local:workspaceRename',
  localContextMenu: 'local:contextMenu',
  claudeWorkspaceAdd: 'claude:workspaceAdd',
  // Analytics Claude tab: usage state (invoke), refresh (invoke), visibility
  // (send) and the pushed state channel.
  analyticsRefresh: 'analytics:refresh',
  // Devin Cloud usage metric: pull-refresh (send, no payload).
  devinUsageRefresh: 'devin:usageRefresh',
  claudeUsageState: 'claude:usageState',
  claudeUsageRefresh: 'claude:usageRefresh',
  claudeUsageVisible: 'claude:usageVisible',
  claudeUsage: 'claude:usage',
  claudeWorkspaceReorder: 'claude:workspaceReorder',
  claudeSessionReorder: 'claude:sessionReorder',
  claudeWorkspaceRename: 'claude:workspaceRename',
  claudeWorkspaceRemove: 'claude:workspaceRemove',
  // P4b: embedded terminal per workspace
  terminalOpen: 'terminal:open',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  // F5: tabbed shell-terminal dock
  terminalList: 'terminal:list',
  terminalTitle: 'terminal:title',
  terminalToggle: 'terminal:toggle',
  terminalActivate: 'terminal:activate',
  terminalCwdOptions: 'terminal:cwdOptions',
  terminalProfiles: 'terminal:profiles',
  // Terminal copy/paste via the main-process Electron clipboard.
  clipboardReadText: 'clipboard:readText',
  clipboardWriteText: 'clipboard:writeText',
  // Cloud session sidebar
  cloudOpen: 'cloud:open',
  cloudRefresh: 'cloud:refresh',
  cloudLoadMore: 'cloud:loadMore',
  cloudPanel: 'cloud:panel',
  cloudPrefetch: 'cloud:prefetch',
  // Cloud sidebar mutations (folders, archive, context menus).
  cloudFolderCreate: 'cloud:folderCreate',
  cloudFolderRename: 'cloud:folderRename',
  cloudFolderDelete: 'cloud:folderDelete',
  cloudFolderReorder: 'cloud:folderReorder',
  cloudSessionMove: 'cloud:sessionMove',
  cloudSessionReorder: 'cloud:sessionReorder',
  dialogPickFolder: 'dialog:pickFolder',
  cloudSessionArchive: 'cloud:sessionArchive',
  cloudCopyLink: 'cloud:copyLink',
  cloudContextMenu: 'cloud:contextMenu',
  cloudShowArchived: 'cloud:showArchived',
  cloudNewSession: 'cloud:newSession',
  // Claude session sidebar (list + local mutations, no newSession).
  claudeOpen: 'claude:open',
  claudeRefresh: 'claude:refresh',
  claudeRename: 'claude:rename',
  claudeFork: 'claude:fork',
  claudeSessionPin: 'claude:sessionPin',
  claudeSessionArchive: 'claude:sessionArchive',
  claudeSessionRemove: 'claude:sessionRemove',
  claudeSessionDeleteTranscript: 'claude:sessionDeleteTranscript',
  claudeRevealTranscript: 'claude:revealTranscript',
  claudeShowArchived: 'claude:showArchived',
  claudeContextMenu: 'claude:contextMenu',
  // Claude chat: SDK-backed chat per session.
  claudeChatState: 'claude:chatState',
  claudeChatUpdate: 'claude:chatUpdate',
  claudeNewSession: 'claude:newSession',
  claudePrompt: 'claude:prompt',
  claudeCancel: 'claude:cancel',
  claudePermission: 'claude:permission',
  claudeSetPermissionMode: 'claude:setPermissionMode',
  claudeSetModel: 'claude:setModel',
  claudeLoadHistory: 'claude:loadHistory',
  // Claude background agents.
  claudeAgentStop: 'claude:agentStop',
  claudeAgentsRefresh: 'claude:agentsRefresh',
  // Claude subagent transcripts (read-only).
  claudeSubagents: 'claude:subagents',
  claudeOpenSubagent: 'claude:openSubagent',
  claudeRecheckEnv: 'claude:recheckEnv',
  // Execution hosts (WSL): enumerate/probe and enable/disable.
  hostsRefresh: 'hosts:refresh',
  hostsSetEnabled: 'hosts:setEnabled',
  // P3: ssh hosts + the in-app remote folder input.
  hostsSshAdd: 'hosts:sshAdd',
  hostsSshRemove: 'hosts:sshRemove',
  hostsReaddir: 'hosts:readdir',
  hostsFolderPromptResolve: 'hosts:folderPromptResolve',
  // Taskbar badge: main asks the shell to render, the shell sends back a PNG.
  badgeRender: 'badge:render',
  badgeRendered: 'badge:rendered',
} as const;

export const BadgeRenderSchema = z.object({
  count: z.number().int().min(0).max(99),
  size: z.number().int().min(16).max(64),
});
export type BadgeRender = z.infer<typeof BadgeRenderSchema>;
export const BadgeRenderedSchema = z.object({
  dataUrl: z.string().regex(/^data:image\/png;base64,/).max(200_000).nullable(),
});

export const SurfaceSchema = z.enum([...PROVIDER_SURFACES, 'settings', 'analytics']);
export type Surface = z.infer<typeof SurfaceSchema>;

// User-configurable URL rules: matching links open as GitHub-pane tabs.
export const LinkRuleSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['prefix', 'regex']),
  pattern: z.string().min(1).max(512),
  enabled: z.boolean(),
});
export type LinkRule = z.infer<typeof LinkRuleSchema>;
const RoutingFields = {
  allowExternal: z.boolean(),
  rules: z.array(LinkRuleSchema).max(100),
};
// F2: the pane split is a fraction of (windowWidth - rail - splitter), 0..1.
const PaneFields = { open: z.boolean(), fraction: z.number().min(0).max(1) };
// F2: window bounds remembered per display configuration (key = display geometry).
const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});
export const PlacementSchema = z.object({
  bounds: RectSchema,
  maximized: z.boolean(),
  savedAt: z.number().finite(),
});
const WindowPlacementsSchema = z.record(z.string(), PlacementSchema);
// P5: orgId overrides the org resolved from GET /v3/self (empty = auto).
// P6: notification center settings. `collect` gates derive+store, `banner` the
// title-bar toast; `kinds` per-kind toggles (finished off by default).
const NotificationKindFields = {
  waiting: z.boolean(),
  approval: z.boolean(),
  blocked: z.boolean(),
  finished: z.boolean(),
  prOpened: z.boolean(),
  prCompleted: z.boolean(),
  update: z.boolean(),
  usage: z.boolean(),
};
const NotificationsFields = {
  orgId: z.string().max(128),
  // Manual user-id override for service-user tokens ('' = detect automatically).
  userId: z.string().max(128),
  collect: z.boolean(),
  banner: z.boolean(),
  kinds: z.object({
    waiting: NotificationKindFields.waiting.default(true),
    approval: NotificationKindFields.approval.default(true),
    blocked: NotificationKindFields.blocked.default(true),
    finished: NotificationKindFields.finished.default(false),
    prOpened: NotificationKindFields.prOpened.default(true),
    prCompleted: NotificationKindFields.prCompleted.default(true),
    update: NotificationKindFields.update.default(true),
    usage: NotificationKindFields.usage.default(true),
  }),
};
// Usage alerts (Devin Cloud monthly ACUs + Claude limits): poll cadence.
const UsageFields = { devinPollMinutes: z.number().int().min(5).max(240) };
// F1: open a background tab (in the session's scope) when the poller sees a new PR.
const PrsFields = { autoOpenTabs: z.boolean() };
// ux3 S0: manual session order per section (path/folder key -> session ids).
const SessionOrderSchema = z.record(
  z.string().max(1024),
  z.array(z.string().max(128)).max(500),
);
const LocalFields = {
  devinPath: z.string().nullable(),
  defaultWslDistro: z.string().max(128).nullable(),
  // Free string: the mode list is agent-defined (devin acp advertises e.g.
  // 'accept-edits'/'plan'). null = agent's own default.
  defaultMode: z.string().min(1).max(64).nullable(),
  workspaceLabels: z.record(z.string(), z.string().max(128)),
  collapsedWorkspaces: z.array(z.string().max(1024)).max(200),
  sessionOrder: SessionOrderSchema,
  // ux3 S3: where the Add-workspace folder picker opens (null = distro default).
  pickerFolder: z.string().max(1024).nullable(),
};
// P8: session-scoped tabs. keepAliveHours=0 discards hidden-scope tabs on switch;
// maxLiveTabs caps live webContents across all scopes (the visible active tab excluded).
const TabsFields = {
  keepAliveHours: z.number().min(0).max(168),
  maxLiveTabs: z.number().int().min(1).max(40),
};
// F5: docked terminal layout state (persisted via syncFromState) and the
// opt-in to show it on non-Cloud surfaces.
const LayoutFields = {
  terminalOpen: z.boolean(),
  terminalHeight: z.number().min(MIN_TERMINAL_HEIGHT),
};
// Cloud session sidebar: open/width are persisted via syncFromState;
// collapsedFolders is patched by the shell through settings:set/commit.
const SessionsFields = {
  open: z.boolean(),
  width: z.number().int().min(200).max(480),
  collapsedFolders: z.array(z.string().max(256)).max(200),
  // Pooled Cloud views: how many session views stay loaded, and for how long.
  maxLiveViews: z.number().int().min(1).max(20),
  keepAliveHours: z.number().min(0).max(168),
  sessionOrder: SessionOrderSchema,
};
// Claude session sidebar: local Claude Code registry settings.
const ClaudeFields = {
  path: z.string().nullable(),
  collapsedFolders: z.array(z.string().max(256)).max(200),
  showArchived: z.boolean(),
  autoArchiveDays: z.number().int().min(0).max(365),
  defaultPermissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']),
  model: z.string().max(200).nullable(),
  keepAliveMinutes: z.number().int().min(1).max(240),
  maxLiveAgents: z.number().int().min(1).max(10),
  lastSessionId: z.string().nullable(),
  // Global opt-in: write our http hooks into <configDir>/settings.json so
  // sessions started from other terminals report activity too.
  hooksEnabled: z.boolean(),
  // ux2 D8: path-bound workspace list for the Claude session column.
  workspaces: z.array(z.string().max(1024)).max(200),
  workspaceLabels: z.record(z.string(), z.string().max(128)),
  defaultWslDistro: z.string().max(128).nullable(),
  sessionOrder: SessionOrderSchema,
  // ux3 S3: where Claude's folder pickers open (null = distro default).
  pickerFolder: z.string().max(1024).nullable(),
};
const TerminalFields = {
  // Optional command line override for dock shells ('' = Windows Terminal
  // default profile, else PowerShell).
  shell: z.string().max(1024),
};
// Analytics surface: which tab the column shows (Claude usage panel vs the
// hosted tenant analytics view).
const AnalyticsFields = {
  tab: z.enum(['devin', 'claude']),
};

// Analytics Claude tab — pushed state (see plans/analytics-claude.md §3).
export const ClaudeUsageLimitSchema = z.object({
  kind: z.enum(['session', 'weekly_all', 'weekly_scoped', 'other']),
  label: z.string(),
  percent: z.number().min(0).max(100),
  severity: z.enum(['normal', 'warning', 'critical']),
  resetsAt: z.string().nullable(), // ISO
  active: z.boolean(),
});
export type ClaudeUsageLimit = z.infer<typeof ClaudeUsageLimitSchema>;
export const ClaudeUsageAccountSchema = z.object({
  email: z.string().nullable(),
  organization: z.string().nullable(),
  plan: z.string().nullable(), // subscriptionType
  hosts: z.array(HostIdSchema), // hosts signed into this account
  limits: z.array(ClaudeUsageLimitSchema),
  credits: z
    .object({
      enabled: z.boolean(),
      usedMinor: z.number(),
      limitMinor: z.number().nullable(),
      currency: z.string(),
      percent: z.number().nullable(),
    })
    .nullable(),
  fetchedAt: z.string().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
});
export type ClaudeUsageAccount = z.infer<typeof ClaudeUsageAccountSchema>;
export const ClaudeTokenTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  messages: z.number(),
});
export type ClaudeTokenTotals = z.infer<typeof ClaudeTokenTotalsSchema>;
export const ClaudeUsageStateSchema = z.object({
  status: z.enum(['idle', 'loading', 'ready', 'error']),
  accounts: z.array(ClaudeUsageAccountSchema), // [] → per-token plan / not signed in
  perToken: z.boolean(), // no OAuth creds on any host
  month: z.string(), // 'yyyy-mm' (local)
  tokens: z.object({
    total: ClaudeTokenTotalsSchema,
    byModel: z.record(z.string(), ClaudeTokenTotalsSchema),
    byHost: z.record(z.string(), ClaudeTokenTotalsSchema),
    byDay: z.array(
      z.object({
        date: z.string(),
        byModel: z.record(z.string(), z.number()),
      }),
    ),
    previousMonthTotal: ClaudeTokenTotalsSchema.nullable(),
    scannedAt: z.string().nullable(),
    scanning: z.object({ files: z.number(), done: z.number() }).nullable(),
  }),
});
export type ClaudeUsageState = z.infer<typeof ClaudeUsageStateSchema>;
// Send arg for claude:usageVisible — the shell reports Claude-tab visibility.
export const ClaudeUsageVisibleArg = z.object({ visible: z.boolean() });

// Devin Cloud usage metric — rides ShellState.usage.devin (no pushed store).
export const DevinUsageStateSchema = z.object({
  status: z.enum(['idle', 'ready', 'login-required', 'error']),
  tierName: z.string().nullable(),
  cycleUsage: z.number().nullable(),
  cycleLimit: z.number().nullable(),
  estimatedCycleUsage: z.number().nullable(),
  cycleStart: z.string().nullable(),
  cycleEnd: z.string().nullable(),
  percent: z.number().nullable(),
  fetchedAt: z.string().nullable(), // ISO of the body shown (cached body's time when stale)
  stale: z.boolean(),
  error: z.string().nullable(),
  nextPollAt: z.string().nullable(),
});
export type DevinUsageState = z.infer<typeof DevinUsageStateSchema>;
// P3 ssh host entry: canonical (lower-case) alias, never a reserved name.
const SshHostEntrySchema = z.object({
  alias: z
    .string()
    .max(128)
    .regex(SSH_ALIAS_CANONICAL_RE)
    .refine((alias) => !isReservedSshAlias(alias), RESERVED_SSH_ALIAS_MESSAGE),
  enabled: z.boolean(),
});

/** Fix round 1 M4: aliases are lower-cased and only malformed entries (and
 * later duplicates) drop — one bad entry never costs the whole list. The
 * dropped raw entries stay in settings.json (core/settings.ts serialize). */
export function sanitizeSshHostList(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const seen = new Set<string>();
  const out: { alias: string; enabled: boolean }[] = [];
  for (const entry of raw) {
    const parsed = canonicalSshHostEntry(entry);
    if (!parsed || seen.has(parsed.alias)) continue;
    seen.add(parsed.alias);
    out.push(parsed);
  }
  return out;
}

/** One raw entry → its canonical form, or null when malformed. */
export function canonicalSshHostEntry(entry: unknown): { alias: string; enabled: boolean } | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const { alias, enabled } = entry as { alias?: unknown; enabled?: unknown };
  const parsed = SshHostEntrySchema.safeParse({
    alias: typeof alias === 'string' ? alias.trim().toLowerCase() : alias,
    enabled,
  });
  return parsed.success ? parsed.data : null;
}

/** Patch form (settings:set/commit): aliases are canonicalised but nothing is
 * dropped — a malformed or reserved alias fails the patch with its message. */
const SshHostListPatchSchema = z.preprocess(
  (raw) =>
    Array.isArray(raw)
      ? raw.map((entry: unknown) =>
          typeof entry === 'object' && entry !== null && typeof (entry as { alias?: unknown }).alias === 'string'
            ? { ...entry, alias: (entry as { alias: string }).alias.trim().toLowerCase() }
            : entry,
        )
      : raw,
  z.array(SshHostEntrySchema).max(50),
);

// Execution hosts (WSL). wslDistros: null = auto (running + default);
// overrides: per-host path/shell/env-capture settings keyed by HostId.
const HostsFields = {
  wslEnabled: z.boolean(),
  wslDistros: z.array(z.string().max(128)).max(50).nullable(),
  overrides: z.record(
    z.string(),
    z.object({
      claudePath: z.string().max(1024).nullable().optional(),
      devinPath: z.string().max(1024).nullable().optional(),
      home: z.string().max(1024).nullable().optional(),
      shell: z.string().max(1024).nullable().optional(),
      envCaptureDisabled: z.boolean().optional(),
    }),
  ),
  // P3: ssh hosts by canonical (lower-case) ~/.ssh/config alias.
  ssh: z.preprocess(sanitizeSshHostList, z.array(SshHostEntrySchema).max(50)),
};
// F3: tenant/api URLs must be https (http allowed for localhost only).
const AppUrl = z.url().refine(isAllowedAppUrl, 'must be https (http allowed for localhost only)');
const SettingsFields = {
  tenantUrl: AppUrl,
  apiBase: AppUrl,
  workspaces: z.array(z.string()),
  surface: SurfaceSchema,
  tabSnapshot: z.unknown(),
  windowPlacements: WindowPlacementsSchema,
};

export const SettingsObject = z.object({
  tenantUrl: SettingsFields.tenantUrl.default('https://cloudbeds.devinenterprise.com'),
  apiBase: SettingsFields.apiBase.default('https://api.devin.ai'),
  workspaces: SettingsFields.workspaces.default([]),
  routing: z
    .object({
      allowExternal: RoutingFields.allowExternal.default(true),
      rules: RoutingFields.rules.default([]),
    })
    .default({ allowExternal: true, rules: [] }),
  pane: z
    .object({
      open: PaneFields.open.default(true),
      fraction: PaneFields.fraction.default(DEFAULT_PANE_FRACTION),
    })
    .default({ open: true, fraction: DEFAULT_PANE_FRACTION }),
  local: z
    .object({
      devinPath: LocalFields.devinPath.default(null),
      defaultWslDistro: LocalFields.defaultWslDistro.default(null),
      defaultMode: LocalFields.defaultMode.default(null),
      workspaceLabels: LocalFields.workspaceLabels.default({}),
      collapsedWorkspaces: LocalFields.collapsedWorkspaces.default([]),
      sessionOrder: LocalFields.sessionOrder.default({}),
      pickerFolder: LocalFields.pickerFolder.default(null),
    })
    .default({
      devinPath: null,
      defaultWslDistro: null,
      defaultMode: null,
      workspaceLabels: {},
      collapsedWorkspaces: [],
      sessionOrder: {},
      pickerFolder: null,
    }),
  surface: SettingsFields.surface.default('cloud'),
  // Tab strip snapshot (v2 shape from core/tabModel.serializeTabs).
  tabSnapshot: SettingsFields.tabSnapshot.optional(),
  windowPlacements: SettingsFields.windowPlacements.default({}),
  tabs: z
    .object({
      keepAliveHours: TabsFields.keepAliveHours.default(24),
      maxLiveTabs: TabsFields.maxLiveTabs.default(8),
    })
    .default({ keepAliveHours: 24, maxLiveTabs: 8 }),
  notifications: z
    .object({
      orgId: NotificationsFields.orgId.default(''),
      userId: NotificationsFields.userId.default(''),
      collect: NotificationsFields.collect.default(true),
      banner: NotificationsFields.banner.default(true),
      kinds: NotificationsFields.kinds.default({
        waiting: true, approval: true, blocked: true, finished: false,
        prOpened: true, prCompleted: true, update: true, usage: true,
      }),
    })
    .default({
      orgId: '', userId: '', collect: true, banner: true,
      kinds: { waiting: true, approval: true, blocked: true, finished: false, prOpened: true, prCompleted: true, update: true, usage: true },
    }),
  prs: z
    .object({ autoOpenTabs: PrsFields.autoOpenTabs.default(true) })
    .default({ autoOpenTabs: true }),
  layout: z
    .object({
      terminalOpen: LayoutFields.terminalOpen.default(false),
      terminalHeight: LayoutFields.terminalHeight.default(DEFAULT_TERMINAL_HEIGHT),
    })
    .default({ terminalOpen: false, terminalHeight: DEFAULT_TERMINAL_HEIGHT }),
  sessions: z
    .object({
      open: SessionsFields.open.default(true),
      width: SessionsFields.width.default(260),
      collapsedFolders: SessionsFields.collapsedFolders.default([]),
      maxLiveViews: SessionsFields.maxLiveViews.default(6),
      keepAliveHours: SessionsFields.keepAliveHours.default(24),
      sessionOrder: SessionsFields.sessionOrder.default({}),
    })
    .default({
      open: true,
      width: 260,
      collapsedFolders: [],
      maxLiveViews: 6,
      keepAliveHours: 24,
      sessionOrder: {},
    }),
  terminal: z
    .object({
      shell: TerminalFields.shell.default(''),
    })
    .default({ shell: '' }),
  analytics: z
    .object({ tab: AnalyticsFields.tab.default('devin') })
    .default({ tab: 'devin' }),
  usage: z
    .object({ devinPollMinutes: UsageFields.devinPollMinutes.default(15) })
    .default({ devinPollMinutes: 15 }),
  claude: z
    .object({
      path: ClaudeFields.path.default(null),
      collapsedFolders: ClaudeFields.collapsedFolders.default([]),
      showArchived: ClaudeFields.showArchived.default(false),
      autoArchiveDays: ClaudeFields.autoArchiveDays.default(0),
      defaultPermissionMode: ClaudeFields.defaultPermissionMode.default('default'),
      model: ClaudeFields.model.default(null),
      keepAliveMinutes: ClaudeFields.keepAliveMinutes.default(15),
      maxLiveAgents: ClaudeFields.maxLiveAgents.default(3),
      lastSessionId: ClaudeFields.lastSessionId.default(null),
      hooksEnabled: ClaudeFields.hooksEnabled.default(false),
      workspaces: ClaudeFields.workspaces.default([]),
      workspaceLabels: ClaudeFields.workspaceLabels.default({}),
      defaultWslDistro: ClaudeFields.defaultWslDistro.default(null),
      sessionOrder: ClaudeFields.sessionOrder.default({}),
      pickerFolder: ClaudeFields.pickerFolder.default(null),
    })
    .default({
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
    }),
  hosts: z
    .object({
      wslEnabled: HostsFields.wslEnabled.default(true),
      wslDistros: HostsFields.wslDistros.default(null),
      overrides: HostsFields.overrides.default({}),
      ssh: HostsFields.ssh.default([]),
    })
    .default({ wslEnabled: true, wslDistros: null, overrides: {}, ssh: [] }),
});

// Every field has a default or is optional, so parse({}) yields valid Settings.
export const SettingsSchema = SettingsObject;
export type Settings = z.infer<typeof SettingsSchema>;

// Patch schema built from default-free fields: absent keys stay absent.
export const SettingsPatchSchema = z.object({
  ...z.object(SettingsFields).partial().shape,
  routing: z.object(RoutingFields).partial().optional(),
  pane: z.object(PaneFields).partial().optional(),
  tabs: z.object(TabsFields).partial().optional(),
  notifications: z
    .object({ ...NotificationsFields, kinds: z.object(NotificationKindFields).partial() })
    .partial()
    .optional(),
  prs: z.object(PrsFields).partial().optional(),
  local: z.object(LocalFields).partial().optional(),
  layout: z.object(LayoutFields).partial().optional(),
  terminal: z.object(TerminalFields).partial().optional(),
  analytics: z.object(AnalyticsFields).partial().optional(),
  usage: z.object(UsageFields).partial().optional(),
  sessions: z.object(SessionsFields).partial().optional(),
  claude: z.object(ClaudeFields).partial().optional(),
  hosts: z.object({ ...HostsFields, ssh: SshHostListPatchSchema }).partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// settings:commit — field keys are DraftField names from core/settingsDraft.
export const SettingsCommitResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: SettingsSchema }),
  z.object({
    ok: z.literal(false),
    errors: z.record(z.string(), z.string()),
    message: z.string().nullable(),
  }),
]);
export type SettingsCommitResult = z.infer<typeof SettingsCommitResultSchema>;
export const SettingsFlushDoneArg = z.object({ pending: z.boolean(), ok: z.boolean() });

const TabSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  favicon: z.string().optional(),
  loading: z.boolean().optional(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  originSessionId: z.string().optional(),
  discarded: z.boolean().optional(),
});

export const IdentitySourceSchema = z.enum(['self', 'cli', 'inferred', 'manual']);
export type IdentitySource = z.infer<typeof IdentitySourceSchema>;

// P5: poller/notifier status exposed to the shell. Never contains the PAT.
export const NotificationsStateSchema = z.object({
  collect: z.boolean(),
  banner: z.boolean(),
  hasToken: z.boolean(),
  lastPollAt: z.string().nullable(),
  authError: z.boolean(),
  lastError: z.string().nullable(),
  noUserIdentity: z.boolean(),
  identity: z.object({ source: IdentitySourceSchema.nullable(), resolved: z.boolean() }),
  openPrCount: z.number().int(),
  unreadPrCount: z.number().int(),
  prsPanelOpen: z.boolean(),
  unreadCount: z.number().int(),
  panelOpen: z.boolean(),
});
// notifications:identity — the user id itself never leaves main; the shell
// only gets the source and a masked tail (user-…705c6).
export const IdentityInfoSchema = z.object({
  source: IdentitySourceSchema.nullable(),
  maskedUserId: z.string().nullable(),
  cliOrgMismatch: z.boolean(),
});
export type IdentityInfo = z.infer<typeof IdentityInfoSchema>;
export const NotificationIdArg = z.object({ id: z.string() });
export const NotificationPanelArg = z.object({ open: z.boolean() });

export type NotificationsState = z.infer<typeof NotificationsStateSchema>;

// Cloud session sidebar — token/user id never leave main; titles are present
// in state for display but must never be logged.
export const CloudSessionSchema = z.object({
  id: z.string(),
  acpId: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string(),
  statusEnum: z.string().nullable(),
  userActionRequired: z.string().nullable(),
  folder: z.string().nullable(),
  parentId: z.string().nullable(),
  isPinned: z.boolean(),
  isUnread: z.boolean(),
  isStarred: z.boolean(),
  directChildrenCount: z.number().int(),
  hasMoreChildren: z.boolean(),
  prs: z.object({
    open: z.number().int(),
    queued: z.number().int(),
    draft: z.number().int(),
    merged: z.number().int(),
    closed: z.number().int(),
  }),
  isArchived: z.boolean(),
  updatedAt: z.number().finite(),
});
export type CloudSessionState = z.infer<typeof CloudSessionSchema>;

export const CloudStateSchema = z.object({
  status: z.enum(['disabled', 'no-token', 'connecting', 'ready', 'error']),
  lastSyncAt: z.string().nullable(),
  error: z.string().nullable(),
  folders: z.array(z.string()),
  folderTotals: z.record(z.string(), z.number()),
  sessions: z.array(CloudSessionSchema),
  // Bare-hex ids of sessions with a live pooled view (for sidebar markers).
  liveSessionIds: z.array(z.string()),
  showArchived: z.boolean(),
  // Transient mutation failure; cleared by the next successful list.
  lastError: z.object({ op: z.string(), message: z.string() }).nullable(),
  // True while the displayed list came from userData/cloud-cache.json and no
  // live session/list has replaced it yet.
  cached: z.boolean(),
});
export type CloudState = z.infer<typeof CloudStateSchema>;

// Claude Code sessions (local ~/.claude registry + SDK store).
// A `claude --bg` background agent as listed by `claude agents --json --all`.
export const ClaudeAgentStatusSchema = z.enum(['running', 'completed', 'stopped', 'unknown']);
export const ClaudeAgentSchema = z.object({
  id: z.string(),
  host: HostIdSchema,
  sessionId: z.string().nullable(),
  name: z.string().nullable(),
  status: ClaudeAgentStatusSchema,
  cwd: z.string().nullable(),
  startedAt: z.number().nullable(),
});
export type ClaudeAgent = z.infer<typeof ClaudeAgentSchema>;

export const ClaudeSubagentSchema = z.object({
  agentId: z.string(),
  parentSessionId: z.string(),
  title: z.string(),
  messageCount: z.number().int().nullable(),
});
export type ClaudeSubagent = z.infer<typeof ClaudeSubagentSchema>;

export const ClaudeSessionSchema = z.object({
  id: z.string(),
  host: HostIdSchema,
  title: z.string(),
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  tag: z.string().nullable(),
  createdAt: z.number().finite().nullable(),
  updatedAt: z.number().finite(),
  folder: z.string().nullable(),
  parentId: z.string().nullable(),
  isPinned: z.boolean(),
  isArchived: z.boolean(),
  missing: z.boolean(),
  // Status of the background agent bound to this session, if any.
  agentStatus: ClaudeAgentStatusSchema.nullable(),
  // Live activity from hooks (terminal/external) or the chat host.
  activity: z.enum(['running', 'waiting']).nullable(),
  // Subagent transcripts under this session: null = not loaded yet.
  subagents: z.array(ClaudeSubagentSchema).nullable(),
  prs: z.object({
    open: z.number().int(),
    queued: z.number().int(),
    draft: z.number().int(),
    merged: z.number().int(),
    closed: z.number().int(),
  }),
});
export type ClaudeSessionState = z.infer<typeof ClaudeSessionSchema>;

export const ClaudeStateSchema = z.object({
  status: z.enum(['loading', 'ready', 'error']),
  configDir: z.string(),
  cliPath: z.string().nullable(),
  installGuidance: z.string(),
  error: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  folders: z.array(z.string()),
  sessions: z.array(ClaudeSessionSchema),
  showArchived: z.boolean(),
  // Per-host status line when a host's probe/env capture failed.
  hostErrors: z.record(HostIdSchema, z.string()),
  // Transient mutation failure; cleared by the next successful refresh.
  lastError: z.object({ op: z.string(), message: z.string() }).nullable(),
  // `claude --version` vs the CLI version the pinned SDK targets.
  versions: z.object({
    cli: z.string().nullable(),
    sdkTarget: z.string().nullable(),
    mismatch: z.boolean(),
  }),
  agents: z.array(ClaudeAgentSchema),
  // Loopback hook listener + global ~/.claude/settings.json opt-in state.
  hooks: z.object({
    port: z.number().int().nullable(),
    enabled: z.boolean(),
    installed: z.boolean(),
    error: z.string().nullable(),
  }),
  // Read-only subagent transcript shown in the chat column (null = the session itself).
  selectedSubagentId: z.string().nullable(),
});
export type ClaudeState = z.infer<typeof ClaudeStateSchema>;
export const UpdateCheckSourceSchema = z.enum([
  'startup',
  'timer',
  'settings',
  'manual',
  'resume',
  'focus',
]);
export type UpdateCheckSource = z.infer<typeof UpdateCheckSourceSchema>;

// update:check — on-demand check from the Updates tab (settings/manual only).
export const UpdateCheckArg = z.object({ source: z.enum(['settings', 'manual']) });

export const UpdateStateSchema = z.object({
  version: z.string(),
  available: z.string().nullable(),
  downloaded: z.string().nullable(),
  releasesUrl: z.string(),
  enabled: z.boolean(),
  checking: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;

// update:releaseNotes — lazy GitHub release-notes lookup for the Updates tab.
export const ReleaseNotesSchema = z.object({
  version: z.string(),
  name: z.string().nullable(),
  publishedAt: z.string().nullable(),
  body: z.string(),
  htmlUrl: z.string(),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
export const ReleaseNotesReplySchema = z.object({
  current: ReleaseNotesSchema.nullable(),
  available: ReleaseNotesSchema.nullable(),
});
export type ReleaseNotesReply = z.infer<typeof ReleaseNotesReplySchema>;

export const TerminalSummarySchema = z.object({
  id: z.string(),
  host: HostIdSchema,
  kind: z.enum(['devin', 'shell', 'claude']),
  // The local/claude session a devin- or claude-kind pty belongs to (null for shell-kind).
  sessionId: z.string().nullable().default(null),
  cwd: z.string(),
  title: z.string(),
  exitCode: z.number().int().nullable(),
  // Windows Terminal profile name when one launched this pty.
  profile: z.string().nullable().default(null),
});
export type TerminalSummary = z.infer<typeof TerminalSummarySchema>;

export const CredentialEntrySchema = z.object({
  id: z.string().min(1),
  origin: z.string(),
  username: z.string(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  lastUsedAt: z.number().finite().nullable(),
});
export type ShellCredentialEntry = z.infer<typeof CredentialEntrySchema>;

export const AutofillQuerySchema = z.object({
  hasPassword: z.boolean(),
  hint: z.string().max(256).nullable(),
});
export const AutofillPickerSchema = z.object({
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  }),
  field: z.enum(['username', 'password']),
});
export const AutofillPickSchema = z.object({ id: z.string().min(1) });
export const AutofillFillSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
  password: z.string(),
});
export const AutofillSubmittedSchema = z.object({
  username: z.string().max(256).nullable(),
  password: z.string().min(1).max(1024),
});
export const AutofillPromptResolveSchema = z.object({
  action: z.enum(['save', 'dismiss']),
});

export const ShellStateSchema = z.object({
  paneOpen: z.boolean(),
  paneFraction: z.number(),
  paneCollapsed: z.boolean(),
  sessionsOpen: z.boolean(),
  sessionsWidth: z.number(),
  sessionsCollapsed: z.boolean(),
  surface: SurfaceSchema,
  currentSessionId: z.string().nullable(),
  localSessionId: z.string().nullable(),
  settings: SettingsSchema,
  tabs: z.object({
    tabs: z.array(TabSchema), // visible scope only
    activeId: z.string().nullable(),
    scope: z.string(),
    hiddenTabCount: z.number().int(),
  }),
  credentials: z.array(CredentialEntrySchema),
  autofill: z.object({
    picker: z
      .object({
        accounts: z.array(z.object({ id: z.string(), username: z.string() })),
        anchor: RectSchema,
      })
      .nullable(),
    prompt: z
      .object({
        kind: z.enum(['save', 'update']),
        origin: z.string(),
        username: z.string(),
        anchor: RectSchema,
      })
      .nullable(),
  }),
  notifications: NotificationsStateSchema,
  usage: z.object({
    level: z.enum(['none', 'warn', 'critical']),
    items: z.array(
      z.object({
        metric: z.string(),
        accountKey: z.string(),
        label: z.string(),
        percent: z.number(),
      }),
    ),
    devin: DevinUsageStateSchema,
  }),
  cloud: CloudStateSchema,
  claude: ClaudeStateSchema,
  claudeSessionId: z.string().nullable(),
  update: UpdateStateSchema,
  // F5 terminal dock
  terminalOpen: z.boolean(),
  terminalHeight: z.number(),
  terminals: z.array(TerminalSummarySchema),
  activeTerminalId: z.string().nullable(),
  // Execution hosts known to main (local first).
  hosts: z.array(HostStatusSchema),
  // P3: the open in-app remote folder prompt (RemoteFolderInput), raised over
  // the hosted views like the notifications panel; null when closed.
  folderPrompt: z
    .object({
      id: z.string(),
      title: z.string(),
      hostId: HostIdSchema,
      /** Host-side folder the input starts in (picker folder on that host, else its home). */
      start: z.string().nullable(),
      hosts: z.array(z.object({ id: HostIdSchema, label: z.string(), home: z.string().nullable() })),
      /** Offer "This PC (browse…)" — answered with `browse: true`, continues in the native dialog. */
      browse: z.boolean(),
      /** Why the last answer was refused (missing / not a folder on the host). */
      error: z.string().nullable(),
    })
    .nullable(),
});
export type ShellState = z.infer<typeof ShellStateSchema>;

export const CredentialSaveSchema = z.object({
  origin: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});
export const CredentialUpdateSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});
export const CredentialDeleteSchema = z.object({ id: z.string().min(1) });
export const CredentialRevealSchema = z.object({ id: z.string().min(1) });

export const TabsCloseScopeArg = z.object({ scope: z.string() });
export const TabsReloadMenuArg = z.object({ x: z.number(), y: z.number() });
export const TabsTabMenuArg = z.object({ id: z.string(), x: z.number(), y: z.number() });
export interface ScopeSummary {
  scope: string;
  count: number;
  liveCount: number;
  lastSeen: number;
}

// P4b terminal channels.
export const TerminalOpenArg = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('devin'),
    workspace: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('shell'),
    cwd: z.string().min(1).max(4096).optional(),
    profile: z.string().max(128).optional(),
    // Explicit command line instead of the profile shell (e.g. `claude attach <id>`).
    command: z.array(z.string().min(1).max(512)).min(1).max(8).optional(),
  }),
  z.object({
    kind: z.literal('claude'),
    sessionId: z.string().uuid(),
    mode: z.enum(['resume', 'new', 'attach']),
    agentId: z.string().min(1).max(64).optional(),
  }),
]);
export type TerminalOpenArgType = z.infer<typeof TerminalOpenArg>;
export const TerminalTitleArg = z.object({ id: z.string().min(1), title: z.string().max(256) });
export const TerminalActivateArg = z.object({ id: z.string().min(1) });
export const TerminalInputArg = z.object({ id: z.string().min(1), data: z.string().max(65536) });
export const TerminalResizeArg = z.object({
  id: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
});
export const TerminalCloseArg = z.object({ id: z.string().min(1) });
export const ClipboardWriteArg = z.object({ text: z.string().max(65536) });

export const SessionPrSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  ref: z.string(),
  title: z.string().nullable(),
  url: z.string(),
  state: z.string().nullable(),
  readAt: z.number().nullable(),
  source: NotificationSourceSchema.default('devin'),
});
export type SessionPr = z.infer<typeof SessionPrSchema>;

export const PrUrlArg = z.object({ url: z.string().url() });
export const PrOpenArg = z.object({ sessionId: z.string().min(1), url: z.string().url() });
export const PrPanelArg = z.object({ open: z.boolean() });
export const CloudOpenArg = z.object({ sessionId: z.string().min(1).max(128) });
export const CloudPrefetchArg = z.object({ sessionId: z.string().min(1).max(128) });
export const CloudLoadMoreArg = z.object({ folder: z.string().min(1).max(256) });
export const CloudPanelArg = z.object({ open: z.boolean() });
const CloudFolderName = z.string().trim().min(1).max(100);
const CloudSessionId = z.string().min(1).max(128);
export const CloudFolderCreateArg = z.object({ name: CloudFolderName });
export const CloudFolderRenameArg = z.object({
  oldName: CloudFolderName,
  newName: CloudFolderName,
});
export const CloudFolderDeleteArg = z.object({ name: CloudFolderName });
export const CloudFolderReorderArg = z.object({
  names: z.array(CloudFolderName).max(200),
});
// ux3 S0: manual session order inside one sidebar section.
export const SessionReorderArg = z.object({
  section: z.string().max(1024),
  ids: z.array(z.string().max(128)).max(500),
});
export const DialogPickFolderArg = z.object({
  title: z.string().max(200),
  defaultPath: z.string().max(1024).optional(),
});
export const CloudSessionMoveArg = z.object({
  sessionId: CloudSessionId,
  folder: CloudFolderName.nullable(),
});
export const CloudSessionArchiveArg = z.object({
  sessionId: CloudSessionId,
  archive: z.boolean(),
});
export const CloudCopyLinkArg = z.object({ sessionId: CloudSessionId });
export const CloudContextMenuArg = z.object({
  kind: z.enum(['session', 'folder', 'header']),
  sessionId: CloudSessionId.optional(),
  name: CloudFolderName.optional(),
  x: z.number().finite(),
  y: z.number().finite(),
});
export const CloudShowArchivedArg = z.object({ value: z.boolean() });
export const CloudNewSessionArg = z.object({ folder: CloudFolderName.nullable() });

const ClaudeSessionId = z.string().uuid();
export const ClaudeOpenArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudeRenameArg = z.object({
  sessionId: ClaudeSessionId,
  title: z.string().trim().min(1).max(200),
});
export const ClaudeForkArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudeSessionPinArg = z.object({
  sessionId: ClaudeSessionId,
  pinned: z.boolean(),
});
export const ClaudeSessionArchiveArg = z.object({
  sessionId: ClaudeSessionId,
  archive: z.boolean(),
});
export const ClaudeSessionRemoveArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudeSessionDeleteTranscriptArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudeRevealTranscriptArg = z.object({ sessionId: ClaudeSessionId });
// ux2 D8: claude.workspaces mutations; path optional → folder picker.
export const ClaudeWorkspaceAddArg = z.object({
  path: z.string().min(1).max(4096).optional(),
  /** Header "Add remote workspace…": the in-app RemoteFolderInput even without a default distro. */
  remote: z.boolean().optional(),
});
export const LocalWorkspacePickArg = z.object({ remote: z.boolean().optional() });
export const ClaudeShowArchivedArg = z.object({ value: z.boolean() });
export const ClaudePermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionModeSchema>;
export const ClaudeNewSessionArg = z.object({ cwd: z.string().min(1).max(4096).nullable() });
export const ClaudePromptArg = z.object({
  sessionId: ClaudeSessionId,
  text: z.string().min(1).max(200_000),
});
export const ClaudeCancelArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudePermissionArg = z.object({
  sessionId: ClaudeSessionId,
  requestId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(256),
});
export const ClaudeSetPermissionModeArg = z.object({
  sessionId: ClaudeSessionId,
  mode: ClaudePermissionModeSchema,
});
export const ClaudeSetModelArg = z.object({
  sessionId: ClaudeSessionId,
  model: z.string().min(1).max(200).nullable(),
});
export const ClaudeLoadHistoryArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudeAgentStopArg = z.object({ agentId: z.string().min(1).max(64) });
export const ClaudeSubagentsArg = z.object({ sessionId: ClaudeSessionId });
export const ClaudeOpenSubagentArg = z.object({
  sessionId: ClaudeSessionId,
  agentId: z.string().min(1).max(128),
});
export const ClaudeRecheckEnvArg = z.object({ sessionId: ClaudeSessionId });
// hosts:refresh — re-enumerate + re-probe (all hosts when id absent).
export const HostsRefreshArg = z.object({ id: HostIdSchema.optional() });
export const HostsSetEnabledArg = z.object({ id: HostIdSchema, enabled: z.boolean() });
// hosts:sshAdd — raw user input; main validates + lower-cases it (canonicalSshAlias).
export const HostsSshAddArg = z.object({ alias: z.string().max(256) });
export const HostsSshRemoveArg = z.object({ id: HostIdSchema });
// hosts:readdir — directories under an absolute host-side (posix) path, over
// the host's helper channel (RemoteFolderInput autocomplete).
export const HostReaddirSchema = z.object({
  hostId: HostIdSchema,
  path: z.string().min(1).max(4096).startsWith('/'),
});
export type HostReaddirArg = z.infer<typeof HostReaddirSchema>;
export type HostReaddirResult = { entries: { name: string; dir: boolean }[]; truncated: boolean };
// hosts:folderPromptResolve — the open in-app folder prompt's answer: a
// host-side absolute path on one of the offered hosts, or null (cancel);
// `browse: true` = "This PC (browse…)" (native dialog instead).
export const FolderPromptResolveArg = z.object({
  id: z.string().min(1).max(64),
  hostId: HostIdSchema.optional(),
  path: z.string().min(1).max(4096).startsWith('/').nullable(),
  browse: z.literal(true).optional(),
});
export const ClaudeContextMenuArg = z.object({
  kind: z.enum(['session', 'workspace', 'header', 'agent']),
  sessionId: ClaudeSessionId.optional(),
  path: z.string().max(1024).optional(),
  agentId: z.string().min(1).max(64).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
});

// Workspace column mutations (ux2 D7/D8); handlers land with the sidebar work.
export const WorkspaceReorderSchema = z.object({
  paths: z.array(z.string().max(1024)).max(200),
});
export const WorkspaceRenameSchema = z.object({
  path: z.string().max(1024),
  label: z.string().min(1).max(128),
});
export const LocalContextMenuRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), path: z.string().max(1024), x: z.number().finite(), y: z.number().finite() }),
  z.object({ kind: z.literal('session'), sessionId: z.string(), x: z.number().finite(), y: z.number().finite() }),
  z.object({ kind: z.literal('header'), x: z.number().finite(), y: z.number().finite() }),
]);
export const LocalContextMenuResultSchema = z.object({ action: z.string().nullable() });
export type LocalContextMenuRequest = z.infer<typeof LocalContextMenuRequestSchema>;
export type LocalContextMenuResult = z.infer<typeof LocalContextMenuResultSchema>;

// Arg schemas for ipcMain.on channels (safeParse; invalid payloads ignored).
export const TabIdArg = z.string();
export const TabReorderArgs = z.tuple([z.string(), z.number().int()]);
export const NavActionArg = z.enum(['back', 'forward', 'reload']);
export const SurfaceArg = SurfaceSchema;
export const LinkOpenArg = z.string().max(8192);
export const DragPosArg = z.number().finite();
export const DragStartArg = z.object({
  axis: z.enum(['x', 'y', 's']),
  pos: z.number().finite(),
});
export const DragCancelReasonArg = z.enum(['escape', 'pointer-cancel']);
// P5: secrets:setPat payload. The value itself is never logged or echoed back.
export const SetPatArg = z.object({ pat: z.string().min(10).max(4096) });

// ---- Devin Local (ACP) ----

const LocalBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thought'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string() }),
]);

const LocalMessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  blocks: z.array(LocalBlockSchema),
  messageId: z.string().optional(),
});

const LocalToolCallSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  content: z.array(z.unknown()).optional(),
  locations: z.array(z.object({ path: z.string(), line: z.number().nullable().optional() })).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

const LocalPlanEntrySchema = z.object({
  content: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

const LocalPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string(),
  title: z.string(),
  options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() })),
});

export const LocalStopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
  'error',
]);

// Chat session shared by Devin Local and Claude: everything but the
// source-specific identity fields (Local adds `workspace`, Claude adds `cwd`…).
const ChatSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  messages: z.array(LocalMessageSchema),
  plan: z.array(LocalPlanEntrySchema).optional(),
  toolCalls: z.record(z.string(), LocalToolCallSchema),
  pendingPermission: LocalPermissionSchema.optional(),
  running: z.boolean(),
  lastStopReason: LocalStopReasonSchema.optional(),
  terminalOwned: z.boolean().optional(),
  promptStartedAt: z.string().optional(),
  lastTurnMs: z.number().optional(),
  usage: z
    .object({
      used: z.number().nullable(),
      size: z.number().nullable(),
      totalTokens: z.number().nullable(),
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      thoughtTokens: z.number().nullable(),
      cachedReadTokens: z.number().nullable(),
      cachedWriteTokens: z.number().nullable(),
      // Cumulative USD cost reported by the Claude SDK (null for Devin).
      costUsd: z.number().nullable().default(null),
    })
    .optional(),
  error: z.string().optional(),
  historySource: z.enum(['agent', 'local-index']),
  loaded: z.boolean(),
  // ACP session modes advertised by session/new|load (agent-defined list).
  modes: z
    .object({
      currentModeId: z.string(),
      availableModes: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .optional(),
});
export type ChatSessionPublic = z.infer<typeof ChatSessionSchema>;

const LocalSessionSchema = ChatSessionSchema.extend({ workspace: z.string() });

export const ClaudeChatSessionSchema = ChatSessionSchema.extend({
  host: HostIdSchema.default('local'),
  cwd: z.string(),
  permissionMode: ClaudePermissionModeSchema,
  model: z.string().nullable(),
  // Whether an SDK query is open for this session.
  live: z.enum(['idle', 'starting', 'live', 'stopped']),
});
export type ClaudeChatSessionPublic = z.infer<typeof ClaudeChatSessionSchema>;
export const ClaudeChatStateSchema = z.object({
  sessions: z.record(z.string(), ClaudeChatSessionSchema),
  // Read-only subagent transcripts keyed `<sessionId>/<agentId>`.
  subagentSessions: z.record(z.string(), ClaudeChatSessionSchema).default({}),
});
export type ClaudeChatStatePublic = z.infer<typeof ClaudeChatStateSchema>;

const LocalAgentSchema = z.object({
  workspace: z.string(),
  status: z.enum(['missing-cli', 'starting', 'ready', 'crashed', 'stopped']),
  protocolVersion: z.number().optional(),
  capabilities: z
    .object({ loadSession: z.boolean(), sessionList: z.boolean(), sessionDelete: z.boolean() })
    .optional(),
  agentName: z.string().optional(),
  error: z.string().optional(),
  restarts: z.number(),
  retryInMs: z.number().optional(),
});

export const LocalStateSchema = z.object({
  cliPath: z.string().nullable(),
  installGuidance: z.string(),
  agents: z.record(z.string(), LocalAgentSchema),
  sessions: z.record(z.string(), LocalSessionSchema),
});
export type LocalStatePublic = z.infer<typeof LocalStateSchema>;

const WorkspacePath = z.string().min(1).max(4096);
const SessionId = z.string().min(1).max(512);

export const LocalWorkspaceArg = z.object({ path: WorkspacePath });
export const LocalSessionNewArg = z.object({ workspace: WorkspacePath });
export const LocalSessionListArg = z.object({ workspace: WorkspacePath });
export const LocalSessionLoadArg = z.object({ workspace: WorkspacePath, sessionId: SessionId });
export const LocalSessionDeleteArg = z.object({ sessionId: SessionId });
export const LocalSessionDeleteAllArg = z.object({ workspace: WorkspacePath });
export const LocalPromptArg = z.object({ sessionId: SessionId, text: z.string().min(1).max(200_000) });
export const LocalCancelArg = z.object({ sessionId: SessionId });
export const LocalPermissionArg = z.object({
  sessionId: SessionId,
  requestId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(256),
});
export const LocalOpenLinkArg = z.object({ url: LinkOpenArg });
export const LocalActiveSessionArg = z.object({ sessionId: SessionId.nullable() });

export const LocalSessionSummarySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  title: z.string(),
  createdAt: z.string(),
  historySource: z.enum(['agent', 'local-index']),
});
export type LocalSessionSummary = z.infer<typeof LocalSessionSummarySchema>;

// invoke results share one envelope so the renderer can show errors inline.
export type LocalResult<T> = { ok: true; value: T } | { ok: false; error: string };
