// Claude session sidebar controller — the cloudSessions.ts analogue without
// sockets/tokens: a local registry (userData/claude-sessions.json) reconciled
// against the SDK store list, change-driven via fs.watch. Logs carry op
// names, ids, counts and durations only — never titles or transcript text.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, clipboard, dialog, shell } from 'electron';
import { openFolderDialog } from '../dialogs';
import { pickerStartPath } from '../../core/pickerFolder';
import { basename, resolve } from 'node:path';
import type {
  ClaudeRegistry,
  ClaudeStoreSession,
} from '../../core/claudeRegistry';
import {
  emptyRegistry,
  patchSessions,
  reconcile,
  setArchived,
  setPinned,
  setRemoved,
  touchOpened,
} from '../../core/claudeRegistry';
import {
  migrateLegacyFolders,
  renameWorkspace,
  reorderWorkspaces,
  defaultWorkspaceLabel,
} from '../../core/workspaceTree';
import { claudeScope } from '../../core/tabModel';
import { LOCAL_HOST, isWslHost, type ExecHost, type HostId } from '../../core/execHost';
import { mergeRefreshHosts, statusRefreshTargets, throttleDue } from '../../core/claudeWatchPolicy';
import { ClaudeContextMenu, type MenuAction } from './contextMenu';
import { ClaudeHooks } from './hooks';
import { ClaudePrTracking } from './prTracking';
import { prCountsFor } from '../../core/claudeRegistry';
import { activityFor, type ActivityState } from '../../core/claudeActivity';
import type { SessionPrLink } from '../../core/notifyModel';
import type { ClaudeAgent, ClaudeState, ClaudeSubagent, Settings } from '../../shared/ipc';
import { log } from '../log';
import { state, testMode } from '../state';
import { applyLayout, notifyShell } from '../window';
import { resolveClaudePath, INSTALL_GUIDANCE } from './claudePath';
import { ClaudeRegistryStore } from './registry';
import { ClaudeStore, type StoreBackend, type StoreChange } from './store';
import { hosts } from '../hosts';
import { HostRpcError } from '../hostChannel';
import { ClaudeHost, setClaudeHost } from './host';
import { sdkTargetCliVersion } from './sdk';
import { autoOpenLocalPr } from '../local/prAutoOpen';
import { terminalHost } from '../local/terminalHost';
import { ClaudeBackgroundAgents } from './backgroundAgents';
import { getChatState } from './chatState';
import { titleFromPrompt } from '../../core/localModel';

const execFileAsync = promisify(execFile);
const SURFACE_REFRESH_MIN_MS = 60_000;

export class ClaudeSessions {
  private stores = new Map<HostId, ClaudeStore>();
  private registryStore: ClaudeRegistryStore;

  /** @internal read by contextMenu/prTracking; written via saveRegistry/applyRegistry. */
  registry: ClaudeRegistry = emptyRegistry();
  private storeSessions: ClaudeStoreSession[] = [];
  /** @internal read by contextMenu/prTracking. */
  sessions: ClaudeState['sessions'] = [];
  private status: ClaudeState['status'] = 'loading';
  /** @internal read by the hooks collaborator. */
  readonly configDir: string;
  private cliPath: string | null = null;
  private error: string | null = null;
  private lastSyncAt: string | null = null;
  private lastError: { op: string; message: string } | null = null;
  /** @internal read by contextMenu; written via setShowArchived. */
  showArchived = false;
  // `claude --version` vs the SDK manifest target — powers the header warning badge.
  versions: ClaudeState['versions'] = { cli: null, sdkTarget: null, mismatch: false };
  private refreshInFlight = false;
  private refreshDirty: { source: string; hosts: Set<string> | null } | null = null;
  private lastSurfaceRefreshAt: number | null = null;
  private started = false;
  private restoredSelection = false;
  private lastSnapshotJson = '';
  private host: ClaudeHost | null = null;
  private agents: ClaudeAgent[] = [];
  private agentsByHost = new Map<HostId, ClaudeAgent[]>();
  private backgroundAgents = new Map<HostId, ClaudeBackgroundAgents>();
  private mutations: { op: string; payload: Record<string, unknown> }[] = [];
  private readonly hook: ClaudeHooks;
  private readonly pr: ClaudePrTracking;
  private readonly menu: ClaudeContextMenu;
  // Subagent transcript lists per session: loaded lazily on expand;
  // invalidated at turn end and on store change for that session.
  private subagentLists = new Map<string, ClaudeSubagent[]>();
  // The subagent view currently open in the chat column (agentId, or null).
  private selectedSubagentId: string | null = null;
  // #6 terminal-owned live history: debounced loadHistory per session when
  // the store watcher reports the transcript file changed.
  private historyTimers = new Map<string, NodeJS.Timeout>();
  private historyInFlight = new Set<string>();
  // store.changed patches that landed while a refresh was listing — replayed
  // over its result so a slower, staler list can't undo them.
  private pendingPatches: { hostId: HostId; updated: ClaudeStoreSession[]; removed: string[] }[] = [];
  // Test mode: showItemInFolder targets (Explorer is never opened).
  private revealed: string[] = [];
  private userData: string;

