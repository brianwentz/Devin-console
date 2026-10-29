// Cloud session sidebar data layer. Opens a JSON-RPC websocket to
// wss://<tenant>/api/acp/live using the web app's own access token — which is
// read inside the devinView via executeJavaScript and never leaves this
// class. No titles/folder names/user ids/tokens are ever logged.

import { app, clipboard, dialog, Menu, net, shell, webContents } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acpWsUrl,
  buildInitializeParams,
  buildListParams,
  NEW_SESSION_WATCH_DELAYS_MS,
  parseListResult,
  parseUsersInfo,
  sanitizeToken,
  usersInfoUrl,
  type CloudListResult,
  type CloudSession,
} from '../core/cloudAcp';
import { parseCloudCache, serializeCloudCache } from '../core/cloudCache';
import {
  CHILD_CAP,
  createFolderPaging,
  createPageFetch,
  PAGING_CONFIG,
  type ArchivedStatus,
  type FolderPaging,
  type ListContext,
  type PageFetch,
  type PagingConfig,
} from '../core/cloudFolderPaging';
import {
  DEVIN_CLOUD_CAPABILITIES,
  type CloudSourceCapabilities,
} from '../core/cloudKit/capabilities';
import {
  addFolder,
  moveSession,
  removeFolder,
  renameFolder,
  reorderFolders,
  setArchived,
  type CloudListData,
} from '../core/sessionTree';
import { CloudSessionSchema, type CloudState } from '../shared/ipc';
import { z } from 'zod';
import { log } from './log';
import { cloudViews } from './cloudViews';
import { openNewSession } from './shortcuts';
import { parseSessionId } from '../core/sessions';
import { originOf, state, testMode } from './state';
import { applyLayout, notifyShell } from './window';

const TOKEN_BACKOFF_MIN_MS = 2_000;
const TOKEN_BACKOFF_MAX_MS = 20_000;
const TOKEN_GRACE_MS = 90_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 15_000;
const POLL_FOCUSED_MS = 15_000;
const POLL_IDLE_MS = 60_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const WATCHDOG_MS = 30_000;
const ORG_SYNC_DEBOUNCE_MS = 2_000;
// Window in which a home→session rekey is filed under a pending new-session
// folder — beyond that the navigation is treated as unrelated.
const NEW_SESSION_FILE_WINDOW_MS = 15 * 60_000;

export type TokenFailReason =
  | 'view-not-ready'
  | 'no-devindebug'
  | 'login-required'
  | 'timeout'
  | 'error';

const FixtureSchema = z.object({
  sessions: z.array(CloudSessionSchema),
  folders: z.array(z.string()).default([]),
  folderTotals: z.record(z.string(), z.number()).default({}),
  nextCursor: z.string().nullable().default(null),
  // Folder-paging seam: folders[k] is the full server content of k (roots +
  // children); the fixture fetch serves R1-shaped slices of it.
  paging: z
    .object({
      pageSize: z.number().int().positive(),
      childCap: z.number().int().positive().optional(),
      folders: z.record(z.string(), z.array(CloudSessionSchema)),
    })
    .optional(),
});
type FixturePaging = NonNullable<z.infer<typeof FixtureSchema>['paging']>;

const EMPTY_PAGE: CloudListResult = { sessions: [], folders: [], folderTotals: {}, nextCursor: null };

function sameListContext(a: ListContext, b: ListContext): boolean {
  return a.socketGen === b.socketGen && a.orgId === b.orgId && a.archivedStatus === b.archivedStatus;
}

// Fixture stand-in for a folder page: the top-level rows [offset,
// offset+pageSize) of folders[k] plus their direct children, capped at
// childCap with hasMoreChildren set on a capped root.
function fixturePageFetch(paging: FixturePaging, childCap: number): PageFetch {
  return (req) => {
    const rows = paging.folders[req.folder] ?? [];
    const ids = new Set(rows.map((row) => row.id));
    const top = rows.filter((row) => row.parentId === null || !ids.has(row.parentId));
    const sessions: CloudSession[] = [];
    for (const root of top.slice(req.rootsOffset, req.rootsOffset + req.pageSize)) {
      const children = rows.filter((row) => row.parentId === root.id);
      sessions.push(
        children.length > childCap ? { ...root, hasMoreChildren: true } : root,
        ...children.slice(0, childCap),
      );
    }
    return Promise.resolve({ ...EMPTY_PAGE, sessions });
  };
}

type Pending = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
};

