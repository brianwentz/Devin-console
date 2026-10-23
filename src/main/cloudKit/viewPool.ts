// Cloud session view pool. Instead of one hosted view doing an in-page SPA
// reload per session switch, views are pooled by the session they display;
// switching to a cached session just swaps which view is attached.
//
// Provider-agnostic: everything provider-specific (partition, home URL,
// URL → key mapping, limits, routing view name, session side effects) comes
// from the ViewPoolConfig. Devin Cloud's config lives in src/main/cloudViews.ts.
//
// Token/user-content rules are unchanged: nothing here logs titles or tokens.

import { app, WebContentsView } from 'electron';
import { resolve } from 'node:path';
import {
  HOME_KEY,
  pickEvictions,
  pickIdle,
  type PoolEntryInfo,
} from '../../core/viewPool';
import type { ViewName } from '../state';
import { log } from '../log';
import { applyLayout, detachView, notifyShell } from '../window';

export const DEFAULT_MAX_LIVE_VIEWS = 6;
const DEFAULT_KEEPALIVE_MS = 24 * 60 * 60 * 1000;

// Effective keep-alive for pooled cloud views: settings hours, overridable in
// test mode via AGENT_WORKSPACE_TEST_CLOUD_KEEPALIVE_MS (mirrors the tabs one).
export function cloudKeepAliveMs(settingHours: number): number {
  const override =
    process.env.AGENT_WORKSPACE_TEST === '1'
      ? process.env.AGENT_WORKSPACE_TEST_CLOUD_KEEPALIVE_MS
      : undefined;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return Math.max(0, Math.floor(settingHours)) * 3_600_000;
}

// Provider-specific side effects the pool runs at fixed points.
export interface ViewPoolHooks {
  // Once per created view (routing, session tracking, ...).
  attach?(contents: Electron.WebContents): void;
  // The active view changed, or the active view's key changed.
  onActiveSession?(sessionId: string | null, url: string): void;
  // The active view went from the home key to a session key.
  onHomeToSession?(sessionId: string): void;
}

export interface ViewPoolConfig {
  providerId: string;
  partition: string;
  homeUrl(): string;
  // Pool key for a URL: a session id, HOME_KEY for other provider pages, null
  // for a URL the provider does not own (the pool treats null as HOME_KEY).
  keyForUrl(url: string): string | null;
  ownsUrl(url: string): boolean;
  limits(): { maxLiveViews: number; keepAliveHours: number };
  // Routing source + load-error log channel for the pooled views.
  viewName: ViewName;
  hooks?: ViewPoolHooks;
}

interface PoolEntry {
  key: string;
  view: WebContentsView;
  lastActiveAt: number;
  protected: boolean;
  loading: boolean;
  discarding: boolean;
  closeCancelled: boolean;
  loads: number;
}

