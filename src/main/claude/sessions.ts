// Claude session sidebar controller — the cloudSessions.ts analogue without
// sockets/tokens: a local registry (userData/claude-sessions.json) reconciled
// against the SDK store list, change-driven via fs.watch. Logs carry op
// names, ids, counts and durations only — never titles or transcript text.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, clipboard, dialog, Menu, shell } from 'electron';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ClaudeRegistry,
  ClaudeStoreSession,
} from '../../core/claudeRegistry';
import {
  emptyRegistry,
  folderCreate,
  folderDelete,
  folderRename,
  folderReorder,
  reconcile,
  setArchived,
  setFolder,
  setPinned,
  setRemoved,
  touchOpened,
} from '../../core/claudeRegistry';
import { claudeScope } from '../../core/tabModel';
import {
  openPrsOf,
  prCountsFor,
  recordPr as recordRegistryPr,
  setPrState,
  type ClaudePrState,
} from '../../core/claudeRegistry';
import {
  activityFor,
  applyHookEvent,
  expireActivity,
  type ActivityState,
  type ClaudeHookEvent,
} from '../../core/claudeActivity';
import { settingsFlagJson } from '../../core/claudeHooks';
import { notificationsForHookEvent } from '../../core/claudeNotify';
import { prTitle, type SessionPrLink } from '../../core/notifyModel';
import type { NotificationKind } from '../../core/notificationModel';
import type { ClaudeAgent, ClaudeState, Settings } from '../../shared/ipc';
import { log } from '../log';
import { fixtureOrigins, state, testMode } from '../state';
import { applyLayout, notifyShell } from '../window';
import { resolveClaudePath, INSTALL_GUIDANCE } from './claudePath';
import { ClaudeRegistryStore } from './registry';
import { ClaudeStore } from './store';
import { ClaudeHost, setClaudeHost } from './host';
import { sdkTargetCliVersion } from './sdk';
import { autoOpenLocalPr } from '../local/prAutoOpen';
import { terminalHost } from '../local/terminalHost';
import { ClaudeBackgroundAgents } from './backgroundAgents';
import { ClaudeHookServer } from './hookServer';
import { applyGlobalHooks } from './hooksInstall';
import { getChatState } from './chatState';
import { notificationStore } from '../notifications';
import { allOpenPullRequests, prStore } from '../prs';
import { prTitles } from '../prTitles';

const execFileAsync = promisify(execFile);

// Claude PR state refresh: every 10 min while the window is focused, and
// again each time the PR panel opens (setPrsPanel seam).
const PR_STATE_REFRESH_MS = 10 * 60_000;

type MenuAction =
  | 'rename'
  | 'rename-session'
  | 'new-folder'
  | 'open-terminal'
  | 'attach-agent'
  | null;

export class ClaudeSessions {
  private store: ClaudeStore;
  private registryStore: ClaudeRegistryStore;
  private registry: ClaudeRegistry = emptyRegistry();
  private storeSessions: ClaudeStoreSession[] = [];
  private sessions: ClaudeState['sessions'] = [];
  private status: ClaudeState['status'] = 'loading';
  private configDir: string;
  private cliPath: string | null = null;
  private error: string | null = null;
  private lastSyncAt: string | null = null;
  private lastError: { op: string; message: string } | null = null;
  private showArchived = false;
  // Filled by the Phase 2 version check (`claude --version` vs the SDK manifest).
  versions: ClaudeState['versions'] = { cli: null, sdkTarget: null, mismatch: false };
  private refreshInFlight = false;
  private refreshDirty: string | null = null;
  private started = false;
  private restoredSelection = false;
  private lastSnapshotJson = '';
  private host: ClaudeHost | null = null;
  private agents: ClaudeAgent[] = [];
  private backgroundAgents: ClaudeBackgroundAgents | null = null;
  private mutations: { op: string; payload: Record<string, unknown> }[] = [];
  // Phase 4 — hook listener + activity + global-install state.
  private hookServer: ClaudeHookServer | null = null;
  private hooks: ClaudeState['hooks'] = {
    port: null,
    enabled: false,
    installed: false,
    error: null,
  };
  private activity: ActivityState = {};
  private recentPermission = new Map<string, number>();
  private activityTimer: NodeJS.Timeout | null = null;
  private prRefreshTimer: NodeJS.Timeout | null = null;
  private readonly onPrCacheChange = (): void => {
    // prTitles cache landed/changed — push fresh states into the registry;
    // a first flip to merged|closed raises one pr-completed notification.
    let registry = this.registry;
    let changed = false;
    for (const [id, entry] of Object.entries(registry.entries)) {
      for (const pr of entry.prs) {
        const info = prTitles.getInfo(pr.url);
        if (!info || info.state === pr.state) continue;
        const result = setPrState(registry, id, pr.url, info.state, Date.now());
        registry = result.registry;
        changed = true;
        if (result.completed) this.notifyPrCompleted(id, pr.url, info.state);
      }
    }
    if (!changed) return;
    this.registry = registry;
    this.registryStore.save(registry);
    prStore().reconcile(allOpenPullRequests(), Date.now());
    this.emit();
  };