class CloudSessions {
  private token: string | null = null;
  // Kept so error messages logged after a rotation are still scrubbed.
  private lastToken: string | null = null;
  private orgId: string | null = null;
  private userId: string | null = null;
  private userPreferencesUrl: string | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private sessions: CloudSession[] = [];
  private folders: string[] = [];
  private folderTotals: Record<string, number> = {};
  private incompleteFolders: string[] = [];
  private status: CloudState['status'] = 'disabled';
  private lastSyncAt: string | null = null;
  private error: string | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastSnapshotJson = '';
  private started = false;
  private fixtureFile: string | null = null;
  // Serialises fixture reloads (each one may page) so they land in order.
  private fixtureChain: Promise<void> = Promise.resolve();
  // Bumped per new socket — a paged list built on an older socket is discarded.
  private socketGen = 0;
  private pagingConfig: PagingConfig = PAGING_CONFIG;
  private paging: FolderPaging = this.createPaging(PAGING_CONFIG);
  private unsubActiveNavigate: (() => void) | null = null;
  private tokenInFlight: Promise<void> | null = null;
  private tokenBackoffMs = TOKEN_BACKOFF_MIN_MS;
  private firstTokenAttemptAt: number | null = null;
  private listInFlight = false;
  private listDirty: string | null = null;
  private syncInFlight: Promise<void> | null = null;
  private lastOrgSyncAt = 0;
  private emptyListSynced = false;
  private showArchived = false;
  // Gates the sidebar controls (shell, via snapshot) and the menu items below.
  private readonly capabilities: CloudSourceCapabilities = DEVIN_CLOUD_CAPABILITIES;
  private cached = false;
  private lastCacheJson = '';
  private pendingNewSession: { folder: string; at: number } | null = null;
  private newSessionWatch: {
    sessionId: string;
    folder: string | null;
    startedAt: number;
    attempt: number;
  } | null = null;
  private newSessionTimer: NodeJS.Timeout | null = null;
  private lastError: { op: string; message: string } | null = null;
  // Test mode records every mutation ({op, method, path, body}) — no network.
  private mutations: { op: string; payload: Record<string, unknown> }[] = [];
  private readonly onViewReady = () => {
    if (!this.token) {
      void this.obtainToken();
      return;
    }
    // Follow the page's current org — the view may switch tenants.
    if (Date.now() - this.lastOrgSyncAt < ORG_SYNC_DEBOUNCE_MS) return;
    this.lastOrgSyncAt = Date.now();
    void this.syncOrg('navigate');
  };

  snapshot(): CloudState {
    return {
      status: this.status,
      lastSyncAt: this.lastSyncAt,
      error: this.error,
      folders: this.folders,
      folderTotals: this.folderTotals,
      // A cached list is never marked partial — "Show more" waits for a live list.
      incompleteFolders: this.cached ? [] : this.incompleteFolders,
      sessions: this.sessions,
      liveSessionIds: cloudViews().publicInfo().liveSessionIds,
      showArchived: this.showArchived,
      lastError: this.lastError,
      cached: this.cached,
      capabilities: this.capabilities,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (testMode) {
      this.fixtureFile = process.env.AGENT_WORKSPACE_TEST_CLOUD_SESSIONS ?? null;
      const cacheFile = process.env.AGENT_WORKSPACE_TEST_CLOUD_CACHE ?? null;
      if (this.fixtureFile) {
        this.paging.requestForce({ all: true });
        void this.loadFixture('start');
      } else if (cacheFile) {
        // Cache-only test mode: render the cached list under 'connecting'.
        this.setStatus('connecting');
        this.loadCache(cacheFile);
      } else {
        // The fixture tenant has no devinDebug — stay inert.
        this.setStatus('disabled');
      }
      this.emit();
      return;
    }
    this.setStatus('connecting');
    this.loadCache(join(app.getPath('userData'), 'cloud-cache.json'));
    // The pool fires this on every active-view navigation/finish-load AND on
    // each activation — the token re-read gates itself on the tenant URL.
    this.unsubActiveNavigate = cloudViews().onActiveNavigate(this.onViewReady);
    this.emit();
    void this.obtainToken();
    // Self-heal for any "no socket, no timer, nothing in flight" wedge.
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_MS);
    this.watchdogTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.unsubActiveNavigate?.();
    this.unsubActiveNavigate = null;
    this.closeSocket();
    this.paging.reset();
  }

  // Resolves once a fixture reload has landed (test hook); live lists run in
  // the background.
  refresh(reason: string): Promise<void> {
    // An explicit refresh re-pages every folder instead of reusing the memo.
    if (reason === 'shell' || reason === 'test') this.paging.requestForce({ all: true });
    if (this.fixtureFile) return this.loadFixture(reason);
    if (!this.started || (testMode && !this.fixtureFile)) return Promise.resolve();
    if (reason === 'shell' && this.socket?.readyState !== WebSocket.OPEN) {
      // Manual refresh — force a reconnect instead of waiting out a hung
      // socket or a long backoff.
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.closeSocket();
      this.token = null;
      this.backoffMs = BACKOFF_MIN_MS;
      log('cloud', 'cloud-refresh-force', { detail: { status: this.status } });
      void this.obtainToken();
      return Promise.resolve();
    }
    if (!this.token) {
      void this.obtainToken();
      return Promise.resolve();
    }
    return (async () => {
      // The page may have switched orgs — a reconnect re-lists via the
      // handshake, so only list when we're still on the same socket.
      const socketBefore = this.socket;
      await this.syncOrg(reason);
      if (this.socket === socketBefore && this.socket?.readyState === WebSocket.OPEN) {
        void this.list(reason);
      }
    })();
  }

  // "Show more": the next list pages this folder first, from offset 0, with a
  // doubled page allowance — through list() coalescing, never a side request.
  loadMore(folder: string): void {
    if (!this.started) return;
    this.paging.loadMore(folder);
    if (this.fixtureFile) {
      void this.loadFixture('load-more');
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) void this.list('load-more');
  }

