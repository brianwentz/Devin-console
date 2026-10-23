// Generic sidebar controller for REST-poll cloud session sources
// (./source.ts). Electron-free so it is unit-tested with a fake source:
// cache I/O, logging and message sanitising are injected.
//
// - Lists are coalesced: one in flight + at most one dirty follow-up; every
//   caller that asked while a list ran resolves after the follow-up.
// - The last successful list is cached per tenant (src/core/cloudCache.ts
//   shape); `start()` reads it alongside the first list so the sidebar renders
//   at once, and `cached` stays true until a live list lands. A cache read
//   that finishes after a live list is dropped. Writes are serialised.
// - A failed mutation sets `lastError {op,message}`; the next successful list
//   clears it (and replaces any optimistic shell-side edits). A failed list
//   keeps the last good rows and reports `status:'error'`.
//
// Devin Cloud's socket-driven controller (src/main/cloudSessions.ts) is not
// built on this.

import { buildCloudCache, parseCloudCacheValue, type CloudCache } from '../../core/cloudCache';
import type { CloudState } from '../../shared/ipc';
import type { CloudMutation, CloudSessionSource, CloudSessionsLog } from './source';

export interface CloudSessionsControllerOptions {
  /** The cache's tenant key (e.g. the provider's base URL) — a cache written
   * for another key is ignored. */
  tenantKey(): string;
  /** Parsed JSON of the cache file, or null when there is none. */
  readCache(): Promise<unknown>;
  writeCache(data: CloudCache): Promise<void>;
  log: CloudSessionsLog;
  /** Scrubs secrets from error text before it reaches state. */
  sanitize?: (message: string) => string;
  /** State changed — push a new snapshot to the shell. */
  onChange?: () => void;
  /** Controller-owned poll interval; omit when the source polls itself. */
  pollMs?: number;
}

const MESSAGE_MAX = 200;

