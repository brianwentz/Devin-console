// Claude Code session store per host behind one StoreBackend interface:
//   LocalBackend   — the Agent SDK in this process + fs.watch over the local
//                    <configDir>/projects (a change → the controller re-lists).
//   ChannelBackend — a WSL or SSH host: every call is an RPC to the remote helper
//                    (hosts().channel(host)); its `store.changed` notification
//                    carries the changed sessions' SDK info, so the controller
//                    patches rows instead of re-listing. The app never touches
//                    a WSL config dir over \\wsl.localhost.
// The SDK is loaded lazily on first use via loadSdk() — a load failure
// surfaces as an error status on the controller, never as a thrown require.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { ClaudeStoreSession } from '../../core/claudeRegistry';
import { STORE_MAX_PAGES, STORE_MESSAGES_PAGE, pageAll } from '../../core/hostRpc';
import { isRemoteHost, isWslHost, type ExecHost, type HostId } from '../../core/execHost';
import { log } from '../log';
import { hosts } from '../hosts';
import { HostRpcError, type HostChannel } from '../hostChannel';
import { loadSdk } from './sdk';

const WATCH_DEBOUNCE_MS = 250;
const POLL_MS = 30_000;

/** One watch report. `sessions` are fresh rows for changed transcripts (empty
 * from the local watcher — a local change triggers a full re-list); `resync`
 * = events may have been missed (the channel came back): list in full. */
export type StoreChange = {
  files: string[];
  sessions: ClaudeStoreSession[];
  removed: string[];
  resync?: boolean;
};

export interface StoreBackend {
  list(): Promise<ClaudeStoreSession[]>;
  rename(id: string, title: string): Promise<void>;
  fork(id: string): Promise<string>;
  delete(id: string): Promise<void>;
  listSubagents(id: string): Promise<string[]>;
  messages(id: string): Promise<unknown[]>;
  subagentMessages(id: string, agentId: string): Promise<unknown[]>;
  /** Windows-openable transcript path (\\wsl.localhost\… for a WSL host), null when absent. */
  transcriptPath(id: string): Promise<string | null>;
  /** Starts change reporting; returns the stop function. */
  watch(onChange: (ev: StoreChange) => void): () => void;
}

type SessionInfoLike = {
  sessionId?: unknown;
  summary?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  tag?: unknown;
  createdAt?: unknown;
  lastModified?: unknown;
  fileSize?: unknown;
};

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** SDK session info → a store row (the SDK already resolves title precedence:
 * custom title → auto-generated summary → first prompt). Rows without an id
 * (a malformed RPC answer) are dropped. */
export function storeRows(infos: unknown, host: HostId): ClaudeStoreSession[] {
  if (!Array.isArray(infos)) return [];
  const rows: ClaudeStoreSession[] = [];
  for (const raw of infos as SessionInfoLike[]) {
    if (!raw || typeof raw.sessionId !== 'string' || raw.sessionId === '') continue;
    rows.push({
      id: raw.sessionId,
      host,
      title: typeof raw.summary === 'string' ? raw.summary : '',
      cwd: strOrNull(raw.cwd),
      gitBranch: strOrNull(raw.gitBranch),
      tag: strOrNull(raw.tag),
      createdAt: numOrNull(raw.createdAt),
      lastModified: numOrNull(raw.lastModified) ?? 0,
      fileSize: numOrNull(raw.fileSize),
    });
  }
  return rows;
}

// --- local ----------------------------------------------------------------------

export class LocalBackend implements StoreBackend {
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private watchRestarts = 0;
  private watchFailed = false;
  private onChange: ((ev: StoreChange) => void) | null = null;

  constructor(private readonly configDir: string) {}

  private get projectsDir(): string {
    return join(this.configDir, 'projects');
  }

  // SDK calls read the local Claude home from the process env, which the app
  // never rewrites — remote stores are reached only over the helper channel.
  async list(): Promise<ClaudeStoreSession[]> {
    const sdk = await loadSdk();
    return storeRows(await sdk.listSessions({ includeProgrammatic: true }), 'local');
  }

  async rename(id: string, title: string): Promise<void> {
    const sdk = await loadSdk();
    await sdk.renameSession(id, title);
  }

  async fork(id: string): Promise<string> {
    const sdk = await loadSdk();
    return (await sdk.forkSession(id)).sessionId;
  }