  private userData: string;

  constructor(opts: {
    configDir: string;
    registryStore: ClaudeRegistryStore;
    userData: string;
  }) {
    this.configDir = opts.configDir;
    this.registryStore = opts.registryStore;
    this.userData = opts.userData;
    this.store = new ClaudeStore({
      configDir: this.configDir,
      onChange: () => void this.refresh('watch'),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.registry = this.registryStore.load();
      this.showArchived = state.settings?.current.claude.showArchived ?? false;
      this.cliPath = resolveClaudePath(state.settings?.current.claude.path ?? null);
      this.initRuntime();
    } catch (error) {
      this.lastError = { op: 'start', message: error instanceof Error ? error.message : String(error) };
      this.emit();
    }
  }

  private initRuntime(): void {
    this.host = new ClaudeHost({
      cliPath: () => this.cliPath,
      configDir: this.configDir,
      isOnDisk: (id) => this.storeSessions.some((s) => s.id === id),
      onPullRequestUrl: (id, url) => {
        this.recordPr(id, url, 'chat');
        autoOpenLocalPr(url, claudeScope(id), 'claude-chat');
      },
      onEvent: (id, kind, detail) => this.onChatEvent(id, kind, detail),
    });
    setClaudeHost(this.host);
    this.backgroundAgents = new ClaudeBackgroundAgents({
      cliPath: () => this.cliPath,
      onChange: (agents) => {
        this.agents = agents;
        this.emit();
      },
    });
    terminalHost.claudeGate = {
      onOpen: (id) => this.beginTerminal(id),
      onExit: (id) => this.endTerminal(id),
    };
    this.backgroundAgents.start();
    // PR state tracking: title/state cache landings feed setPrState; refresh
    // non-final entries every 10 min while focused.
    prTitles.onChange = this.onPrCacheChange;
    this.prRefreshTimer = setInterval(() => {
      if (state.windowRef?.isFocused()) this.refreshPrStates('timer');
    }, PR_STATE_REFRESH_MS);
    this.prRefreshTimer.unref?.();
    this.hookServer = new ClaudeHookServer({
      userData: this.userData,
      onEvent: (e) => this.onHookEvent(e),
    });
    void this.hookServer.start().then((result) => {
      if ('error' in result) {
        this.hooks = { ...this.hooks, error: result.error };
      } else {
        this.hooks = { ...this.hooks, port: result.port, error: null };
        this.applyHooks();
      }
      this.emit();
    });
    this.activityTimer = setInterval(() => this.expireActivity(), 10 * 60_000);
    this.activityTimer.unref?.();
    void this.checkVersions();
    this.store.start();
    void this.refresh('start');
  }

  private expireActivity(): void {
    const next = expireActivity(this.activity, Date.now());
    if (next !== this.activity) {
      this.activity = next;
      this.emit();
    }
  }

  // Global opt-in: (re)write our hook block into <configDir>/settings.json so
  // external terminals report activity too; off removes exactly our entries.
  private applyHooks(): void {
    const info = this.hookServer?.info();
    const enabled = state.settings?.current.claude.hooksEnabled ?? false;
    this.hooks = { ...this.hooks, enabled };
    if (!info) {
      if (enabled) {
        this.hooks = { ...this.hooks, installed: false, error: 'hook listener unavailable' };
      }
      return;
    }
    const result = applyGlobalHooks(this.configDir, enabled, info.port, info.token);
    this.hooks = { ...this.hooks, enabled, installed: result.installed, error: result.error };
  }

  private titleFor(sessionId: string, cwd: string | undefined): string {
    return (
      this.sessions.find((s) => s.id === sessionId)?.title ??
      (cwd ? basename(cwd) : null) ??
      'Claude session'
    );
  }

  private onHookEvent(e: ClaudeHookEvent): void {
    const next = applyHookEvent(this.activity, e);
    if (next !== this.activity) {
      this.activity = next;
      this.emit();
    }
    if (!(state.settings?.current.notifications.collect ?? true)) return;
    const kinds = state.settings?.current.notifications.kinds;
    const { notifications, prUrls } = notificationsForHookEvent(e, {
      titleFor: (id, cwd) => this.titleFor(id, cwd),
      enabled: {
        waiting: kinds?.waiting ?? true,
        finished: kinds?.finished ?? false,
        prOpened: kinds?.prOpened ?? true,
      },
      now: Date.now(),
      recentPermission: this.recentPermission,
      githubOrigins: fixtureOrigins,
    });
    for (const n of notifications) notificationStore().add(n);
    for (const url of prUrls) {
      this.recordPr(e.session_id, url, 'hook');
      autoOpenLocalPr(url, claudeScope(e.session_id), 'claude-hook');
    }
  }

  // One funnel for every detected Claude PR URL (chat link scanner, claude-pty
  // output, PostToolUse hook) — records it on the registry entry before any
  // auto-open so the PR panel + sidebar badges see it even without a Devin
  // token.
  recordPr(sessionId: string, url: string, source: 'chat' | 'terminal' | 'hook'): void {
    const { registry, added } = recordRegistryPr(
      this.registry,
      sessionId,
      url,
      source,
      Date.now(),
    );
    if (!added) return;
    this.registry = registry;
    this.registryStore.save(registry);
    prTitles.ensure([url]);
    prStore().reconcile(allOpenPullRequests(), Date.now());
    this.emit();
  }

  // Claude open PRs for the panel: non-removed, non-missing sessions, newest
  // seenAt first (openPrsOf already drops merged/closed). Unknown state counts
  // as open.
  claudeOpenPullRequests(): SessionPrLink[] {
    const missing = new Set(
      this.sessions.filter((s) => s.missing).map((s) => s.id),
    );
    return openPrsOf(this.registry)
      .filter(({ sessionId }) => !missing.has(sessionId))
      .map(({ sessionId, pr }) => ({
        sessionId,
        sessionTitle: this.titleFor(sessionId, undefined),
        ref: prTitle(pr.url),
        url: pr.url,
        state: pr.state,
        source: 'claude' as const,
      }));
  }

  // Re-fetch non-final Claude PR states (title cache fetch → setPrState via
  // the onChange subscription).
  refreshPrStates(reason: string): void {
    const urls = openPrsOf(this.registry).map(({ pr }) => pr.url);
    if (urls.length === 0) return;
    log('claude', 'claude-pr-refresh', { detail: { count: urls.length, reason } });
    prTitles.ensure(urls, { maxAgeMs: PR_STATE_REFRESH_MS });
  }

  prsOf(sessionId: string): { url: string; state: string | null }[] {
    return (this.registry.entries[sessionId]?.prs ?? []).map((pr) => ({
      url: pr.url,
      state: pr.state,
    }));
  }

  private notifyPrCompleted(
    sessionId: string,
    url: string,
    prState: ClaudePrState | null,
  ): void {
    if (prState !== 'merged' && prState !== 'closed') return;
    if (!(state.settings?.current.notifications.collect ?? true)) return;
    if (!(state.settings?.current.notifications.kinds.prCompleted ?? true)) return;
    const sessionTitle = this.titleFor(sessionId, undefined);
    notificationStore().add({
      kind: 'pr-completed',
      sessionId,
      source: 'claude',
      ownerUserId: null,
      sessionTitle,
      prUrl: url,
      prState,
      title: `PR ${prTitle(url)} ${prState}`,
      body: sessionTitle,
      createdAt: Date.now(),
    });
  }

  // Chat-derived notifications — the SDK host reports its own state changes;
  // hook events never overlap (chat sessions get no hooks injected).
  private onChatEvent(
    sessionId: string,
    kind: 'waiting' | 'finished' | 'blocked',
    detail?: { tool?: string; error?: string },
  ): void {
    if (!(state.settings?.current.notifications.collect ?? true)) return;
    const kinds = state.settings?.current.notifications.kinds;
    const enabled: Record<'waiting' | 'finished' | 'blocked', boolean> = {
      waiting: kinds?.waiting ?? true,
      finished: kinds?.finished ?? false,
      blocked: kinds?.blocked ?? true,
    };
    if (!enabled[kind]) return;
    const sessionTitle = this.titleFor(sessionId, undefined);
    notificationStore().add({
      kind: kind as NotificationKind,
      sessionId,
      source: 'claude',
      ownerUserId: null,
      sessionTitle,
      title:
        kind === 'waiting'
          ? 'Waiting for permission'
          : kind === 'finished'
            ? 'Finished a turn'
            : 'Session error',
      body:
        kind === 'waiting'
          ? `${detail?.tool ?? 'A tool'} in ${sessionTitle}`
          : kind === 'finished'
            ? sessionTitle
            : (detail?.error ?? 'error').slice(0, 200),
      createdAt: Date.now(),
    });
  }

  // Pty spawn injection for claude-kind terminals: `--settings` hook block +
  // the bearer token env var. Mode `attach` gets none (the background agent
  // already runs) and a failed listener means no injection at all.
  hookInjection(
    sessionId: string,
    mode: 'resume' | 'new' | 'attach',
  ): { extraArgs: string[]; extraEnv: Record<string, string> } | null {
    if (mode === 'attach') return null;
    const info = this.hookServer?.info();
    if (!info) return null;
    const envVar = 'DEVIN_WORKSPACES_CLAUDE_HOOK_TOKEN';
    return {
      extraArgs: ['--settings', settingsFlagJson(info.port, envVar)],
      extraEnv: { [envVar]: info.token },
    };
  }

  // `claude --version` once at start (and when claude.path changes) vs the
  // CLI version the bundled SDK targets — powers the header warning badge.
  private async checkVersions(): Promise<void> {
    const sdkTarget = sdkTargetCliVersion();
    let cli: string | null = null;
    const bin = this.cliPath;
    if (bin) {
      try {
        const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 3_000 });
        cli = stdout.trim().split(/\s+/)[0] ?? null;
      } catch {
        cli = null;
      }
    }
    this.versions = {
      cli,
      sdkTarget,
      mismatch: Boolean(cli && sdkTarget && cli !== sdkTarget),
    };
    this.emit();
  }

  snapshot(): ClaudeState {
    const agentStatusBySession = new Map(
      this.agents
        .filter((a) => a.sessionId)
        .map((a) => [a.sessionId!, a.status] as const),
    );
    const sessions = this.showArchived
      ? this.sessions
      : this.sessions.filter((s) => !s.isArchived);
    return {
      status: this.status,
      configDir: this.configDir,
      cliPath: this.cliPath,
      installGuidance: INSTALL_GUIDANCE,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      folders: this.registry.folders,
      sessions: sessions.map((s) => {
        const chat = getChatState().sessions[s.id];
        return {
          ...s,
          agentStatus: agentStatusBySession.get(s.id) ?? null,
          // PR badge counts always read live from the registry entry —
          // recordPr/setPrState don't wait for the next reconcile.
          prs: prCountsFor(this.registry.entries[s.id]),
          activity: activityFor(
            this.activity,
            chat
              ? {
                  running: chat.running === true,
                  pendingPermission: chat.pendingPermission !== undefined,
                }
              : null,
            s.id,
          ),
        };
      }),
      showArchived: this.showArchived,
      lastError: this.lastError,
      versions: this.versions,
      agents: this.agents,
      hooks: this.hooks,
    };
  }

  activityMap(): ActivityState {
    return this.activity;
  }

  hookInfo(): { port: number; token: string } | null {
    return this.hookServer?.info() ?? null;
  }

  hooksSettingsPath(): string {
    return join(this.configDir, 'settings.json');
  }

  agentsList(): ClaudeAgent[] {
    return this.agents;
  }

  refreshAgents(): Promise<void> {
    return this.backgroundAgents?.refresh('manual') ?? Promise.resolve();
  }

  onWindowFocus(): void {
    this.backgroundAgents?.onWindowFocus();
  }

  agentStop(agentId: string): Promise<void> {
    this.recordMutation('agentStop', { agentId });
    return this.backgroundAgents?.stop(agentId) ?? Promise.resolve();
  }

  // --- refresh -------------------------------------------------------------
  // Coalesced like cloudSessions.list: one in-flight store.list() plus at
  // most one dirty follow-up.
  async refresh(source: string): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshDirty = source;
      return;
    }
    this.refreshInFlight = true;
    const t0 = Date.now();
    try {
      const list = await this.store.list();
      this.storeSessions = list;
      const { registry, sessions, changed } = reconcile(this.registry, list, {
        now: Date.now(),
        autoArchiveDays: state.settings?.current.claude.autoArchiveDays ?? 0,
      });
      if (changed) {
        this.registry = registry;
        this.registryStore.save(registry);
      }
      this.sessions = sessions;
      this.status = 'ready';
      this.error = null;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      // Every listed transcript gets an in-memory chat session (history lazy).
      for (const s of sessions) this.host?.ensureSession(s.id, { cwd: s.cwd });
      if (!this.restoredSelection) {
        this.restoredSelection = true;
        const last = state.settings?.current.claude.lastSessionId;
        if (!state.claudeSessionId && last && sessions.some((s) => s.id === last)) {
          this.open(last);
        }
      }
      log('claude', 'claude-list', {
        detail: { count: list.length, ms: Date.now() - t0, source },
      });
      this.emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = 'error';
      this.error = message;
      log('claude', 'claude-list', { detail: { count: -1, ms: Date.now() - t0, source } });
      this.emit();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshDirty) {
        const source = this.refreshDirty;
        this.refreshDirty = null;
        void this.refresh(source);
      }
    }
  }

  private emit(): void {
    const json = JSON.stringify(this.snapshot());
    if (json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    notifyShell();
  }

  // --- mutations -------------------------------------------------------------
  private recordMutation(op: string, payload: Record<string, unknown>): void {
    if (testMode) this.mutations.push({ op, payload });
  }

  private async mutate(op: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
      log('claude', 'claude-mutate', { detail: { op, ok: true } });
    } catch (error) {
      log('claude', 'claude-mutate', { detail: { op, ok: false } });
      this.lastError = { op, message: error instanceof Error ? error.message : String(error) };
      this.emit();
    }
  }

  open(sessionId: string): void {
    state.claudeSessionId = sessionId;
    state.settings?.merge({ claude: { lastSessionId: sessionId } });
    this.registry = touchOpened(this.registry, sessionId, Date.now());
    this.registryStore.save(this.registry);
    log('claude', 'claude-select', { detail: { sessionId } });
    applyLayout();
    const chat = this.host;
    if (chat && !chat.isLoaded(sessionId)) void chat.loadHistory(sessionId);
  }

  // --- Terminal tab (Phase 3 one-writer handoff) ------------------------------
  // beginTerminal runs BEFORE the pty spawns (claudeGate.onOpen): a running
  // chat prompt refuses; the live SDK query closes and the session is marked
  // terminalOwned until the pty exits.
  async beginTerminal(sessionId: string): Promise<void> {
    const host = this.host;
    if (!host) throw new Error('claude host not started');
    if (host.isRunning(sessionId)) {
      throw new Error('Cancel the running prompt first');
    }
    await host.closeLiveQuery(sessionId);
    host.setTerminalOwned(sessionId, true);
    log('claude', 'claude-terminal', { detail: { sessionId, op: 'open' } });
  }

  endTerminal(sessionId: string): void {
    const host = this.host;
    host?.setTerminalOwned(sessionId, false);
    log('claude', 'claude-terminal', { detail: { sessionId, op: 'close' } });
    void this.refresh('terminal');
    if (host) void host.loadHistory(sessionId);
  }

  // Terminal arg resolver for terminal:open — resume only when the transcript
  // is on disk or the host already started a query for this id.
  terminalModeFor(sessionId: string): 'resume' | 'new' {
    return this.storeSessions.some((s) => s.id === sessionId) ||
      (this.host?.hasStarted(sessionId) ?? false)
      ? 'resume'
      : 'new';
  }

  // New chat session: cwd comes from the arg (the empty-state button) or a
  // directory picker (sidebar header / Ctrl+N). null cwd → dialog; in test
  // mode DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD stands in for the picker.
  async newSession(cwd: string | null): Promise<string | null> {
    let dir = cwd;
    if (!dir) {
      const envCwd = testMode ? process.env.DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD?.trim() : '';
      if (envCwd) dir = envCwd;
      else {
        const win = state.windowRef;
        if (!win) return null;
        const result = await dialog.showOpenDialog(win, {
          title: 'Choose the working directory for the new Claude session',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        dir = result.filePaths[0]!;
      }
    }
    this.recordMutation('newSession', {});
    const id = this.host?.newSession(dir) ?? null;
    if (id) this.open(id);
    return id;
  }

  rename(sessionId: string, title: string): Promise<void> {
    this.recordMutation('rename', { sessionId });
    return this.mutate('rename', async () => {
      await this.store.rename(sessionId, title);
      // The watcher re-lists; refresh now so the title lands even when the
      // watch event is delayed.
      await this.refresh('mutate');
    });
  }

  fork(sessionId: string): Promise<void> {
    this.recordMutation('fork', { sessionId });
    return this.mutate('fork', async () => {
      const { sessionId: forkedId } = await this.store.fork(sessionId);
      const source = this.registry.entries[sessionId];
      // Folder/pin follow the fork; archive/removal state does not.
      if (source && (source.folder !== null || source.pinned)) {
        this.registry = {
          ...this.registry,
          entries: {
            ...this.registry.entries,
            [forkedId]: { ...source, id: forkedId },
          },
        };
        this.registryStore.save(this.registry);
      }
      this.open(forkedId);
      await this.refresh('mutate');
    });
  }

  sessionMove(sessionId: string, folder: string | null): Promise<void> {
    this.recordMutation('sessionMove', { sessionId, folder });
    return this.mutate('sessionMove', () => {
      this.applyRegistry(setFolder(this.registry, sessionId, folder));
    });
  }

  sessionPin(sessionId: string, pinned: boolean): Promise<void> {
    this.recordMutation('sessionPin', { sessionId, pinned });
    return this.mutate('sessionPin', () => {
      this.applyRegistry(setPinned(this.registry, sessionId, pinned));
    });
  }

  sessionArchive(sessionId: string, archive: boolean): Promise<void> {
    this.recordMutation('sessionArchive', { sessionId, archive });
    return this.mutate('sessionArchive', () => {
      this.applyRegistry(setArchived(this.registry, sessionId, archive, Date.now()));
    });
  }

  sessionRemove(sessionId: string): Promise<void> {
    this.recordMutation('sessionRemove', { sessionId });
    return this.mutate('sessionRemove', () => {
      this.applyRegistry(setRemoved(this.registry, sessionId, Date.now()));
      this.forget(sessionId);
    });
  }

  async sessionDeleteTranscript(sessionId: string): Promise<void> {
    const win = state.windowRef;
    let confirmed = testMode;
    if (!confirmed && win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Delete this transcript?',
        detail: 'The session file is removed from disk permanently.',
      });
      confirmed = response === 0;
    }
    if (!confirmed) return;
    this.recordMutation('sessionDeleteTranscript', { sessionId });
    return this.mutate('sessionDeleteTranscript', async () => {
      await this.store.deleteTranscript(sessionId);
      const entries = { ...this.registry.entries };
      delete entries[sessionId];
      this.applyRegistry({ ...this.registry, entries });
      this.forget(sessionId);
      await this.refresh('mutate');
    });
  }

  async revealTranscript(sessionId: string): Promise<void> {
    this.recordMutation('revealTranscript', { sessionId });
    const path = await this.store.transcriptPath(sessionId);
    if (path) shell.showItemInFolder(path);
  }

  folderCreate(name: string): Promise<void> {
    this.recordMutation('folderCreate', { name });
    return this.mutate('folderCreate', () => {
      this.applyRegistry(folderCreate(this.registry, name));
    });
  }

  folderRename(oldName: string, newName: string): Promise<void> {
    this.recordMutation('folderRename', {});
    return this.mutate('folderRename', () => {
      this.applyRegistry(folderRename(this.registry, oldName, newName));
    });
  }

  async folderDelete(name: string): Promise<void> {
    const win = state.windowRef;
    let confirmed = testMode;
    if (!confirmed && win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Delete folder "${name}"?`,
        detail: "Sessions stay — they're just unfoldered.",
      });
      confirmed = response === 0;
    }
    if (!confirmed) return;
    this.recordMutation('folderDelete', { name });
    return this.mutate('folderDelete', () => {
      this.applyRegistry(folderDelete(this.registry, name));
    });
  }

  folderReorder(names: string[]): Promise<void> {
    this.recordMutation('folderReorder', { count: names.length });
    return this.mutate('folderReorder', () => {
      this.applyRegistry(folderReorder(this.registry, names));
    });
  }

  setShowArchived(value: boolean): void {
    this.showArchived = value;
    state.settings?.merge({ claude: { showArchived: value } });
    this.recordMutation('showArchived', { value });
    this.emit();
  }

  copySessionId(sessionId: string): void {
    clipboard.writeText(sessionId);
    this.recordMutation('copySessionId', { sessionId });
  }

  private applyRegistry(next: ClaudeRegistry): void {
    this.registry = next;
    this.registryStore.save(next);
    const { sessions } = reconcile(this.registry, this.storeSessions, {
      now: Date.now(),
      autoArchiveDays: state.settings?.current.claude.autoArchiveDays ?? 0,
    });
    this.sessions = sessions;
    this.emit();
  }

  // A removed/deleted session must not leave scoped GitHub tabs behind even
  // when it isn't the current selection.
  private forget(sessionId: string): void {
    if (state.claudeSessionId === sessionId) state.claudeSessionId = null;
    void state.tabManager?.closeScope(claudeScope(sessionId));
    terminalHost.closeForSession(sessionId);
    this.host?.dropSession(sessionId);
    applyLayout();
  }

  // Settings changes routed through applySettingsPatch.
  onSettingsChanged(previous: Settings, next: Settings): void {
    if (previous.claude.autoArchiveDays !== next.claude.autoArchiveDays) {
      void this.refresh('settings');
    }
    if (previous.claude.path !== next.claude.path) {
      this.cliPath = resolveClaudePath(next.claude.path);
      void this.checkVersions();
      this.emit();
    }
    if (previous.claude.hooksEnabled !== next.claude.hooksEnabled) {
      this.applyHooks();
      this.emit();
    }
  }

  // --- context menus ------------------------------------------------------
  // Same test seam as cloudSessions: in test mode the popup is described and
  // the claudeMenuItems/claudeMenuClick hooks drive the same callbacks.
  private pendingMenu = new Map<string, Electron.MenuItemConstructorOptions>();
  private lastMenuDesc: Record<string, unknown>[] = [];
  private pendingAction: MenuAction = null;
  // Test mode only: the contextMenu invoke stays open until a click resolves
  // it — same shape as the production popup resolving with pendingAction.
  private pendingMenuResolve: ((result: { action: MenuAction }) => void) | null = null;

  menuItems(): Record<string, unknown>[] {
    return this.lastMenuDesc;
  }

  clickMenuItem(id: string): { action: MenuAction } {
    const item = this.pendingMenu.get(id);
    if (!item?.click) return { action: null };
    const next = !(item.checked ?? false);
    item.checked = next;
    item.click(
      { checked: next } as Electron.MenuItem,
      state.windowRef!,
      {} as Electron.KeyboardEvent,
    );
    const action = this.pendingAction;
    this.pendingAction = null;
    this.pendingMenuResolve?.({ action });
    this.pendingMenuResolve = null;
    return { action };
  }

  async contextMenu(arg: {
    kind: 'session' | 'folder' | 'header' | 'agent';
    sessionId?: string | undefined;
    name?: string | undefined;
    agentId?: string | undefined;
    x: number;
    y: number;
  }): Promise<{ action: MenuAction; items?: Record<string, unknown>[] }> {
    this.pendingAction = null;
    const items: Electron.MenuItemConstructorOptions[] = [];

    if (arg.kind === 'agent' && arg.agentId) {
      const agentId = arg.agentId;
      items.push(
        {
          label: 'Attach',
          click: () => {
            this.pendingAction = 'attach-agent';
          },
        },
        { label: 'Stop', click: () => void this.agentStop(agentId) },
      );
    } else if (arg.kind === 'header') {
      items.push({
        label: 'Show archived sessions',
        type: 'checkbox',
        checked: this.showArchived,
        click: (item) => this.setShowArchived(item.checked),
      });
      items.push({ label: 'Refresh', click: () => void this.refresh('menu') });
    } else if (arg.kind === 'folder' && arg.name) {
      const name = arg.name;
      items.push(
        {
          label: 'Rename…',
          click: () => {
            this.pendingAction = 'rename';
          },
        },
        {
          label: 'Delete…',
          click: () => void this.folderDelete(name),
        },
      );
    } else if (arg.kind === 'session' && arg.sessionId) {
      const session = this.sessions.find((s) => s.id === arg.sessionId);
      if (!session) return { action: null };
      const submenu: Electron.MenuItemConstructorOptions[] = this.registry.folders.map(
        (name) => ({
          label: name,
          type: 'checkbox',
          checked: session.folder === name,
          click: () => void this.sessionMove(session.id, name),
        }),
      );
      submenu.push(
        { type: 'separator' },
        {
          label: 'Remove from folder',
          enabled: session.folder !== null,
          click: () => void this.sessionMove(session.id, null),
        },
        {
          label: 'New folder…',
          click: () => {
            this.pendingAction = 'new-folder';
          },
        },
      );
      items.push(
        {
          label: 'Rename…',
          click: () => {
            this.pendingAction = 'rename-session';
          },
        },
        { label: 'Fork', click: () => void this.fork(session.id) },
        {
          label: 'Open in terminal',
          click: () => {
            this.pendingAction = 'open-terminal';
          },
        },
        { type: 'separator' },
        { label: 'Move to folder', submenu },
        {
          label: session.isPinned ? 'Unpin' : 'Pin',
          click: () => void this.sessionPin(session.id, !session.isPinned),
        },
        {
          label: session.isArchived ? 'Unarchive' : 'Archive',
          click: () => void this.sessionArchive(session.id, !session.isArchived),
        },
        { type: 'separator' },
        { label: 'Reveal transcript', click: () => void this.revealTranscript(session.id) },
        { label: 'Copy session id', click: () => this.copySessionId(session.id) },
        { type: 'separator' },
        { label: 'Remove from list', click: () => void this.sessionRemove(session.id) },
        {
          label: 'Delete transcript…',
          click: () => void this.sessionDeleteTranscript(session.id),
        },
      );
    } else {
      return { action: null };
    }

    if (items.length === 0) return { action: null };
    if (testMode) {
      this.pendingMenu.clear();
      let n = 0;
      const assign = (list: Electron.MenuItemConstructorOptions[]) =>
        list.forEach((item) => {
          if (item.type === 'separator') return;
          item.id = `m${n++}`;
          this.pendingMenu.set(item.id, item);
          if (Array.isArray(item.submenu)) {
            assign(item.submenu as Electron.MenuItemConstructorOptions[]);
          }
        });
      assign(items);
      const describe = (
        list: Electron.MenuItemConstructorOptions[],
      ): Record<string, unknown>[] =>
        list.map((item) => ({
          id: item.id,
          label: item.label ?? item.role ?? '',
          type: item.type ?? 'normal',
          enabled: item.enabled !== false,
          ...(item.type === 'checkbox' ? { checked: item.checked } : {}),
          ...(item.submenu
            ? { submenu: describe(item.submenu as Electron.MenuItemConstructorOptions[]) }
            : {}),
        }));
      this.lastMenuDesc = describe(items);
      // Production resolves the invoke when the popup closes with
      // pendingAction; the click hook resolves it here the same way.
      return await new Promise<{ action: MenuAction }>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingMenuResolve = null;
          resolve({ action: null });
        }, 30_000);
        this.pendingMenuResolve = (result) => {
          clearTimeout(timer);
          this.pendingMenuResolve = null;
          resolve(result);
        };
      });
    }
    const menu = Menu.buildFromTemplate(items);
    log('claude', 'claude-menu', { detail: { kind: arg.kind } });
    await new Promise<void>((resolve) => {
      const opts: Electron.PopupOptions = {
        x: Math.round(arg.x),
        y: Math.round(arg.y),
        callback: () => resolve(),
      };
      if (state.windowRef) menu.popup({ ...opts, window: state.windowRef });
      else menu.popup(opts);
    });
    return { action: this.pendingAction };
  }

  mutationLog(): { op: string; payload: Record<string, unknown> }[] {
    return this.mutations;
  }

  dispose(): void {
    this.backgroundAgents?.dispose();
    if (terminalHost.claudeGate) terminalHost.claudeGate = null;
    this.hookServer?.dispose();
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
    if (this.prRefreshTimer) clearInterval(this.prRefreshTimer);
    this.prRefreshTimer = null;
    if (prTitles.onChange === this.onPrCacheChange) prTitles.onChange = null;
    this.store.dispose();
    this.registryStore.dispose();
  }
}

let instance: ClaudeSessions | null = null;

// publicState() calls this before setupClaude() runs on some paths — return
// the created instance or an un-started one so the placeholder is valid.
export function claudeSessions(): ClaudeSessions {
  instance ??= create();
  return instance;
}

export function setupClaudeSessions(opts: {
  configDir: string;
  userData: string;
}): ClaudeSessions {
  instance = create(opts);
  return instance;
}

function create(opts?: { configDir: string; userData: string }): ClaudeSessions {
  const configDir =
    opts?.configDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'));
  const userData = opts?.userData ?? app.getPath('userData');
  return new ClaudeSessions({
    configDir,
    registryStore: new ClaudeRegistryStore(userData),
    userData,
  });
}