const kindOf = (key: string) => (key === HOME_KEY ? 'home' : 'session');
const sid = (key: string) => (key === HOME_KEY ? null : key);

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export class ViewPool {
  private entries = new Map<string, PoolEntry>();
  private active: PoolEntry | null = null;
  private maxLive = DEFAULT_MAX_LIVE_VIEWS;
  private keepAliveMs = DEFAULT_KEEPALIVE_MS;
  private sweepTimer: NodeJS.Timeout | null = null;
  private activeNavigateCbs = new Set<() => void>();

  constructor(readonly config: ViewPoolConfig) {}

  get providerId(): string {
    return this.config.providerId;
  }

  ownsUrl(url: string): boolean {
    return this.config.ownsUrl(url);
  }

  keyForUrl(url: string): string {
    return this.config.keyForUrl(url) ?? HOME_KEY;
  }

  // Session id shown at `url` (null for home / foreign pages).
  private sessionIdFor(url: string): string | null {
    const key = this.config.keyForUrl(url);
    return key === null || key === HOME_KEY ? null : key;
  }

  private log(event: string, detail: Record<string, unknown>): void {
    log('cloud', event, { detail: { provider: this.config.providerId, ...detail } });
  }

  // --- lifecycle ------------------------------------------------------------

  private createView(key: string): PoolEntry {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.config.partition,
        preload: resolve(app.getAppPath(), 'out', 'autofill-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#111827');
    const entry: PoolEntry = {
      key,
      view,
      lastActiveAt: Date.now(),
      protected: false,
      loading: true,
      discarding: false,
      closeCancelled: false,
      loads: 1,
    };
    this.entries.set(key, entry);
    const contents = view.webContents;
    this.config.hooks?.attach?.(contents);
    contents.on('did-start-loading', () => {
      entry.loading = true;
      entry.loads++;
    });
    contents.on('did-stop-loading', () => {
      entry.loading = false;
      if (entry === this.active) this.fireActiveNavigate();
    });
    const onNavigate = (_event: unknown, url: string) => {
      this.rekey(entry, url);
      if (entry === this.active) this.fireActiveNavigate();
    };
    contents.on('did-navigate', onNavigate);
    contents.on('did-navigate-in-page', onNavigate);
    contents.on('did-finish-load', () => {
      if (entry === this.active) this.fireActiveNavigate();
    });
    contents.on('will-prevent-unload', () => {
      // Only act on our own discards (the same silent-cancel protocol as
      // TabManager); otherwise leave beforeunload alone.
      if (entry.discarding) entry.closeCancelled = true;
    });
    contents.on('render-process-gone', (_event, details) => {
      this.log('cloud-view-crashed', {
        kind: kindOf(entry.key),
        sessionId: sid(entry.key),
        reason: details.reason,
      });
    });
    contents.on('destroyed', () => {
      // Delete by identity, not by key — after a rekey another entry may hold
      // this key, and removing it would orphan a live view.
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      if (this.active === entry) this.active = null;
    });
    return entry;
  }

  private loadUrl(entry: PoolEntry, url: string): void {
    entry.view.webContents.loadURL(url).catch((error: unknown) => {
      log(this.config.viewName, 'load-error', { url, detail: { message: String(error) } });
    });
  }

  init(homeUrl: string = this.config.homeUrl()): void {
    const home = this.createView(HOME_KEY);
    this.loadUrl(home, homeUrl);
    this.makeActive(home, false);
  }

  reset(homeUrl: string = this.config.homeUrl()): void {
    this.dispose();
    this.entries.clear();
    this.active = null;
    this.init(homeUrl);
    applyLayout();
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const entry of [...this.entries.values()]) {
      detachView(entry.view);
      entry.view.webContents.close();
    }
    this.entries.clear();
    this.active = null;
  }

  // --- activation -----------------------------------------------------------

  private makeActive(entry: PoolEntry, runSweep = true): void {
    this.active = entry;
    entry.lastActiveAt = Date.now();
    const url = entry.view.webContents.getURL();
    const sessionId = entry.key === HOME_KEY ? this.sessionIdFor(url) : entry.key;
    this.config.hooks?.onActiveSession?.(sessionId, url);
    applyLayout();
    this.fireActiveNavigate();
    if (runSweep) this.runIdleSweep('switch');
  }

  show(key: string, url: string, opts: { reload?: boolean } = {}): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (opts.reload || stripHash(existing.view.webContents.getURL()) !== stripHash(url)) {
        this.loadUrl(existing, url);
      }
      const hit = true;
      this.makeActive(existing);
      this.log('cloud-view-show', {
        kind: kindOf(key),
        sessionId: sid(key),
        hit,
        liveCount: this.entries.size,
      });
      return;
    }
    // Evict before creating so the pool never exceeds the cap.
    const prospective: PoolEntryInfo = {
      key,
      lastActiveAt: Date.now(),
      active: false,
      protected: false,
      loading: true,
    };
    for (const evictKey of pickEvictions([...this.info(), prospective], this.maxLive)) {
      if (evictKey === key) continue;
      const entry = this.entries.get(evictKey);
      if (entry) void this.discard(entry, 'cap');
    }
    const entry = this.createView(key);
    this.loadUrl(entry, url);
    this.makeActive(entry);
    this.log('cloud-view-show', {
      kind: kindOf(key),
      sessionId: sid(key),
      hit: false,
      liveCount: this.entries.size,
    });
  }

  prefetch(key: string, url: string): void {
    if (key === HOME_KEY || this.entries.has(key)) return;
    if (this.entries.size >= this.maxLive) return; // prefetch never evicts
    const entry = this.createView(key);
    this.loadUrl(entry, url);
    this.log('cloud-view-create', { kind: kindOf(key), sessionId: sid(key), prefetch: true });
    notifyShell();
  }

  // When a pooled view navigates to another session the key must follow — this
  // is what keeps in-app sidebar clicks inside the web app working.
  private rekey(entry: PoolEntry, url: string): void {
    const next = this.keyForUrl(url);
    if (next === entry.key) return;
    const other = this.entries.get(next);
    if (other && other !== entry) {
      if (other !== this.active) {
        this.log('cloud-view-duplicate', { sessionId: sid(next) });
        this.entries.delete(next);
        detachView(other.view);
        other.view.webContents.close();
      } else {
        // A background view navigated to the session the active view holds —
        // drop the navigated view instead.
        this.entries.delete(entry.key);
        detachView(entry.view);
        entry.view.webContents.close();
        return;
      }
    }
    const fromKey = entry.key;
    entry.key = next;
    this.entries.delete(fromKey);
    this.entries.set(next, entry);
    this.log('cloud-view-rekey', {
      from: { kind: kindOf(fromKey), sessionId: sid(fromKey) },
      to: { kind: kindOf(next), sessionId: sid(next) },
    });
    // A home→session rekey on the active view may be the composer finishing
    // a 'New session' — the provider files it (Devin: the pending folder).
    if (fromKey === HOME_KEY && next !== HOME_KEY && entry === this.active) {
      this.config.hooks?.onHomeToSession?.(next);
    }
    if (entry === this.active) {
      this.config.hooks?.onActiveSession?.(
        next === HOME_KEY ? this.sessionIdFor(url) : next,
        url,
      );
    }
    notifyShell();
  }

  async discard(entry: PoolEntry, reason: 'idle' | 'cap' | 'switch'): Promise<boolean> {
    if (entry === this.active || entry.discarding) return false;
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return false;
    entry.discarding = true;
    entry.closeCancelled = false;
    const closed = await new Promise<boolean>((resolveClose) => {
      let settled = false;
      const finish = (didClose: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveClose(didClose);
      };
      const timer = setTimeout(() => finish(contents.isDestroyed()), 3000);
      contents.once('destroyed', () => finish(true));
      contents.close({ waitForBeforeUnload: true });
      setTimeout(() => {
        if (entry.closeCancelled) finish(false);
      }, 50);
    });
    entry.discarding = false;
    if (!closed) {
      entry.protected = true;
      entry.lastActiveAt = Date.now();
      this.log('cloud-view-discard-cancelled', { kind: kindOf(entry.key), sessionId: sid(entry.key) });
      return false;
    }
    detachView(entry.view);
    this.entries.delete(entry.key);
    this.log('cloud-view-discard', { kind: kindOf(entry.key), sessionId: sid(entry.key), reason });
    notifyShell();
    return true;
  }

  // Key of the active view (null when none).
  activeKey(): string | null {
    return this.active?.key ?? null;
  }

  // Drops a non-active view at once, without the beforeunload negotiation -
  // for a page whose content no longer exists (deleted conversation).
  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry === this.active) return false;
    this.entries.delete(key);
    detachView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.log('cloud-view-discard', { kind: kindOf(key), sessionId: sid(key), reason: 'removed' });
    return true;
  }

  runIdleSweep(reason: 'idle' | 'switch' = 'idle'): void {
    const now = Date.now();
    const keys =
      this.keepAliveMs === 0
        ? [...this.entries.values()].filter((e) => e !== this.active).map((e) => e.key)
        : pickIdle(this.info(), this.keepAliveMs, now);
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) void this.discard(entry, this.keepAliveMs === 0 ? 'switch' : reason);
    }
  }

  // Re-reads config.limits() (settings hours → ms, with the test-mode
  // keep-alive override) and applies them.
  applyLimits(): void {
    const limits = this.config.limits();
    this.setLimits({
      maxLiveViews: limits.maxLiveViews,
      keepAliveMs: cloudKeepAliveMs(limits.keepAliveHours),
    });
  }

  setLimits(limits: { maxLiveViews: number; keepAliveMs: number }): void {
    this.maxLive = limits.maxLiveViews;
    this.keepAliveMs = limits.keepAliveMs;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.keepAliveMs > 0) {
      const every = Math.max(250, Math.min(60_000, this.keepAliveMs / 2));
      this.sweepTimer = setInterval(() => this.runIdleSweep('idle'), every);
      if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    }
  }

  setKeepAliveMs(ms: number): void {
    this.setLimits({ maxLiveViews: this.maxLive, keepAliveMs: Math.max(0, ms) });
  }

  // --- queries / hooks --------------------------------------------------------

  private info(): PoolEntryInfo[] {
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      lastActiveAt: entry.lastActiveAt,
      active: entry === this.active,
      protected: entry.protected,
      loading: entry.loading,
    }));
  }

  views(): WebContentsView[] {
    return [...this.entries.values()].map((entry) => entry.view);
  }

  activeView(): WebContentsView | null {
    return this.active?.view ?? null;
  }

  viewForKey(key: string): WebContentsView | null {
    return this.entries.get(key)?.view ?? null;
  }

  publicInfo(): { liveSessionIds: string[]; liveCount: number } {
    return {
      liveSessionIds: [...this.entries.keys()].filter((key) => key !== HOME_KEY),
      liveCount: this.entries.size,
    };
  }

  // Test-hook detail: key/url/active/loads/loading per pooled view.
  debugInfo(): { key: string; url: string; active: boolean; loads: number; loading: boolean }[] {
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      url: entry.view.webContents.getURL(),
      active: entry === this.active,
      loads: entry.loads,
      loading: entry.loading,
    }));
  }

  // Fires for the active view's navigation/load events (and once on each
  // activation) — the token reader hooks this instead of per-view listeners.
  onActiveNavigate(cb: () => void): () => void {
    this.activeNavigateCbs.add(cb);
    return () => this.activeNavigateCbs.delete(cb);
  }

  private fireActiveNavigate(): void {
    for (const cb of this.activeNavigateCbs) cb();
  }
}

export function createViewPool(config: ViewPoolConfig): ViewPool {
  return new ViewPool(config);
}