  async delete(id: string): Promise<void> {
    const sdk = await loadSdk();
    await sdk.deleteSession(id);
  }

  async listSubagents(id: string): Promise<string[]> {
    const sdk = await loadSdk();
    return sdk.listSubagents(id);
  }

  async messages(id: string): Promise<unknown[]> {
    const sdk = await loadSdk();
    return (await sdk.getSessionMessages(id)) as unknown[];
  }

  async subagentMessages(id: string, agentId: string): Promise<unknown[]> {
    const sdk = await loadSdk();
    return (await sdk.getSubagentMessages(id, agentId)) as unknown[];
  }

  // The SDK exposes no transcript-path API: <configDir>/projects/<encoded cwd>/
  // <id>.jsonl — find it by scanning project dirs for the id-named file.
  async transcriptPath(id: string): Promise<string | null> {
    try {
      for (const project of await readdir(this.projectsDir)) {
        const candidate = join(this.projectsDir, project, `${id}.jsonl`);
        try {
          await access(candidate);
          return candidate;
        } catch {
          /* not in this project dir */
        }
      }
    } catch {
      // No projects dir.
    }
    return null;
  }

  watch(onChange: (ev: StoreChange) => void): () => void {
    this.onChange = onChange;
    this.startWatch();
    return () => this.stopAll();
  }

  private emit(files: string[]): void {
    this.onChange?.({ files, sessions: [], removed: [] });
  }