  constructor(opts: {
    configDir: string;
    registryStore: ClaudeRegistryStore;
    userData: string;
  }) {
    this.configDir = opts.configDir;
    this.registryStore = opts.registryStore;
    this.userData = opts.userData;
    this.menu = new ClaudeContextMenu(this);
    this.pr = new ClaudePrTracking(this);
    this.hook = new ClaudeHooks(this, this.configDir);
  }

  /** One store per enabled host, created lazily so a host enabled mid-run is
   * picked up by the next refresh. */
  private storeForHost(host: ExecHost): ClaudeStore {
    let store = this.stores.get(host.id);
    if (!store) {
      store = new ClaudeStore(host, this.configDir, (ev) => this.onStoreChange(host, ev));
      this.stores.set(host.id, store);
      if (this.started) store.start();
    }
    return store;
  }

  private storeForSession(id: string): StoreBackend {
    return this.storeForHost(this.execHostFor(id)).backend;
  }

  /** A store watch report. Local: any change re-lists the local host (the
   * SDK list is cheap there). WSL: the helper already sent the changed
   * sessions' info — patch those rows, never a full list; a channel that came
   * back (`resync`) may have missed events, so that host is listed in full. */
  private onStoreChange(host: ExecHost, ev: StoreChange): void {
    if (!isWslHost(host)) {
      void this.refresh('watch', [host.id]);
    } else if (ev.resync) {
      void this.refresh('channel', [host.id]);
    } else {
      this.applyStorePatch(host.id, ev.sessions, ev.removed);
    }
    this.onTranscriptFiles(ev.files);
  }

  private applyStorePatch(hostId: HostId, updated: ClaudeStoreSession[], removed: string[]): void {
    if (updated.length === 0 && removed.length === 0) return;
    if (this.refreshInFlight) this.pendingPatches.push({ hostId, updated, removed });
    this.storeSessions = patchSessions(this.storeSessions, hostId, updated, removed);
    const sessions = this.reconcileStore();
    for (const s of updated) {
      const row = sessions.find((r) => r.id === s.id);
      if (row) this.host?.ensureSession(row.id, { cwd: row.cwd, host: row.host as HostId });
    }
    log('claude', 'claude-patch', {
      detail: { host: hostId, updated: updated.length, removed: removed.length },
    });
    this.emit();
  }

  /** Reconcile the registry against storeSessions (saving when it changed). */
  private reconcileStore(): ClaudeState['sessions'] {
    const { registry, sessions, changed } = reconcile(this.registry, this.storeSessions, {
      now: Date.now(),
      autoArchiveDays: state.settings?.current.claude.autoArchiveDays ?? 0,
      ...this.workspaceOpts(),
    });
    if (changed) {
      this.registry = registry;
      this.registryStore.save(registry);
    }
    this.sessions = sessions;
    return sessions;
  }

  /** The ExecHost a session belongs to: sidebar row → store row → chat state. */
  private execHostFor(id: string): ExecHost {
    return hosts().hostById(this.hostIdFor(id)) ?? LOCAL_HOST;
  }

  private hostIdFor(id: string): HostId {
    return (
      (this.sessions.find((s) => s.id === id)?.host ??
        this.storeSessions.find((s) => s.id === id)?.host ??
        getChatState().sessions[id]?.host ??
        'local') as HostId
    );
  }