export class CloudSessionsController {
  private status: CloudState['status'] = 'connecting';
  private error: string | null = null;
  private sessions: CloudState['sessions'] = [];
  private folders: string[] = [];
  private folderTotals: Record<string, number> = {};
  private lastSyncAt: string | null = null;
  private lastError: CloudState['lastError'] = null;
  private cached = false;
  private liveLanded = false;
  private lastCacheKey = '';
  private pendingCacheKey = '';
  private started = false;
  private stopped = false;
  private running: Promise<void> | null = null;
  private dirty = false;
  private dirtyReason = 'manual';
  private writeChain: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: CloudSessionSource,
    private readonly opts: CloudSessionsControllerOptions,
  ) {}

  get providerId(): string {
    return this.source.providerId;
  }

  snapshot(): CloudState {
    return {
      status: this.status,
      lastSyncAt: this.lastSyncAt,
      error: this.error,
      folders: this.folders,
      folderTotals: this.folderTotals,
      sessions: this.sessions,
      liveSessionIds: [],
      showArchived: false,
      lastError: this.lastError,
      cached: this.cached,
      capabilities: this.source.capabilities,
    };
  }

  // The cache read starts first; the source and the first list do not wait
  // for it (a hung read must not block the sidebar) — a cache that lands
  // after a live list is dropped.
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    const cache = this.loadCache();
    try {
      this.source.start(() => void this.refresh('source'));
    } catch (error) {
      this.opts.log('cloud-sessions-source-error', { provider: this.providerId, code: errorCode(error) });
    }
    if (this.opts.pollMs && this.opts.pollMs > 0) {
      this.pollTimer = setInterval(() => void this.refresh('poll'), this.opts.pollMs);
      this.pollTimer.unref?.();
    }
    await Promise.all([cache, this.refresh('start')]);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.source.stop();
  }

  // Never rejects; a failure is reflected in the snapshot.
  refresh(reason = 'manual'): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.dirty = true;
      this.dirtyReason = reason;
      return this.running;
    }
    const run = async () => {
      let next = reason;
      try {
        do {
          this.dirty = false;
          await this.listOnce(next);
          next = this.dirtyReason;
        } while (this.dirty && !this.stopped);
      } finally {
        this.running = null;
      }
    };
    this.running = run();
    return this.running;
  }

  // Never rejects; a failure lands in `lastError`.
  async mutate(op: CloudMutation): Promise<void> {
    if (this.stopped) return;
    const caps = this.source.capabilities;
    const allowed = op.op === 'rename' ? caps.rename : caps.delete;
    if (!allowed || !this.source.mutate) {
      this.opts.log('cloud-sessions-mutate', {
        provider: this.providerId,
        op: op.op,
        ok: false,
        status: 0,
        reason: 'unsupported',
      });
      this.lastError = { op: op.op, message: 'unsupported' };
      this.emit();
      return;
    }
    let result: { ok: boolean; status: number };
    try {
      result = await this.source.mutate(op);
    } catch (error) {
      if (this.stopped) return;
      this.opts.log('cloud-sessions-mutate', { provider: this.providerId, op: op.op, ok: false, status: 0 });
      this.lastError = { op: op.op, message: this.clean(error) };
      this.emit();
      return;
    }
    if (this.stopped) return;
    this.opts.log('cloud-sessions-mutate', {
      provider: this.providerId,
      op: op.op,
      ok: result.ok,
      status: result.status,
    });
    if (!result.ok) {
      this.lastError = { op: op.op, message: `HTTP ${result.status}` };
      this.emit();
      return;
    }
    await this.refresh('mutate');
  }

  // --- internals ----------------------------------------------------------

  private async listOnce(reason: string): Promise<void> {
    const t0 = Date.now();
    let data: Awaited<ReturnType<CloudSessionSource['list']>>;
    try {
      data = await this.source.list();
    } catch (error) {
      if (this.stopped) return;
      this.status = 'error';
      this.error = this.clean(error);
      this.opts.log('cloud-sessions-list', {
        provider: this.providerId,
        ok: false,
        ms: Date.now() - t0,
        reason,
      });
      this.emit();
      return;
    }
    if (this.stopped) return;
    this.sessions = data.sessions;
    this.folders = data.folders;
    this.folderTotals = data.folderTotals;
    this.status = 'ready';
    this.error = null;
    this.lastError = null;
    this.cached = false;
    this.liveLanded = true;
    this.lastSyncAt = new Date().toISOString();
    this.opts.log('cloud-sessions-list', {
      provider: this.providerId,
      ok: true,
      count: data.sessions.length,
      ms: Date.now() - t0,
      reason,
    });
    this.persist();
    this.emit();
  }

  private async loadCache(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.opts.readCache();
    } catch (error) {
      this.opts.log('cloud-sessions-cache-error', { provider: this.providerId, op: 'read', code: errorCode(error) });
      return;
    }
    if (raw === null || raw === undefined) return; // no cache yet — silent
    // A live list may have landed while the read was pending — it wins.
    if (this.stopped || this.liveLanded) return;
    const cache = parseCloudCacheValue(raw, this.opts.tenantKey());
    if (!cache) {
      this.opts.log('cloud-sessions-cache', { provider: this.providerId, loaded: false });
      return;
    }
    this.sessions = cache.sessions;
    this.folders = cache.folders;
    this.folderTotals = cache.folderTotals;
    this.lastSyncAt = cache.savedAt;
    this.cached = true;
    this.lastCacheKey = cacheKey(cache);
    this.opts.log('cloud-sessions-cache', { provider: this.providerId, loaded: true, count: cache.sessions.length });
    this.emit();
  }

  private persist(): void {
    const cache = buildCloudCache({
      tenantUrl: this.opts.tenantKey(),
      savedAt: this.lastSyncAt ?? new Date().toISOString(),
      sessions: this.sessions,
      folders: this.folders,
      folderTotals: this.folderTotals,
    });
    const key = cacheKey(cache);
    if (key === this.lastCacheKey || key === this.pendingCacheKey) return;
    this.pendingCacheKey = key;
    // Serialised so writes land in list order; the key only advances on
    // success, so a failed write is retried by the next list.
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.opts.writeCache(cache);
        this.lastCacheKey = key;
      } catch (error) {
        this.opts.log('cloud-sessions-cache-error', { provider: this.providerId, op: 'write', code: errorCode(error) });
      } finally {
        if (this.pendingCacheKey === key) this.pendingCacheKey = '';
      }
    });
  }

  private clean(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const scrubbed = this.opts.sanitize ? this.opts.sanitize(message) : message;
    return scrubbed.slice(0, MESSAGE_MAX);
  }

  // A throwing listener must not turn a good list into an error.
  private emit(): void {
    try {
      this.opts.onChange?.();
    } catch (error) {
      this.opts.log('cloud-sessions-emit-error', { provider: this.providerId, code: errorCode(error) });
    }
  }
}

// Content identity of a cache (savedAt excluded) — an unchanged list is not
// rewritten on every poll.
const cacheKey = (cache: CloudCache): string =>
  JSON.stringify([cache.tenantUrl, cache.sessions, cache.folders, cache.folderTotals]);

// Error class/code only — fs messages carry paths.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown';
}