  private startWatch(): void {
    if (!this.onChange) return;
    if (!existsSync(this.projectsDir)) {
      // Fresh machines have no projects dir yet; poll until it appears.
      log('claude', 'claude-watch', { detail: { mode: 'waiting', events: 0 } });
      this.startPoll();
      return;
    }
    this.stopPoll();
    try {
      const changed = new Set<string>();
      this.watcher = watch(this.projectsDir, { recursive: true }, (_event, filename) => {
        if (filename) changed.add(filename);
        if (this.watchTimer) return;
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          const files = [...changed];
          changed.clear();
          this.emit(files);
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => {
        // One restart, then fall back to polling.
        this.watcher?.close();
        this.watcher = null;
        this.watchRestarts += 1;
        if (this.watchRestarts <= 1) {
          setTimeout(() => this.startWatch(), 5_000).unref?.();
        } else {
          this.watchFailed = true;
          this.startPoll();
        }
      });
      log('claude', 'claude-watch', { detail: { mode: 'watch', events: 0 } });
    } catch {
      this.watchFailed = true;
      log('claude', 'claude-watch', { detail: { mode: 'poll', events: 0 } });
      this.startPoll();
    }
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void (async () => {
        const dirExists = await access(this.projectsDir).then(
          () => true,
          () => false,
        );
        if (!this.watcher && !this.watchFailed && dirExists) {
          // The dir appeared after the waiting phase — try watching again.
          this.stopPoll();
          this.startWatch();
          return;
        }
        if (dirExists) this.emit([]);
      })();
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private stopAll(): void {
    this.onChange = null;
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.stopPoll();
  }
}

// --- WSL: the helper channel ------------------------------------------------------

type StoreChangedParams = { files?: unknown; sessions?: unknown; removed?: unknown };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export class ChannelBackend implements StoreBackend {
  constructor(private readonly host: ExecHost) {}

  private channel(): HostChannel {
    const channel = hosts().channel(this.host);
    if (!channel) throw new HostRpcError('not-ready', 'helper channel is not ready');
    return channel;
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    try {
      return this.channel().request<T>(method, params);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async list(): Promise<ClaudeStoreSession[]> {
    const t0 = Date.now();
    const rows = storeRows(await this.request<unknown>('store.list'), this.host.id);
    log('claude', 'claude-store-list', { detail: { host: this.host.id, count: rows.length, ms: Date.now() - t0 } });
    return rows;
  }

  async rename(id: string, title: string): Promise<void> {
    await this.request('store.rename', { sessionId: id, title });
  }

  async fork(id: string): Promise<string> {
    const result = await this.request<{ sessionId?: unknown } | null>('store.fork', { sessionId: id });
    if (typeof result?.sessionId !== 'string') throw new HostRpcError('internal', 'store.fork returned no session id');
    return result.sessionId;
  }

  async delete(id: string): Promise<void> {
    await this.request('store.delete', { sessionId: id });
  }

  async listSubagents(id: string): Promise<string[]> {
    return strings(await this.request<unknown>('store.listSubagents', { sessionId: id }));
  }

  messages(id: string): Promise<unknown[]> {
    return this.pages('store.messages', { sessionId: id });
  }

  subagentMessages(id: string, agentId: string): Promise<unknown[]> {
    return this.pages('store.subagentMessages', { sessionId: id, agentId });
  }

  // A history can outgrow one 32 MB frame: page until a short page
  // (core/hostRpc pageAll — a helper that ignores `offset` or never sends a
  // short page rejects with a PagingError, never loops).
  private pages(method: string, params: Record<string, unknown>): Promise<unknown[]> {
    return pageAll(
      (offset, limit) => this.request<unknown[]>(method, { ...params, offset, limit }),
      STORE_MESSAGES_PAGE,
      STORE_MAX_PAGES,
    );
  }

  async transcriptPath(id: string): Promise<string | null> {
    const result = await this.request<{ path?: unknown; rel?: unknown } | null>('store.transcriptPath', {
      sessionId: id,
    });
    const path = typeof result?.path === 'string' ? result.path : null;
    // An ssh host has no Windows-openable path: Reveal is unavailable there.
    if (path === null || !isWslHost(this.host)) return null;
    if (path.startsWith('/')) return hosts().windowsPath(this.host, path);
    // A helper on a non-POSIX node (the e2e fake runs it on Windows) reports a
    // native path; rebuild the distro path from `rel` under the probed home.
    // The result is only handed to Explorer (reveal), never read by the app.
    const rel = typeof result?.rel === 'string' ? result.rel : null;
    const host = hosts().hostById(this.host.id) ?? this.host;
    const home = isWslHost(host) ? host.home : null;
    return rel && home ? hosts().windowsPath(host, posix.join(home, '.claude', 'projects', rel)) : null;
  }

  watch(onChange: (ev: StoreChange) => void): () => void {
    const channel = hosts().channel(this.host);
    if (!channel) return () => undefined;
    const host = this.host.id;
    const subscribe = (): void => {
      // The helper forgets its subscription when it respawns: re-send on every ready.
      channel
        .request('watch.subscribe')
        .then(() => log('claude', 'claude-watch', { detail: { mode: 'channel', host, events: 0 } }))
        .catch(() => undefined);
    };
    const offNotify = channel.onNotification('store.changed', (params) => {
      const p = (params ?? {}) as StoreChangedParams;
      const ev: StoreChange = {
        files: strings(p.files),
        sessions: storeRows(p.sessions, host),
        removed: strings(p.removed),
      };
      log('claude', 'claude-watch', { detail: { mode: 'channel', host, events: ev.files.length } });
      onChange(ev);
    });
    let wasReady = channel.state === 'ready';
    if (wasReady) subscribe();
    const offState = channel.onState((status) => {
      const ready = status.state === 'ready';
      if (ready && !wasReady) {
        subscribe();
        onChange({ files: [], sessions: [], removed: [], resync: true });
      }
      wasReady = ready;
    });
    return () => {
      offNotify();
      offState();
    };
  }
}

/** The backend for a host: the local SDK, or the helper channel for WSL / SSH. */
export function createStoreBackend(host: ExecHost, localConfigDir: string): StoreBackend {
  return isRemoteHost(host) ? new ChannelBackend(host) : new LocalBackend(localConfigDir);
}

/** Per-host store handle owned by the controller: the backend plus its watch. */
export class ClaudeStore {
  readonly backend: StoreBackend;
  private unwatch: (() => void) | null = null;

  constructor(
    readonly host: ExecHost,
    localConfigDir: string,
    private readonly onChange: (ev: StoreChange) => void,
  ) {
    this.backend = createStoreBackend(host, localConfigDir);
  }

  get started(): boolean {
    return this.unwatch !== null;
  }

  start(): void {
    if (this.unwatch) return;
    // A WSL store is only created/started while its channel is ready.
    if (isRemoteHost(this.host) && !hosts().fsReady(this.host)) return;
    this.unwatch = this.backend.watch(this.onChange);
  }

  dispose(): void {
    this.unwatch?.();
    this.unwatch = null;
  }
}