  private startStores(): void {
    for (const host of hosts().readyList()) {
      this.storeForHost(host).start();
    }
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
      hostFor: (id) => this.execHostFor(id),
      isOnDisk: (id) => this.storeSessions.some((s) => s.id === id),
      messages: (id) => this.storeForSession(id).messages(id),
      subagentMessages: (id, agentId) => this.storeForSession(id).subagentMessages(id, agentId),
      onPullRequestUrl: (id, url) => {
        this.recordPr(id, url, 'chat');
        autoOpenLocalPr(url, claudeScope(id), 'claude-chat');
      },
      onEvent: (id, kind, detail) => this.hook.onChatEvent(id, kind, detail),
    });
    setClaudeHost(this.host);
    // One agents poller per host; local keeps the PATH/CLI resolution,
    // wsl hosts run `claude agents` through the host bridge.
    hosts().start();
    for (const host of hosts().list()) this.agentsForHost(host).start();
    terminalHost.claudeGate = {
      onOpen: (id) => this.beginTerminal(id),
      onExit: (id) => this.endTerminal(id),
      resolveHost: (id) => this.hostIdFor(id),
    };
    hosts().hookPort = () => this.hook.info()?.port ?? null;
    hosts().hookAddrBind = (addr) => this.hook.listenOn(addr);
    // The Settings refresh button re-writes the hooks block even when the
    // gate key is unchanged (repairs a hand-edited settings.json).
    hosts().onExplicitRefresh = (id) => this.hook.forgetApplied(id);
    // Enumeration/probe completion re-publishes the host list; a new wsl host
    // also needs its store created, so refresh rather than emit only.
    hosts().onStatusChange = () => {
      void this.refresh('hosts', this.statusRefreshHosts());
      // A host that just became ready gets its hooks block written now —
      // applyHooks skips hosts whose fs isn't reachable yet.
      this.hook.applyHooks();
    };
    this.pr.start();
    this.hook.start(this.userData);
    void this.checkVersions();
    this.startStores();
    void this.refresh('start');
  }

  // --- collaborators -------------------------------------------------------
  // Menu building, PR tracking and hook wiring live in their own modules as
  // collaborator classes that take this controller; the public method
  // signatures below delegate unchanged.

  /** @internal registry write used by prTracking (save only — no reconcile). */
  saveRegistry(next: ClaudeRegistry): void {
    this.registry = next;
    this.registryStore.save(next);
  }

  /** @internal drop a cached subagent list (turn end / transcript change). */
  invalidateSubagentList(sessionId: string): void {
    this.subagentLists.delete(sessionId);
  }

  titleFor(sessionId: string, cwd: string | undefined): string {
    return (
      this.sessions.find((s) => s.id === sessionId)?.title ??
      (cwd ? basename(cwd) : null) ??
      'Claude session'
    );
  }

  recordPr(sessionId: string, url: string, source: 'chat' | 'terminal' | 'hook'): void {
    this.pr.recordPr(sessionId, url, source);
  }

  claudeOpenPullRequests(): SessionPrLink[] {
    return this.pr.claudeOpenPullRequests();
  }

  refreshPrStates(reason: string): void {
    this.pr.refreshPrStates(reason);
  }

  prsOf(sessionId: string): { url: string; state: string | null }[] {
    return this.pr.prsOf(sessionId);
  }

  hookInjection(
    sessionId: string,
    mode: 'resume' | 'new' | 'attach',
  ): { extraArgs: string[]; extraEnv: Record<string, string> } | null {
    return this.hook.injection(
      mode,
      hosts().hookAddrFor(this.hostIdFor(sessionId)) ?? undefined,
    );
  }

  /** Recapture the shell environment for the session's host (claude:recheckEnv). */
  async recheckEnv(sessionId: string): Promise<void> {
    await hosts().recheckEnv(this.hostIdFor(sessionId));
    this.emit();
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
      folders: state.settings?.current.claude.workspaces ?? [],
      sessions: sessions.map((s) => {
        const chat = getChatState().sessions[s.id];
        return {
          ...s,
          agentStatus: agentStatusBySession.get(s.id) ?? null,
          // PR badge counts always read live from the registry entry —
          // recordPr/setPrState don't wait for the next reconcile.
          prs: prCountsFor(this.registry.entries[s.id]),
          // Subagent children load lazily — null until the row is expanded.
          subagents: this.subagentLists.get(s.id) ?? null,
          activity: activityFor(
            this.hook.activity,
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
      hostErrors: hosts().errors(),
      lastError: this.lastError,
      versions: this.versions,
      agents: this.agents,
      hooks: this.hook.hooks,
      // Set by the subagent view (claude:openSubagent); cleared on claude:open.
      selectedSubagentId: this.selectedSubagentId,
    };
  }

  activityMap(): ActivityState {
    return this.hook.activity;
  }

  hookInfo(): { port: number; token: string } | null {
    return this.hook.info();
  }

  hooksSettingsPath(): string {
    return this.hook.settingsPath();
  }

  /** Re-run the gated hooks apply (test hook; same path as a host status change). */
  applyHooks(): void {
    this.hook.applyHooks();
  }

  agentsList(): ClaudeAgent[] {
    return this.agents;
  }

  private agentsForHost(host: ExecHost): ClaudeBackgroundAgents {
    let agents = this.backgroundAgents.get(host.id);
    if (!agents) {
      const poller: ClaudeBackgroundAgents = new ClaudeBackgroundAgents({
        cliPath: () => this.cliPath,
        hostId: host.id,
        ...(isWslHost(host)
          ? {
              // `claude agents` runs inside the helper (agents.list) — no
              // wsl.exe spawn per poll.
              execList: async () => {
                const channel = hosts().channel(host);
                if (!channel) throw new HostRpcError('not-ready', 'helper channel is not ready');
                const claudePath = hosts().status(host.id)?.claude.path ?? undefined;
                const result = await channel.request<{ stdout?: unknown } | null>(
                  'agents.list',
                  claudePath ? { claudePath } : {},
                );
                return typeof result?.stdout === 'string' ? result.stdout : '';
              },
              // Stop is a rare explicit action: one wsl.exe run.
              execStop: (agentId: string) =>
                hosts()
                  .execOn(
                    host,
                    {
                      file: hosts().status(host.id)?.claude.path ?? 'claude',
                      args: ['stop', agentId],
                      cwd: '/',
                    },
                    3_000,
                  )
                  .then(() => undefined),
              // Only while the channel is ready and the distro has claude
              // (status changes poke it). The poll is an RPC over that live
              // channel — it cannot boot a distro, and a stopped distro kills
              // the channel — so it never re-runs `wsl -l -v` (E1.3).
              eligible: async () =>
                hosts().fsReady(host) && Boolean(hosts().status(host.id)?.claude.path),
            }
          : {}),
        onChange: (agents) => {
          // A poll that finished after its host was dropped must not re-add rows.
          if (this.backgroundAgents.get(host.id) !== poller) return;
          this.agentsByHost.set(host.id, agents);
          this.agents = [...this.agentsByHost.values()].flat();
          this.emit();
        },
      });
      agents = poller;
      this.backgroundAgents.set(host.id, agents);
      if (this.started) agents.start();
    }
    return agents;
  }

  /** Hosts a status change must list (`statusRefreshTargets`): local, plus
   * every WSL host whose store has not started watching yet. A not-ready one
   * is only reported in `skippedHosts` (no I/O); a WSL store that already
   * watches lists itself once on its channel's return (`resync`) — helper
   * state flaps, env.get publishes and other hosts' changes never re-list it.
   * A host that left list() drops out of any refresh. */
  private statusRefreshHosts(): HostId[] {
    return statusRefreshTargets(
      hosts()
        .list()
        .map((host) => ({
          id: host.id,
          wsl: isWslHost(host),
          watching: this.stores.get(host.id)?.started === true,
        })),
    ) as HostId[];
  }

  /** Disposes per-host pollers/stores of hosts that left hosts().list(). A
   * WSL store survives its channel going down (rows kept, subscription kept
   * on the channel object); its resync re-subscribes and lists on ready. */
  private pruneHosts(): void {
    const listed = new Map(hosts().list().map((host) => [host.id, host]));
    for (const [id, store] of this.stores) {
      if (id === 'local' || listed.has(id)) continue;
      store.dispose();
      this.stores.delete(id);
    }
    for (const [id, agents] of this.backgroundAgents) {
      if (listed.has(id)) continue;
      agents.dispose();
      this.backgroundAgents.delete(id);
      if (this.agentsByHost.delete(id)) this.agents = [...this.agentsByHost.values()].flat();
    }
  }

  refreshAgents(): Promise<void> {
    return Promise.all([...this.backgroundAgents.values()].map((a) => a.refresh('manual'))).then(
      () => undefined,
    );
  }

  onWindowFocus(): void {
    for (const agents of this.backgroundAgents.values()) agents.onWindowFocus();
  }

  /** The surface just became 'claude' (applyLayout seam): one local re-list,
   * at most every SURFACE_REFRESH_MIN_MS. WSL hosts are not re-listed here —
   * their helper watch pushes every change. */
  onSurfaceEnter(): void {
    if (!this.started) return;
    const now = Date.now();
    if (!throttleDue(this.lastSurfaceRefreshAt, now, SURFACE_REFRESH_MIN_MS)) return;
    this.lastSurfaceRefreshAt = now;
    void this.refresh('surface', ['local']);
  }

  agentStop(agentId: string): Promise<void> {
    this.recordMutation('agentStop', { agentId });
    const hostId = (this.agents.find((a) => a.id === agentId)?.host ?? 'local') as HostId;
    return this.backgroundAgents.get(hostId)?.stop(agentId) ?? Promise.resolve();
  }

  // --- refresh -------------------------------------------------------------
  // Coalesced like cloudSessions.list: one in-flight store.list() plus at
  // most one dirty follow-up.
  // `onlyHosts` limits the re-list (watch-sourced: only the store that saw the
  // change); every other host keeps its previous rows. Omitted = every host.
  async refresh(source: string, onlyHosts?: readonly HostId[]): Promise<void> {
    const filter: Set<string> | null = onlyHosts ? new Set(onlyHosts) : null;
    if (this.refreshInFlight) {
      this.refreshDirty = {
        source,
        hosts: this.refreshDirty ? mergeRefreshHosts(this.refreshDirty.hosts, filter) : filter,
      };
      return;
    }
    this.refreshInFlight = true;
    this.pendingPatches = [];
    const t0 = Date.now();
    try {
      // One store per enabled host; a failed non-local host degrades to a
      // hostErrors line instead of taking the whole surface down.
      const list: ClaudeStoreSession[] = [];
      let localError: unknown = null;
      let storeComplete = true;
      const skippedHosts: HostId[] = [];
      const listedWsl = new Set<string>();
      let listedHosts = 0;
      this.pruneHosts();
      for (const host of hosts().list()) {
        if (this.started) {
          const agents = this.agentsForHost(host);
          agents.start();
          agents.poke();
        }
        if (filter && !filter.has(host.id)) {
          // Not part of this change: reuse its rows rather than re-list it.
          // Partial pass → no migration.
          storeComplete = false;
          list.push(...this.storeSessions.filter((s) => s.host === host.id));
          continue;
        }
        if (!hosts().fsReady(host)) {
          // Channel not ready: keep the previous rows so the sidebar doesn't
          // empty while the helper reconnects.
          storeComplete = false;
          skippedHosts.push(host.id);
          list.push(...this.storeSessions.filter((s) => s.host === host.id));
          continue;
        }
        try {
          // A host that became ready mid-run starts its watcher now.
          if (this.started) this.storeForHost(host).start();
          listedHosts += 1;
          list.push(...(await this.storeForHost(host).backend.list()));
          if (isWslHost(host)) listedWsl.add(host.id);
          hosts().setError(host.id, 'store', null);
        } catch (error) {
          storeComplete = false;
          if (!isWslHost(host)) {
            localError = error;
          } else {
            hosts().setError(
              host.id,
              'store',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
      if (localError) throw localError;
      let merged = list;
      for (const p of this.pendingPatches) merged = patchSessions(merged, p.hostId, p.updated, p.removed);
      this.pendingPatches = [];
      this.storeSessions = merged;
      const sessions = this.reconcileStore();
      this.migrateLegacyFoldersOnce(storeComplete);
      this.status = 'ready';
      this.error = null;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      // Every listed transcript gets an in-memory chat session (history lazy).
      for (const s of sessions) {
        this.host?.ensureSession(s.id, { cwd: s.cwd, host: s.host as HostId });
      }
      if (!this.restoredSelection) {
        this.restoredSelection = true;
        const last = state.settings?.current.claude.lastSessionId;
        if (!state.claudeSessionId && last && sessions.some((s) => s.id === last)) {
          this.open(last);
        }
      }
      log('claude', 'claude-list', {
        detail: { count: list.length, skippedHosts, listedHosts, ms: Date.now() - t0, source },
      });
      // A WSL listing is a first list or a channel resync: transcript writes
      // that landed while the helper was down / not yet subscribed produced
      // no watch event (the returning helper baselines existing files), so
      // terminal-owned chats on that host reload once.
      if (listedWsl.size > 0) {
        for (const row of this.storeSessions) {
          if (listedWsl.has(row.host)) this.scheduleTerminalHistoryReload(row.id);
        }
      }
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
        const { source, hosts: dirtyHosts } = this.refreshDirty;
        this.refreshDirty = null;
        void this.refresh(source, dirtyHosts ? ([...dirtyHosts] as HostId[]) : undefined);
      }
    }
  }

  /** @internal collaborators emit through this. */
  emit(): void {
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
    this.selectedSubagentId = null;
    state.claudeSessionId = sessionId;
    state.settings?.merge({ claude: { lastSessionId: sessionId } });
    this.registry = touchOpened(this.registry, sessionId, Date.now());
    this.registryStore.save(this.registry);
    log('claude', 'claude-select', { detail: { sessionId } });
    applyLayout();
    const chat = this.host;
    if (chat && !chat.isLoaded(sessionId)) {
      // A WSL history read fails while the helper channel is down — surface it.
      chat.loadHistory(sessionId).catch((error: unknown) => {
        this.lastError = { op: 'loadHistory', message: error instanceof Error ? error.message : String(error) };
        this.emit();
      });
    }
  }

  // --- Terminal tab (one-writer handoff) -------------------------------------
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

  // --- Subagents ---------------------------------------------------------------
  // Expand loads the row's `subagents` list (cached; null = not loaded).
  async loadSubagents(sessionId: string): Promise<ClaudeSubagent[]> {
    const cached = this.subagentLists.get(sessionId);
    if (cached) return cached;
    const subs: ClaudeSubagent[] = [];
    try {
      const agentIds = await this.storeForSession(sessionId).listSubagents(sessionId);
      for (const agentId of agentIds) {
        let title = `agent-${agentId}`;
        let messageCount: number | null = null;
        try {
          const messages = (await this.storeForSession(sessionId).subagentMessages(
            sessionId,
            agentId,
          )) as { type?: string; message?: { content?: unknown } }[];
          messageCount = messages.length;
          const firstUser = messages.find((m) => m.type === 'user');
          const content = firstUser?.message?.content;
          const text = Array.isArray(content)
            ? content
                .map((c) =>
                  typeof c === 'object' && c !== null
                    ? (c as { type?: string; text?: string }).type === 'text'
                      ? (c as { text?: string }).text
                      : null
                    : typeof c === 'string'
                      ? c
                      : null,
                )
                .filter(Boolean)
                .join(' ')
            : typeof content === 'string'
              ? content
              : '';
          if (text.trim()) title = titleFromPrompt(text);
        } catch {
          // An unreadable transcript keeps the agent-<id> fallback title.
        }
        subs.push({ agentId, parentSessionId: sessionId, title, messageCount });
      }
      this.subagentLists.set(sessionId, subs);
      this.emit();
    } catch {
      // listSubagents failure stays an empty (non-loaded) row.
    }
    return subs;
  }

  // Open a subagent transcript read-only in the chat column: a synthetic
  // `<sessionId>/<agentId>` chat session in the parent's scope.
  async openSubagent(sessionId: string, agentId: string): Promise<null> {
    const host = this.host;
    if (!host) throw new Error('claude host not started');
    const key = `${sessionId}/${agentId}`;
    host.ensureSubagentSession(key, {
      cwd:
        getChatState().sessions[sessionId]?.cwd ??
        this.sessions.find((s) => s.id === sessionId)?.cwd ??
        null,
      host: this.hostIdFor(sessionId),
    });
    await host.loadSubagentHistory(key, sessionId, agentId);
    this.selectedSubagentId = agentId;
    this.emit();
    return null;
  }

  // Transcript/subagent file changes from the store watcher. A terminal-
  // owned session's own file → debounced loadHistory (terminal turns appear
  // live in the chat column); any change → invalidate the subagent list.
  private onTranscriptFiles(files: string[]): void {
    for (const file of files) {
      // fs.watch filenames are relative to <configDir>/projects:
      //   <encoded-cwd>\<id>.jsonl            — the session transcript
      //   <encoded-cwd>\<id>\subagents\…      — a subagent transcript
      const parts = file.split(/[\\/]+/);
      const name = parts[parts.length - 1] ?? '';
      const parentDir = parts[parts.length - 2] ?? '';
      const sessionId =
        parentDir === 'subagents'
          ? (parts[parts.length - 3] ?? null)
          : name.endsWith('.jsonl')
            ? name.slice(0, -'.jsonl'.length)
            : null;
      if (!sessionId) continue;
      if (this.subagentLists.delete(sessionId)) this.emit();
      this.scheduleTerminalHistoryReload(sessionId);
    }
  }

  /** Debounced (1 s) loadHistory for a terminal-owned session; a no-op for
   * any other session or while one is pending / in flight. */
  private scheduleTerminalHistoryReload(sessionId: string): void {
    if (getChatState().sessions[sessionId]?.terminalOwned !== true) return;
    if (this.historyInFlight.has(sessionId)) return;
    if (this.historyTimers.has(sessionId)) return;
    this.historyTimers.set(
      sessionId,
      setTimeout(() => {
        this.historyTimers.delete(sessionId);
        this.historyInFlight.add(sessionId);
        const host = this.host;
        if (!host) {
          this.historyInFlight.delete(sessionId);
          return;
        }
        void host.loadHistory(sessionId).finally(() => {
          this.historyInFlight.delete(sessionId);
        });
      }, 1_000),
    );
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
  // mode AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD stands in for the picker.
  async newSession(cwd: string | null): Promise<string | null> {
    let dir = cwd;
    if (!dir) {
      const envCwd = testMode ? process.env.AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD?.trim() : '';
      if (envCwd) dir = envCwd;
      else {
        const win = state.windowRef;
        if (!win) return null;
        const defaultPath = await this.pickerDefaultPath();
        const result = await openFolderDialog(win, {
          title: 'Choose the working directory for the new Claude session',
          properties: ['openDirectory', 'createDirectory'],
          ...(defaultPath ? { defaultPath } : {}),
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        dir = result.filePaths[0]!;
      }
    }
    this.recordMutation('newSession', {});
    // A UNC pick (\\wsl.localhost\<D>\…) selects the wsl host; the stored
    // cwd is the linux path inside that distro.
    const hostId = hosts().pathHostId(dir);
    const execHost = hosts().hostById(hostId) ?? LOCAL_HOST;
    const storedDir = isWslHost(execHost) ? hosts().hostPath(execHost, dir) : dir;
    const id = this.host?.newSession(storedDir, hostId) ?? null;
    if (id) {
      this.open(id);
      // touchOpened created the entry with the default local host.
      const entry = this.registry.entries[id];
      if (entry && entry.host !== hostId) {
        this.registry = {
          ...this.registry,
          entries: { ...this.registry.entries, [id]: { ...entry, host: hostId } },
        };
        this.registryStore.save(this.registry);
      }
    }
    return id;
  }

  rename(sessionId: string, title: string): Promise<void> {
    this.recordMutation('rename', { sessionId });
    return this.mutate('rename', async () => {
      await this.storeForSession(sessionId).rename(sessionId, title);
      // The watcher re-lists; refresh now so the title lands even when the
      // watch event is delayed.
      await this.refresh('mutate');
    });
  }

  fork(sessionId: string): Promise<void> {
    this.recordMutation('fork', { sessionId });
    return this.mutate('fork', async () => {
      const forkedId = await this.storeForSession(sessionId).fork(sessionId);
      const source = this.registry.entries[sessionId];
      // Pin follows the fork; archive/removal state does not. (ux2: folder is
      // derived — the fork files itself from its cwd, same as the source.)
      if (source?.pinned) {
        this.registry = {
          ...this.registry,
          entries: {
            ...this.registry.entries,
            // The fork lands next to its source on the same host.
            [forkedId]: { ...source, id: forkedId },
          },
        };
        this.registryStore.save(this.registry);
      }
      this.open(forkedId);
      await this.refresh('mutate');
    });
  }

  // --- workspaces (ux2 D8) ---------------------------------------------------
  // The workspace list/labels live in settings.claude.*; a session's folder
  // is derived (exact host+cwd match in reconcile) — never stored.

  // Where the New session / Add workspace pickers start (ux3 S3):
  // claude.pickerFolder when it exists, else the configured default WSL
  // distro's home, else undefined (the OS decides). A missing configured
  // folder is logged and skipped, never cleared.
  private pickerDefaultPath(): Promise<string | undefined> {
    const claude = state.settings?.current.claude;
    const defaultDistro = claude?.defaultWslDistro;
    const defaultHost = defaultDistro ? hosts().hostById(`wsl:${defaultDistro}`) : null;
    const distroHome =
      defaultHost && isWslHost(defaultHost)
        ? hosts().windowsPath(defaultHost, defaultHost.home ?? '/')
        : undefined;
    return pickerStartPath(claude?.pickerFolder ?? null, distroHome, (p) => hosts().pathExists(p), () =>
      log('claude', 'picker-folder-missing', { detail: { surface: 'claude' } }),
    );
  }

  // Picks a directory (same seam as newSession(null): test mode reads
  // AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD, else the folder dialog starting in
  // pickerDefaultPath()).
  private async pickWorkspaceDir(title: string): Promise<string | null> {
    const envCwd = testMode ? process.env.AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD?.trim() : '';
    if (envCwd) return envCwd;
    const win = state.windowRef;
    if (!win) return null;
    const defaultPath = await this.pickerDefaultPath();
    const result = await openFolderDialog(win, {
      title,
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  }

  async workspaceAdd(path?: string): Promise<void> {
    this.recordMutation('workspaceAdd', {});
    const picked = path ?? (await this.pickWorkspaceDir('Add Claude workspace folder'));
    if (!picked) return;
    const normalized = resolve(picked);
    const current = state.settings?.current.claude.workspaces ?? [];
    if (current.includes(normalized)) return;
    state.settings?.merge({ claude: { workspaces: [...current, normalized] } });
    applyLayout();
    const hostId = hosts().pathHostId(normalized);
    log('claude', 'claude-workspace-add', { detail: { host: hostId } });
    this.rederive();
  }

  workspaceReorder(paths: string[]): Promise<void> {
    this.recordMutation('workspaceReorder', { count: paths.length });
    return this.mutate('workspaceReorder', () => {
      const current = state.settings?.current.claude.workspaces ?? [];
      const next = reorderWorkspaces(current, paths);
      if (next === current) return;
      state.settings?.merge({ claude: { workspaces: next } });
      applyLayout();
      log('claude', 'claude-workspace-reorder', { detail: { count: next.length } });
      this.emit();
    });
  }

  sessionReorder(section: string, ids: string[]): Promise<void> {
    this.recordMutation('sessionReorder', { count: ids.length });
    return this.mutate('sessionReorder', () => {
      const current = state.settings?.current.claude.sessionOrder ?? {};
      state.settings?.merge({
        claude: { sessionOrder: { ...current, [section]: ids } },
      });
      applyLayout();
      const kind =
        section === 'pinned' || section === 'recent' || section === 'participated'
          ? section
          : 'folder';
      log('claude', 'claude-session-reorder', {
        detail: { section: kind, count: ids.length },
      });
      this.emit();
    });
  }

  workspaceRename(path: string, label: string): Promise<void> {
    this.recordMutation('workspaceRename', {});
    return this.mutate('workspaceRename', () => {
      const normalized = resolve(path);
      const labels = state.settings?.current.claude.workspaceLabels ?? {};
      state.settings?.merge({
        claude: { workspaceLabels: renameWorkspace(labels, normalized, label) },
      });
      applyLayout();
      log('claude', 'claude-workspace-rename', {});
      this.emit();
    });
  }

  async workspaceRemove(path: string): Promise<void> {
    this.recordMutation('workspaceRemove', {});
    const win = state.windowRef;
    let confirmed = testMode;
    if (!confirmed && win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Remove', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Remove workspace "${defaultWorkspaceLabel(resolve(path))}"?`,
        detail: 'Sessions stay — they just file under Recent.',
      });
      confirmed = response === 0;
    }
    if (!confirmed) return;
    const normalized = resolve(path);
    const current = state.settings?.current.claude;
    const labels = { ...(current?.workspaceLabels ?? {}) };
    delete labels[normalized];
    const order = { ...(current?.sessionOrder ?? {}) };
    delete order[normalized];
    state.settings?.merge({
      claude: {
        workspaces: (current?.workspaces ?? []).filter((p) => p !== normalized),
        workspaceLabels: labels,
        sessionOrder: order,
      },
    });
    applyLayout();
    log('claude', 'claude-workspace-remove', {});
    this.rederive();
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
      await this.storeForSession(sessionId).delete(sessionId);
      const entries = { ...this.registry.entries };
      delete entries[sessionId];
      this.applyRegistry({ ...this.registry, entries });
      this.forget(sessionId);
      await this.refresh('mutate');
    });
  }

  async revealTranscript(sessionId: string): Promise<void> {
    this.recordMutation('revealTranscript', { sessionId });
    try {
      // WSL: store.transcriptPath over the channel → the \\wsl.localhost form.
      const path = await this.storeForSession(sessionId).transcriptPath(sessionId);
      if (!path) return;
      if (testMode) this.revealed.push(path);
      else shell.showItemInFolder(path);
    } catch (error) {
      this.lastError = { op: 'revealTranscript', message: error instanceof Error ? error.message : String(error) };
      this.emit();
    }
  }

  /** Test hook: every path revealTranscript would have shown in Explorer. */
  revealedPaths(): string[] {
    return [...this.revealed];
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

  private workspaceOpts(): { workspaces: string[]; uncRoot?: string | undefined; uncHostId?: HostId | undefined } {
    return {
      workspaces: state.settings?.current.claude.workspaces ?? [],
      ...(testMode && process.env.AGENT_WORKSPACE_TEST_WSL_UNC_ROOT
        ? {
            uncRoot: process.env.AGENT_WORKSPACE_TEST_WSL_UNC_ROOT,
            uncHostId: hosts().list().find((h) => h.kind === 'wsl')?.id,
          }
        : {}),
    };
  }

  // One-shot (ux2 D8): legacy free-form registry folders → path-bound
  // workspaces. Runs once after the first successful refresh; the legacy
  // fields are then stripped (registryFileObject deletes them by name).
  private migratedLegacyFolders = false;
  private migrateLegacyFoldersOnce(storeComplete: boolean): void {
    if (this.migratedLegacyFolders) return;
    const legacy = this.registry.legacyFolders ?? [];
    if (legacy.length === 0) {
      this.migratedLegacyFolders = true;
      return;
    }
    // A failed host store looks like "no candidates" — defer to the next
    // complete refresh rather than dropping those folders permanently.
    if (!storeComplete) return;
    this.migratedLegacyFolders = true;
    const settings = state.settings?.current;
    if (!settings || settings.claude.workspaces.length > 0) {
      this.stripLegacyFolders();
      return;
    }
    const candidates = this.storeSessions.map((stored) => ({
      id: stored.id,
      host: stored.host as HostId,
      cwd: stored.cwd,
      folder: this.registry.entries[stored.id]?.folder ?? null,
    }));
    const toWindows = (host: HostId, cwd: string): string | null => {
      const execHost = hosts().hostById(host) ?? null;
      // Unknown/disabled host → null (never store a linux cwd as a workspace).
      return execHost ? hosts().windowsPath(execHost, cwd) : null;
    };
    const result = migrateLegacyFolders(legacy, candidates, toWindows);
    if (result.workspaces.length > 0) {
      state.settings?.merge({
        claude: {
          workspaces: [...(settings.claude.workspaces ?? []), ...result.workspaces],
          workspaceLabels: { ...settings.claude.workspaceLabels, ...result.labels },
        },
      });
      applyLayout();
    }
    this.stripLegacyFolders();
    log('claude', 'claude-folders-migrated', {
      detail: { converted: result.converted, dropped: result.dropped },
    });
  }

  private stripLegacyFolders(): void {
    const reg = this.registry;
    const hasFolder = Object.values(reg.entries).some((e) => e.folder !== undefined);
    if (!reg.legacyFolders && !hasFolder) return;
    this.registry = {
      ...reg,
      entries: Object.fromEntries(
        Object.entries(reg.entries).map(([id, e]) => {
          const { folder: _f, ...rest } = e;
          return [id, rest];
        }),
      ),
    };
    delete this.registry.legacyFolders;
    this.registryStore.save(this.registry);
  }

  private applyRegistry(next: ClaudeRegistry): void {
    this.registry = next;
    this.registryStore.save(next);
    this.rederive();
  }

  // Re-run reconcile against the same store rows — workspace mutations change
  // the derived folder without touching the registry or store.
  private rederive(): void {
    const { sessions } = reconcile(this.registry, this.storeSessions, {
      now: Date.now(),
      autoArchiveDays: state.settings?.current.claude.autoArchiveDays ?? 0,
      ...this.workspaceOpts(),
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
      this.hook.resetOffBackoff();
      this.hook.applyHooks();
      this.emit();
    }
  }

  // --- context menus ------------------------------------------------------
  // Building lives in ClaudeContextMenu; these keep the public signatures.

  menuItems(): Record<string, unknown>[] {
    return this.menu.items();
  }

  clickMenuItem(id: string): { action: MenuAction } {
    return this.menu.clickItem(id);
  }

  contextMenu(arg: {
    kind: 'session' | 'workspace' | 'header' | 'agent';
    sessionId?: string | undefined;
    path?: string | undefined;
    agentId?: string | undefined;
    x: number;
    y: number;
  }): Promise<{ action: MenuAction; items?: Record<string, unknown>[] }> {
    return this.menu.popup(arg);
  }

  mutationLog(): { op: string; payload: Record<string, unknown> }[] {
    return this.mutations;
  }

  dispose(): void {
    for (const agents of this.backgroundAgents.values()) agents.dispose();
    this.backgroundAgents.clear();
    if (terminalHost.claudeGate) terminalHost.claudeGate = null;
    this.hook.stop();
    this.pr.stop();
    for (const timer of this.historyTimers.values()) clearTimeout(timer);
    this.historyTimers.clear();
    for (const store of this.stores.values()) store.dispose();
    this.stores.clear();
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
  // The un-started fallback can be created at any time (publicState() before
  // setupClaude()), so it must not read the live env var either.
  const configDir = opts?.configDir ?? hosts().localConfigDir();
  const userData = opts?.userData ?? app.getPath('userData');
  return new ClaudeSessions({
    configDir,
    registryStore: new ClaudeRegistryStore(userData),
    userData,
  });
}
