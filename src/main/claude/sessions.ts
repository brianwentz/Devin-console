// Claude session sidebar controller — the cloudSessions.ts analogue without
// sockets/tokens: a local registry (userData/claude-sessions.json) reconciled
// against the SDK store list, change-driven via fs.watch. Logs carry op
// names, ids, counts and durations only — never titles or transcript text.

import { app, clipboard, dialog, Menu, shell } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import type { ClaudeState, Settings } from '../../shared/ipc';
import { log } from '../log';
import { state, testMode } from '../state';
import { applyLayout, notifyShell } from '../window';
import { resolveClaudePath, INSTALL_GUIDANCE } from './claudePath';
import { ClaudeRegistryStore } from './registry';
import { ClaudeStore } from './store';

type MenuAction = 'rename' | 'rename-session' | 'new-folder' | null;

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
  private refreshInFlight = false;
  private refreshDirty: string | null = null;
  private started = false;
  private lastSnapshotJson = '';
  private mutations: { op: string; payload: Record<string, unknown> }[] = [];

  constructor(opts: { configDir: string; registryStore: ClaudeRegistryStore }) {
    this.configDir = opts.configDir;
    this.registryStore = opts.registryStore;
    this.store = new ClaudeStore({
      configDir: this.configDir,
      onChange: () => void this.refresh('watch'),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.registry = this.registryStore.load();
    this.showArchived = state.settings?.current.claude.showArchived ?? false;
    this.cliPath = resolveClaudePath(state.settings?.current.claude.path ?? null);
    this.store.start();
    void this.refresh('start');
  }

  snapshot(): ClaudeState {
    return {
      status: this.status,
      configDir: this.configDir,
      cliPath: this.cliPath,
      installGuidance: INSTALL_GUIDANCE,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      folders: this.registry.folders,
      sessions: this.showArchived ? this.sessions : this.sessions.filter((s) => !s.isArchived),
      showArchived: this.showArchived,
      lastError: this.lastError,
    };
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
    this.registry = touchOpened(this.registry, sessionId, Date.now());
    this.registryStore.save(this.registry);
    log('claude', 'claude-select', { detail: { sessionId } });
    applyLayout();
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
    applyLayout();
  }

  // Settings changes routed through applySettingsPatch.
  onSettingsChanged(previous: Settings, next: Settings): void {
    if (previous.claude.autoArchiveDays !== next.claude.autoArchiveDays) {
      void this.refresh('settings');
    }
    if (previous.claude.path !== next.claude.path) {
      this.cliPath = resolveClaudePath(next.claude.path);
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
    kind: 'session' | 'folder' | 'header';
    sessionId?: string | undefined;
    name?: string | undefined;
    x: number;
    y: number;
  }): Promise<{ action: MenuAction; items?: Record<string, unknown>[] }> {
    this.pendingAction = null;
    const items: Electron.MenuItemConstructorOptions[] = [];

    if (arg.kind === 'header') {
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
  });
}