  // Sidebar row click: the stored url is verified against the tenant before
  // navigating so a tampered payload can't steer the Cloud view.
  openSession(sessionId: string): void {
    this.pendingNewSession = null;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || parseSessionId(session.url, state.tenantUrl) !== sessionId) {
      log('cloud', 'cloud-open', { detail: { sessionId, found: false } });
      return;
    }
    state.surface = 'cloud';
    cloudViews().show(sessionId, session.url);
    applyLayout();
    log('cloud', 'cloud-open', { detail: { sessionId } });
  }

  // 'New session' entry points record a pending folder, then reuse the
  // Ctrl+N path (the web app's composer lives on the tenant root). When the
  // HOME view navigates to the session the composer created, rekey() calls
  // noteHomeNavigation which watches for it to be listed, then files it.
  newSession(folder: string | null): void {
    this.cancelNewSessionWatch();
    this.pendingNewSession = folder ? { folder, at: Date.now() } : null;
    if (testMode) {
      this.mutations.push({ op: 'new-session', payload: { folder } });
    }
    log('cloud', 'cloud-new-session', { detail: { inFolder: folder !== null } });
    openNewSession();
  }

  // The composer navigates home→/sessions/<id> seconds before the backend
  // lists it, so instead of filing immediately we watch: re-list on a backoff
  // until the id appears (settleNewSession) or the delays run out.
  noteHomeNavigation(sessionId: string): void {
    if (this.sessions.some((s) => s.id === sessionId)) {
      // Already listed — the user clicked an existing session in the web
      // app's own sidebar, not a freshly created one.
      this.pendingNewSession = null;
      log('cloud', 'cloud-new-session-skip', { detail: { reason: 'existing' } });
      return;
    }
    const pending = this.pendingNewSession;
    this.pendingNewSession = null;
    const folder =
      pending && Date.now() - pending.at <= NEW_SESSION_FILE_WINDOW_MS
        ? pending.folder
        : null;
    this.cancelNewSessionWatch();
    this.newSessionWatch = { sessionId, folder, startedAt: Date.now(), attempt: 0 };
    this.scheduleNewSessionWatch();
  }

  private scheduleNewSessionWatch(): void {
    const watch = this.newSessionWatch;
    if (!watch) return;
    if (watch.attempt >= NEW_SESSION_WATCH_DELAYS_MS.length) {
      this.newSessionWatch = null;
      log('cloud', 'cloud-new-session-skip', {
        detail: { reason: 'not-listed', attempts: watch.attempt },
      });
      return;
    }
    const delay = NEW_SESSION_WATCH_DELAYS_MS[watch.attempt];
    watch.attempt++;
    this.newSessionTimer = setTimeout(() => {
      this.newSessionTimer = null;
      if (!this.newSessionWatch) return;
      if (this.socket?.readyState === WebSocket.OPEN) void this.list('new-session');
      this.scheduleNewSessionWatch();
    }, delay);
  }

  private cancelNewSessionWatch(): void {
    this.newSessionWatch = null;
    if (this.newSessionTimer) {
      clearTimeout(this.newSessionTimer);
      this.newSessionTimer = null;
    }
  }

  // Runs after every successful list (live socket or fixture reload): once the
  // watched id shows up, file it under the pending folder via sessionMove.
  private settleNewSession(): void {
    const watch = this.newSessionWatch;
    if (!watch) return;
    if (!this.sessions.some((s) => s.id === watch.sessionId)) return;
    this.cancelNewSessionWatch();
    log('cloud', 'cloud-new-session-settled', {
      detail: {
        attempts: watch.attempt,
        durationMs: Date.now() - watch.startedAt,
        filed: watch.folder !== null,
      },
    });
    if (watch.folder !== null) void this.sessionMove(watch.sessionId, watch.folder);
  }

  prefetchSession(sessionId: string): void {
    if (this.status !== 'ready') return;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || parseSessionId(session.url, state.tenantUrl) !== sessionId) return;
    cloudViews().prefetch(sessionId, session.url);
  }

  // --- mutations (folders / move / archive) -------------------------------
  // Same REST base + headers as users/info. Log only {op, ok, status} —
  // never names or ids. `applyLocal` models the change for test mode (the
  // fake backend) while real calls re-list on success.

  private async mutate(
    op: string,
    method: 'POST' | 'DELETE',
    path: string,
    body: unknown,
    applyLocal: (data: CloudListData) => CloudListData,
  ): Promise<void> {
    if (testMode) {
      this.mutations.push({ op, payload: { method, path, body } });
      if (this.fixtureFile) {
        const next = applyLocal({
          sessions: this.sessions,
          folders: this.folders,
          folderTotals: this.folderTotals,
          incompleteFolders: this.incompleteFolders,
        });
        this.sessions = next.sessions;
        this.folders = next.folders;
        this.folderTotals = next.folderTotals;
        this.incompleteFolders = next.incompleteFolders ?? [];
        this.lastSyncAt = new Date().toISOString();
        this.emit();
      }
      log('cloud', 'cloud-mutate', { detail: { op, ok: true, status: 0 } });
      return;
    }
    const url = `${state.tenantUrl.replace(/\/+$/, '')}/api/${path}`;
    const send = () =>
      net.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'x-cog-org-id': this.orgId ?? '',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      let response = await send();
      if (response.status === 401) {
        // Stale token — re-read once through the single-flight path, retry once.
        this.token = null;
        await this.obtainToken();
        if (this.token) response = await send();
      }
      const ok = response.status >= 200 && response.status < 300;
      log('cloud', 'cloud-mutate', { detail: { op, ok, status: response.status } });
      if (!ok) {
        this.setMutationError(op, `HTTP ${response.status}`);
        return;
      }
      this.lastError = null;
      if (this.socket?.readyState === WebSocket.OPEN) void this.list('mutate');
    } catch {
      log('cloud', 'cloud-mutate', { detail: { op, ok: false, status: -1 } });
      this.setMutationError(op, 'network');
    }
  }

  private setMutationError(op: string, message: string): void {
    this.lastError = { op, message };
    this.emit();
  }

  mutationLog(): { op: string; payload: Record<string, unknown> }[] {
    return this.mutations;
  }

  // Test-mode menu seam (see contextMenu): last popup description + click.
  private pendingMenu = new Map<string, Electron.MenuItemConstructorOptions>();
  private lastMenuDesc: Record<string, unknown>[] = [];
  private pendingAction: 'rename' | 'new-folder' | null = null;

  menuItems(): Record<string, unknown>[] {
    return this.lastMenuDesc;
  }

  clickMenuItem(id: string): { action: 'rename' | 'new-folder' | null } {
    const item = this.pendingMenu.get(id);
    if (!item?.click) return { action: null };
    // Native checkboxes toggle before firing click — mirror that.
    const next = !(item.checked ?? false);
    item.checked = next;
    item.click(
      { checked: next } as Electron.MenuItem,
      state.windowRef!,
      {} as Electron.KeyboardEvent,
    );
    const action = this.pendingAction;
    this.pendingAction = null;
    return { action };
  }

  private userFolders(): string[] {
    return this.folders.filter((f) => f !== 'pinned' && f !== 'participated');
  }

  folderCreate(name: string): Promise<void> {
    return this.mutate('folder-create', 'POST', 'sessions/folder/create', { folder: name }, (d) =>
      addFolder(d, name),
    );
  }

  folderRename(oldName: string, newName: string): Promise<void> {
    return this.mutate(
      'folder-rename',
      'POST',
      'sessions/folder/rename',
      { old_name: oldName, new_name: newName },
      (d) => renameFolder(d, oldName, newName),
    );
  }

  folderDelete(name: string): Promise<void> {
    return this.mutate(
      'folder-delete',
      'DELETE',
      `sessions/folder?name=${encodeURIComponent(name)}`,
      undefined,
      (d) => removeFolder(d, name),
    );
  }

  folderReorder(names: string[]): Promise<void> {
    const userFolders = names.filter((n) => n !== 'pinned' && n !== 'participated');
    return this.mutate(
      'folder-reorder',
      'POST',
      'sessions/folder/reorder',
      { folder_names: userFolders },
      (d) => reorderFolders(d, userFolders),
    );
  }

  sessionMove(sessionId: string, folder: string | null): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.resolve();
    // The target may have been deleted between 'New session in folder' and
    // the session actually being listed.
    if (folder !== null && !this.folders.includes(folder)) {
      log('cloud', 'cloud-new-session-skip', { detail: { reason: 'folder-gone' } });
      return Promise.resolve();
    }
    if (folder === null) {
      return this.mutate(
        'session-move',
        'DELETE',
        `sessions/folder/${session.acpId}`,
        undefined,
        (d) => moveSession(d, sessionId, null),
      );
    }
    return this.mutate(
      'session-move',
      'POST',
      'sessions/folder',
      { devin_id: session.acpId, folder },
      (d) => moveSession(d, sessionId, folder),
    );
  }

  sessionArchive(sessionId: string, archive: boolean): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return Promise.resolve();
    return this.mutate(
      'session-archive',
      'POST',
      'sessions/bulk-archive',
      { session_ids: [session.acpId], archive, close_pr_urls: [] },
      (d) => setArchived(d, sessionId, archive),
    );
  }

  sessionLink(sessionId: string): string | null {
    if (!this.sessions.some((s) => s.id === sessionId)) return null;
    return new URL(`/sessions/${sessionId}`, state.tenantUrl).toString();
  }

  copyLink(sessionId: string): void {
    const link = this.sessionLink(sessionId);
    if (!link) return;
    if (testMode) {
      // Record the write so e2e doesn't depend on the OS clipboard.
      this.mutations.push({ op: 'copy-link', payload: { link } });
    }
    clipboard.writeText(link);
  }

  setShowArchived(value: boolean): void {
    if (this.showArchived === value) return;
    this.showArchived = value;
    if (testMode) {
      this.mutations.push({ op: 'show-archived', payload: { value } });
    }
    this.paging.requestForce({ all: true });
    this.emit();
    if (this.socket?.readyState === WebSocket.OPEN) void this.list('shell');
  }

  // --- context menus ------------------------------------------------------
  // Native menus popped at the shell window; the invoke resolves to an
  // action the shell completes inline ({action: 'rename'|'new-folder'}).

  async contextMenu(arg: {
    kind: 'session' | 'folder' | 'header';
    sessionId?: string | undefined;
    name?: string | undefined;
    x: number;
    y: number;
  }): Promise<{
    action: 'rename' | 'new-folder' | null;
    items?: Record<string, unknown>[];
  }> {
    this.pendingAction = null;
    const items: Electron.MenuItemConstructorOptions[] = [];

    if (arg.kind === 'header') {
      items.push({ label: 'New session', click: () => this.newSession(null) });
      if (this.capabilities.archive) {
        items.push(
          { type: 'separator' },
          {
            label: 'Show archived sessions',
            type: 'checkbox',
            checked: this.showArchived,
            click: (item) => this.setShowArchived(item.checked),
          },
        );
      }
    } else if (arg.kind === 'folder' && arg.name && this.capabilities.folders === 'server') {
      const name = arg.name;
      items.push(
        { label: 'New session in folder', click: () => this.newSession(name) },
        { type: 'separator' },
        {
          label: 'Rename…',
          click: () => {
            this.pendingAction = 'rename';
          },
        },
        {
          label: 'Delete…',
          click: () => void this.confirmDeleteFolder(name),
        },
      );
    } else if (arg.kind === 'session' && arg.sessionId) {
      const session = this.sessions.find((s) => s.id === arg.sessionId);
      if (!session) return { action: null };
      const link = new URL(`/sessions/${session.id}`, state.tenantUrl).toString();
      const submenu: Electron.MenuItemConstructorOptions[] = this.folders.map((name) => ({
        label: name,
        type: 'checkbox',
        checked: session.folder === name,
        click: () => void this.sessionMove(session.id, name),
      }));
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
        { label: 'Copy link', click: () => this.copyLink(session.id) },
        { label: 'Open in browser', click: () => void shell.openExternal(session.url || link) },
      );
      if (this.capabilities.folders === 'server') {
        items.push({ type: 'separator' }, { label: 'Move to folder', submenu });
      }
      if (this.capabilities.archive) {
        items.push(
          { type: 'separator' },
          {
            label: session.isArchived ? 'Unarchive' : 'Archive',
            click: () => void this.sessionArchive(session.id, !session.isArchived),
          },
        );
      }
    } else {
      return { action: null };
    }

    if (items.length === 0) return { action: null };
    if (testMode) {
      // e2e can't click a native popup — return a description instead; the
      // cloudMenuItems/cloudMenuClick hooks drive the same callbacks.
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
      return { action: null, items: this.lastMenuDesc };
    }
    const menu = Menu.buildFromTemplate(items);
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

  private async confirmDeleteFolder(name: string): Promise<void> {
    const win = state.windowRef;
    if (!win) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Delete folder "${name}"?`,
      detail: "Sessions stay — they're just unfoldered.",
    });
    if (response === 0) void this.folderDelete(name);
  }

  // --- cache --------------------------------------------------------------

  private loadCache(path: string): void {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return; // No cache file (or unreadable) — silent.
    }
    const cache = parseCloudCache(text, state.tenantUrl);
    if (!cache) {
      log('cloud', 'cloud-cache', { detail: { loaded: false } });
      return;
    }
    this.sessions = cache.sessions;
    this.folders = cache.folders;
    this.folderTotals = cache.folderTotals;
    this.lastSyncAt = cache.savedAt;
    this.cached = true;
    log('cloud', 'cloud-cache', {
      detail: {
        loaded: true,
        count: cache.sessions.length,
        folders: cache.folders.length,
        ageMs: Date.now() - Date.parse(cache.savedAt),
      },
    });
  }

  private writeCache(): void {
    const json = serializeCloudCache({
      tenantUrl: state.tenantUrl,
      savedAt: this.lastSyncAt ?? new Date().toISOString(),
      sessions: this.sessions,
      folders: this.folders,
      folderTotals: this.folderTotals,
    });
    if (json === this.lastCacheJson) return;
    this.lastCacheJson = json;
    writeFile(join(app.getPath('userData'), 'cloud-cache.json'), json).catch((error: unknown) => {
      log('cloud', 'cloud-cache-error', {
        detail: { message: String(error).slice(0, 200) },
      });
    });
  }

  // --- fixture mode -------------------------------------------------------

  private loadFixture(reason: string): Promise<void> {
    const run = this.fixtureChain.then(() => this.loadFixtureOnce(reason));
    this.fixtureChain = run;
    return run;
  }

  // Fixture mode runs the same complete() as a live list, with the fixture
  // file as page 1 and fixturePageFetch as the folder pages. Never rejects.
  private async loadFixtureOnce(reason: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const parsed = FixtureSchema.parse(JSON.parse(readFileSync(this.fixtureFile!, 'utf8')));
      const head: CloudListResult = {
        sessions: parsed.sessions,
        folders: parsed.folders,
        folderTotals: parsed.folderTotals,
        nextCursor: parsed.nextCursor,
      };
      let fetch: PageFetch = () => Promise.resolve(EMPTY_PAGE);
      if (parsed.paging) {
        const childCap = parsed.paging.childCap ?? CHILD_CAP;
        this.usePagingConfig({
          ...PAGING_CONFIG,
          rootsCap: parsed.paging.pageSize,
          pageSize: parsed.paging.pageSize,
          childCap,
        });
        fetch = fixturePageFetch(parsed.paging, childCap);
      } else {
        this.usePagingConfig(PAGING_CONFIG);
      }
      const ctx = this.listContext();
      const result = await this.paging.complete(head, ctx, fetch, () => this.listContext(), reason);
      if (result.kind === 'discard' || !sameListContext(ctx, this.listContext())) return;
      this.sessions = result.sessions;
      this.folders = head.folders;
      this.folderTotals = result.folderTotals;
      this.incompleteFolders = result.incompleteFolders;
      this.error = null;
      this.lastSyncAt = new Date().toISOString();
      this.setStatus('ready');
      log('cloud', 'cloud-list', {
        detail: {
          count: this.sessions.length,
          folders: this.folders.length,
          durationMs: Date.now() - startedAt,
          reason: `fixture-${reason}`,
        },
      });
    } catch (error) {
      this.setStatus('error', String(error));
      log('cloud', 'cloud-error', { detail: { kind: 'fixture', message: String(error).slice(0, 200) } });
    }
    this.emit();
    this.settleNewSession();
  }

  // --- folder paging ------------------------------------------------------

  private createPaging(config: PagingConfig): FolderPaging {
    return createFolderPaging({
      config,
      now: Date.now,
      log: (event, detail) => log('cloud', event, { detail }),
    });
  }

  // A fixture file may carry its own page size; a different config needs a
  // fresh instance (with every folder forced, so no memo is assumed).
  private usePagingConfig(config: PagingConfig): void {
    if (
      config.rootsCap === this.pagingConfig.rootsCap &&
      config.pageSize === this.pagingConfig.pageSize &&
      config.childCap === this.pagingConfig.childCap
    ) {
      return;
    }
    this.pagingConfig = config;
    this.paging = this.createPaging(config);
    this.paging.requestForce({ all: true });
  }

  private archivedStatus(): ArchivedStatus {
    return this.showArchived ? 'ALL' : 'ACTIVE';
  }

  private listContext(): ListContext {
    return { socketGen: this.socketGen, orgId: this.orgId ?? '', archivedStatus: this.archivedStatus() };
  }

  // --- token acquisition --------------------------------------------------

  private obtainToken(): Promise<void> {
    if (testMode) return Promise.resolve(); // no devinDebug on the fixture tenant
    if (this.tokenInFlight) return this.tokenInFlight;
    const work = this.obtainTokenInner().finally(() => {
      this.tokenInFlight = null;
    });
    this.tokenInFlight = work;
    return work;
  }

  private async obtainTokenInner(): Promise<void> {
    // A did-navigate-triggered call must not race a pending retry timer —
    // whoever runs first clears it so connect() can't fire twice.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // Already live or mid-handshake — don't churn a healthy socket.
    if (
      this.token &&
      (this.socket?.readyState === WebSocket.OPEN ||
        this.socket?.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.firstTokenAttemptAt ??= Date.now();
    let failReason: TokenFailReason | null = null;
    const identity = await this.readPageIdentity((reason) => {
      failReason = reason;
    });
    if (!identity) {
      this.onTokenFailure(failReason ?? 'error');
      return;
    }
    this.token = identity.token;
    this.lastToken = identity.token;
    this.orgId = identity.orgId;
    this.backoffMs = BACKOFF_MIN_MS;
    this.tokenBackoffMs = TOKEN_BACKOFF_MIN_MS;
    this.firstTokenAttemptAt = null;
    log('cloud', 'cloud-token', { detail: { ok: true } });
    this.emit();
    this.connect();
  }

  // Public identity read for sibling services (devinUsage) — no socket side
  // effects; the fixed failure reason travels back with a null identity.
  readIdentity(): Promise<{
    identity: { token: string; orgId: string } | null;
    reason: TokenFailReason | null;
  }> {
    let reason: TokenFailReason | null = null;
    return this.readPageIdentity((r) => {
      reason = r;
    }).then((identity) => ({ identity, reason }));
  }

  // Reads the page's CURRENT token + org — devinDebug.getOrgId() reports
  // whichever org the web app has selected, which can change after startup
  // for multi-org users. onFail carries the fixed failure reason.
  private async readPageIdentity(
    onFail?: (reason: TokenFailReason) => void,
  ): Promise<{ token: string; orgId: string } | null> {
    const contents = state.devinView?.webContents;
    const tenantOrigin = originOf(state.tenantUrl);
    if (
      !contents ||
      contents.isDestroyed() ||
      contents.isLoading() ||
      originOf(contents.getURL()) !== tenantOrigin
    ) {
      onFail?.('view-not-ready');
      return null;
    }
    try {
      const credentials = (await Promise.race([
        contents.executeJavaScript(
          'window.devinDebug?.getAccessToken ? window.devinDebug.getAccessToken().then(t => [t, window.devinDebug.getOrgId()]) : null',
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('token timeout')), TOKEN_TIMEOUT_MS),
        ),
      ])) as [string | null, string] | null;
      const token = credentials?.[0] ?? null;
      const orgId = credentials?.[1] ?? null;
      if (!token || !orgId) {
        onFail?.(credentials === null ? 'no-devindebug' : 'login-required');
        return null;
      }
      return { token, orgId };
    } catch (error) {
      const message = String(error);
      onFail?.(
        message === 'Error: token timeout'
          ? 'timeout'
          : /login required/i.test(message)
            ? 'login-required'
            : 'error',
      );
      return null;
    }
  }

  private syncOrg(reason: string): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    const work = this.syncOrgInner(reason).finally(() => {
      this.syncInFlight = null;
    });
    this.syncInFlight = work;
    return work;
  }

  private async syncOrgInner(reason: string): Promise<void> {
    if (!this.started || testMode || this.fixtureFile) return;
    const identity = await this.readPageIdentity();
    if (!identity) return;
    if (identity.orgId !== this.orgId && (this.socket !== null || this.token !== null)) {
      // The ws url carries org_id — a reconnect is required, and the new
      // handshake's list('connect') re-fills the sidebar.
      this.token = identity.token;
      this.lastToken = identity.token;
      this.orgId = identity.orgId;
      this.sessions = [];
      this.folders = [];
      this.folderTotals = {};
      this.incompleteFolders = [];
      this.paging.reset();
      this.emptyListSynced = false;
      this.cached = false;
      log('cloud', 'cloud-org-change', { detail: { reason } });
      this.connect();
      this.emit();
      return;
    }
    if (identity.token !== this.token) {
      // Rotated token on the same org — keep the socket, refresh the copy.
      this.token = identity.token;
      this.lastToken = identity.token;
    }
  }

  // Every obtainToken failure path funnels here. Never clobber a live or
  // handshaking connection's status; 'no-token' means signed out — a still-
  // bootstrapping tenant page is 'connecting', not 'no-token'.
  private onTokenFailure(reason: TokenFailReason): void {
    if (
      this.token &&
      (this.socket?.readyState === WebSocket.OPEN ||
        this.socket?.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const contents = state.devinView?.webContents;
    const viewOrigin =
      contents && !contents.isDestroyed() ? originOf(contents.getURL()) : null;
    const tenantOrigin = originOf(state.tenantUrl);
    // Sitting on an external login page (Okta/auth.devin.ai) is a real
    // signed-out signal; about:blank ('null' origin) and the tenant origin are
    // just "still bootstrapping".
    const externalLogin =
      viewOrigin !== null && viewOrigin !== 'null' && viewOrigin !== tenantOrigin;
    const graceExpired =
      this.firstTokenAttemptAt !== null &&
      Date.now() - this.firstTokenAttemptAt > TOKEN_GRACE_MS;
    this.setStatus(externalLogin || graceExpired ? 'no-token' : 'connecting');
    log('cloud', 'cloud-token', { detail: { ok: false, reason } });
    this.scheduleRetry(this.tokenBackoffMs);
    this.tokenBackoffMs = Math.min(this.tokenBackoffMs * 2, TOKEN_BACKOFF_MAX_MS);
    this.emit();
  }

  // --- websocket ----------------------------------------------------------

  private connect(): void {
    if (!this.token || !this.orgId) return;
    this.closeSocket();
    this.emptyListSynced = false;
    this.setStatus('connecting');
    this.emit();
    const socket = new WebSocket(acpWsUrl(state.tenantUrl, this.token, this.orgId));
    this.socket = socket;
    this.socketGen += 1;
    // A new socket's first list re-pages every folder.
    this.paging.requestForce({ all: true });
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) {
        log('cloud', 'cloud-connect', { detail: { ok: false, reason: 'timeout' } });
        this.closeSocket();
        this.scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener('message', (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const id = typeof message.id === 'number' ? message.id : null;
      if (id !== null && this.pending.has(id)) {
        const entry = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      this.socket = null;
      this.failPending('ws closed', socket);
      log('cloud', 'cloud-close', { detail: { code: event.code } });
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // 'close' follows — reconnect logic lives there.
    });
    socket.addEventListener('open', () => {
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      void this.handshake(socket);
    });
  }

  private async handshake(socket: WebSocket): Promise<void> {
    try {
      const init = await this.request('initialize', buildInitializeParams(app.getVersion()));
      if (init.error) {
        const rpcError = init.error as { code?: unknown; message?: unknown };
        this.onRpcError('initialize', rpcError);
        this.closeSocket();
        this.scheduleReconnect();
        return;
      }
      const initResult = init.result as Record<string, unknown> | undefined;
      const prefsUrl = (
        (initResult?.agentCapabilities as Record<string, unknown> | undefined)?._meta as
          | Record<string, unknown>
          | undefined
      )?.['cognition.ai/userPreferencesUrl'];
      this.userPreferencesUrl = typeof prefsUrl === 'string' ? prefsUrl : null;
      const protocolVersion =
        typeof initResult?.protocolVersion === 'number' ? initResult.protocolVersion : undefined;
      log('cloud', 'cloud-connect', { detail: { ok: true, protocolVersion } });
      this.backoffMs = BACKOFF_MIN_MS;
      await this.identify();
      await this.list('connect');
      if (this.socket !== socket) return;
      this.schedulePoll();
    } catch (error) {
      if (this.socket !== socket) return;
      this.onError('handshake', error);
      this.closeSocket();
      this.scheduleReconnect();
    }
  }

  private async identify(): Promise<void> {
    const urls = [usersInfoUrl(state.tenantUrl)];
    if (this.userPreferencesUrl && /^https:\/\//.test(this.userPreferencesUrl)) {
      urls.push(this.userPreferencesUrl);
    }
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const response = await net.fetch(url, {
          headers: {
            authorization: `Bearer ${this.token}`,
            'x-cog-org-id': this.orgId ?? '',
            accept: 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.status >= 200 && response.status < 300) {
          const info = parseUsersInfo(await response.json());
          this.userId = info.userId;
          log('cloud', 'cloud-identity', { detail: { ok: true, status: response.status } });
          return;
        }
        log('cloud', 'cloud-identity', { detail: { ok: false, status: response.status } });
      } catch (error) {
        log('cloud', 'cloud-identity', {
          detail: { ok: false, message: this.scrub(String(error)) },
        });
      }
    }
    // Proceed without the participant filter — the list still works.
    this.userId = null;
  }

  private async list(reason: string): Promise<boolean> {
    if (!this.orgId) return false;
    // Coalesce: a queued list just marks dirty and one follow-up runs after.
    if (this.listInFlight) {
      this.listDirty = reason;
      return false;
    }
    this.listInFlight = true;
    try {
      return await this.listOnce(reason);
    } finally {
      this.listInFlight = false;
      if (this.listDirty !== null) {
        const next = this.listDirty;
        this.listDirty = null;
        // The failed list closed the socket — the reconnect path re-lists
        // ('connect') anyway, so don't fire a doomed request.
        if (this.socket?.readyState === WebSocket.OPEN) void this.list(next);
      }
    }
  }

  private async listOnce(reason: string): Promise<boolean> {
    const orgId = this.orgId!;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = this.socket;
      const ctx = this.listContext();
      let head: CloudListResult;
      try {
        const message = await this.request(
          'session/list',
          // Caps default to PAGE_SIZE roots per folder / CHILD_CAP children per root.
          buildListParams({ orgId, userId: this.userId, archivedStatus: ctx.archivedStatus }),
          LIST_TIMEOUT_MS,
        );
        if (message.error) {
          const rpcError = message.error as { code?: unknown; message?: unknown };
          this.onRpcError('list', rpcError);
          return false;
        }
        head = parseListResult(message.result, orgId);
      } catch (error) {
        // A replacement socket's own handshake re-lists — don't tear it down.
        if (this.socket !== socket) return false;
        // One retry on a still-open socket before tearing it down.
        if (
          attempt === 0 &&
          String(error) === 'Error: request timeout' &&
          socket?.readyState === WebSocket.OPEN
        ) {
          log('cloud', 'cloud-list-retry', { detail: { reason } });
          continue;
        }
        this.onError('list', error);
        this.closeSocket();
        this.scheduleReconnect();
        return false;
      }
      // Pages 2+ only ever mark folders incomplete: complete() never rejects,
      // and nothing below tears down the socket or sets an error.
      const fetch = createPageFetch({
        request: (method, params, timeoutMs) => this.request(method, params, timeoutMs),
        orgId,
        userId: this.userId,
        archivedStatus: ctx.archivedStatus,
        config: this.pagingConfig,
      });
      const result = await this.paging.complete(head, ctx, fetch, () => this.listContext(), reason);
      // A discard — or a head-only fallback built for a context that has since
      // changed (socket / org / archived filter) — is never applied; the dirty
      // follow-up or the reconnect re-lists.
      if (
        result.kind === 'discard' ||
        !sameListContext(ctx, this.listContext()) ||
        this.socket !== socket
      ) {
        return false;
      }
      this.sessions = result.sessions;
      this.folders = head.folders;
      this.folderTotals = result.folderTotals;
      this.incompleteFolders = result.incompleteFolders;
      this.lastSyncAt = new Date().toISOString();
      this.error = null;
      this.lastError = null;
      this.cached = false;
      this.setStatus('ready');
      log('cloud', 'cloud-list', {
        detail: {
          count: this.sessions.length,
          folders: this.folders.length,
          durationMs: Date.now() - startedAt,
          reason,
        },
      });
      this.emit();
      this.settleNewSession();
      if (!testMode) this.writeCache();
      // A totally empty result usually means the page is on another org for
      // multi-org users — re-read devinDebug.getOrgId() once per connection.
      if (head.sessions.length === 0 && head.folders.length === 0 && !this.emptyListSynced) {
        this.emptyListSynced = true;
        void this.syncOrg('empty-list');
      }
      return true;
    }
    return false;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('ws not open'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('request timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // With a socket arg, only that socket's orphans fail — a replacement
  // socket's in-flight requests survive a stale closeSocket().
  private failPending(message: string, socket?: WebSocket): void {
    for (const [id, entry] of this.pending) {
      if (socket !== undefined && entry.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (socket) {
      this.failPending('ws closed', socket);
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  // --- scheduling ---------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.started || this.retryTimer) return;
    this.setStatus('connecting');
    // The token may have rotated — re-read it before reconnecting.
    this.token = null;
    this.emit();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.obtainToken();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private scheduleRetry(ms: number): void {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.obtainToken();
    }, ms);
  }

  private schedulePoll(): void {
    if (this.pollTimer || !this.started) return;
    // BaseWindow.isFocused() is false while a hosted WebContentsView holds
    // keyboard focus — count any focused webContents as 'focused'.
    const focused =
      state.windowRef?.isFocused() === true || webContents.getFocusedWebContents() !== null;
    this.pollTimer = setTimeout(
      () => {
        this.pollTimer = null;
        if (this.socket?.readyState === WebSocket.OPEN) void this.list('poll');
        this.schedulePoll();
      },
      focused ? POLL_FOCUSED_MS : POLL_IDLE_MS,
    );
  }

  private watchdog(): void {
    if (!this.started || testMode) return;
    const live =
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING;
    if (live || this.retryTimer || this.tokenInFlight) return;
    log('cloud', 'cloud-watchdog', {
      detail: {
        status: this.status,
        socket: this.socket?.readyState ?? null,
        hasToken: this.token !== null,
        syncInFlight: this.syncInFlight !== null,
        listInFlight: this.listInFlight,
      },
    });
    this.token = null;
    void this.obtainToken();
  }

  private clearTimers(): void {
    this.cancelNewSessionWatch();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.retryTimer = null;
    this.pollTimer = null;
    this.connectTimer = null;
    this.watchdogTimer = null;
  }

  // --- state / logging ----------------------------------------------------

  private setStatus(status: CloudState['status'], error?: string): void {
    this.status = status;
    this.error = error !== undefined ? this.scrub(error).slice(0, 200) : status === 'ready' ? null : this.error;
  }

  private onRpcError(kind: string, rpcError: { code?: unknown; message?: unknown }): void {
    const message = this.scrub(String(rpcError.message ?? 'rpc error')).slice(0, 200);
    this.setStatus('error', message);
    log('cloud', 'cloud-error', {
      detail: { kind, code: typeof rpcError.code === 'number' ? rpcError.code : null, message },
    });
    this.emit();
  }

  private onError(kind: string, error: unknown): void {
    const message = this.scrub(String(error)).slice(0, 200);
    log('cloud', 'cloud-error', { detail: { kind, message } });
    this.setStatus('error', message);
    this.emit();
  }

  private scrub(message: string): string {
    return sanitizeToken(sanitizeToken(message, this.token ?? ''), this.lastToken ?? '');
  }

  private emit(): void {
    const json = JSON.stringify(this.snapshot());
    if (json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    notifyShell();
  }
}

let instance: CloudSessions | null = null;

export function cloudSessions(): CloudSessions {
  instance ??= new CloudSessions();
  return instance;
}
