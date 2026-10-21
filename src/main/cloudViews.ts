// Cloud session view pool. Instead of one devinView doing an in-page SPA
// reload per session switch, views are pooled by the session they display;
// switching to a cached session just swaps which view is attached.
//
// Token/user-content rules are unchanged: nothing here logs titles or tokens.

import { app, WebContentsView } from 'electron';
import { resolve } from 'node:path';
import {
  HOME_KEY,
  keyForUrl,
  pickEvictions,
  pickIdle,
  type PoolEntryInfo,
} from '../core/viewPool';
import { parseSessionId } from '../core/sessions';
import { log } from './log';
import { attachRouting } from './routing';
import { applySessionChange, attachSessionTracking } from './sessions';
import { cloudSessions } from './cloudSessions';
import { state } from './state';
import { applyLayout, detachView, notifyShell } from './window';

export const DEFAULT_MAX_LIVE_VIEWS = 6;
const DEFAULT_KEEPALIVE_MS = 24 * 60 * 60 * 1000;

// Effective keep-alive for pooled Cloud views: settings hours, overridable in
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

export class CloudViewPool {
  private entries = new Map<string, PoolEntry>();
  private active: PoolEntry | null = null;
  private maxLive = DEFAULT_MAX_LIVE_VIEWS;
  private keepAliveMs = DEFAULT_KEEPALIVE_MS;
  private sweepTimer: NodeJS.Timeout | null = null;
  private activeNavigateCbs = new Set<() => void>();

  constructor() {
    state.cloudViewsRef = this;
  }

  // --- lifecycle ------------------------------------------------------------

  private createView(key: string): PoolEntry {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:cloud',
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
    attachRouting(contents, 'devin');
    attachSessionTracking(contents);
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
      log('cloud', 'cloud-view-crashed', {
        detail: { kind: kindOf(entry.key), sessionId: sid(entry.key), reason: details.reason },
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
      log('devin', 'load-error', { url, detail: { message: String(error) } });
    });
  }

  init(tenantUrl: string): void {
    const home = this.createView(HOME_KEY);
    this.loadUrl(home, tenantUrl);
    this.makeActive(home, false);
  }

  reset(tenantUrl: string): void {
    this.dispose();
    this.entries.clear();
    this.active = null;
    this.init(tenantUrl);
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
    const sessionId =
      entry.key === HOME_KEY
        ? parseSessionId(entry.view.webContents.getURL(), state.tenantUrl)
        : entry.key;
    applySessionChange(sessionId, entry.view.webContents.getURL());
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
      log('cloud', 'cloud-view-show', {
        detail: { kind: kindOf(key), sessionId: sid(key), hit, liveCount: this.entries.size },
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
    log('cloud', 'cloud-view-show', {
      detail: { kind: kindOf(key), sessionId: sid(key), hit: false, liveCount: this.entries.size },
    });
  }

  prefetch(key: string, url: string): void {
    if (key === HOME_KEY || this.entries.has(key)) return;
    if (this.entries.size >= this.maxLive) return; // prefetch never evicts
    const entry = this.createView(key);
    this.loadUrl(entry, url);
    log('cloud', 'cloud-view-create', {
      detail: { kind: kindOf(key), sessionId: sid(key), prefetch: true },
    });
    notifyShell();
  }

  // When a pooled view navigates to another session the key must follow — this
  // is what keeps in-app sidebar clicks inside the web app working.
  private rekey(entry: PoolEntry, url: string): void {
    const next = keyForUrl(url, state.tenantUrl);
    if (next === entry.key) return;
    const other = this.entries.get(next);
    if (other && other !== entry) {
      if (other !== this.active) {
        log('cloud', 'cloud-view-duplicate', { detail: { sessionId: sid(next) } });
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
    log('cloud', 'cloud-view-rekey', {
      detail: {
        from: { kind: kindOf(fromKey), sessionId: sid(fromKey) },
        to: { kind: kindOf(next), sessionId: sid(next) },
      },
    });
    // A home→session rekey on the active view may be the composer finishing
    // a 'New session' — the sidebar files it under the pending folder.
    if (fromKey === HOME_KEY && next !== HOME_KEY && entry === this.active) {
      cloudSessions().noteHomeNavigation(next);
    }
    if (entry === this.active) {
      applySessionChange(next === HOME_KEY ? parseSessionId(url, state.tenantUrl) : next, url);
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
      log('cloud', 'cloud-view-discard-cancelled', {
        detail: { kind: kindOf(entry.key), sessionId: sid(entry.key) },
      });
      return false;
    }
    detachView(entry.view);
    this.entries.delete(entry.key);
    log('cloud', 'cloud-view-discard', {
      detail: { kind: kindOf(entry.key), sessionId: sid(entry.key), reason },
    });
    notifyShell();
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

let instance: CloudViewPool | null = null;

export function cloudViews(): CloudViewPool {
  instance ??= new CloudViewPool();
  return instance;
}
