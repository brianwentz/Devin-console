import { randomUUID } from 'node:crypto';
import type { Session, View as NativeView } from 'electron';
import { WebContentsView } from 'electron';
import {
  GLOBAL,
  activateTab,
  activeIdFor,
  closeScope as closeScopeModel,
  closeTab,
  emptyTabState,
  openTab,
  pickDiscardCandidates,
  pruneScopes,
  pullRequestKey,
  reorderTab,
  restoreTabs,
  scopeOf,
  serializeTabs,
  setScopeSeen,
  updateTab,
  visibleTabs,
  type BrowserTab,
  type PersistedTabs,
  type TabState,
} from '../core/tabModel';
import { loadStartReset, tabHistory, type TabHistory } from '../core/tabPaintDiag';

interface ManagedTab extends BrowserTab {
  view: WebContentsView | null;
  closing: boolean;
  closeCancelled: boolean;
  // A beforeunload-protected tab cancelled a discard — always skipped by
  // keep-alive and the live cap.
  protected: boolean;
  // State-safe discard (O6): the view was closed while idle; id/title/favicon/order are
  // kept and the page reloads on activation.
  discarded: boolean;
  discarding: boolean;
  lastActiveAt: number;
  // When the current webContents started loading (0 = no view yet) and whether
  // it has been attached since — read by the blank-pane diagnostics.
  loadedAt: number;
  shownSinceLoad: boolean;
}

export interface TabOpenOptions {
  background?: boolean;
  // Devin session this link was opened from; defaults to the visible scope.
  originSessionId?: string;
  // F1: create a discarded placeholder (no webContents until first activation).
  // Implies background; an existing (deduped) tab is left untouched.
  lazy?: boolean;
}

export interface TabLog {
  (event: string, detail?: Record<string, unknown>, url?: string): void;
}

export interface ScopeSummary {
  scope: string;
  count: number;
  liveCount: number;
  lastSeen: number;
}

export interface PublicTabs {
  tabs: BrowserTab[];
  activeId: string | null;
  scope: string;
  hiddenTabCount: number;
}

export interface TabManagerOptions {
  parent: NativeView;
  session: Session;
  log: TabLog;
  onCreated: (tabId: string, view: WebContentsView) => void;
  onChange: () => void;
  onBeforeUnload: (tabId: string, event: Electron.Event) => boolean;
  // Optional preload (autofill content script) attached to every tab view.
  preload?: string;
  // Called when the visible/active tab set changed (activate, close, scope
  // switch) — used to dismiss transient overlays like the autofill picker.
  onActiveChanged?: () => void;
  initialTabs?: unknown;
  testMode: boolean;
  // P8: hidden/non-active tabs keep their webContents live for this long; 0 =
  // discard hidden-scope tabs immediately on scope switch.
  keepAliveMs?: number;
  // Hard cap on live tab webContents across all scopes (visible active excluded).
  maxLiveTabs?: number;
}

export const DEFAULT_KEEPALIVE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_LIVE_TABS = 8;
const SCOPE_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Effective keep-alive: settings hours, overridable in test mode via
// AGENT_WORKSPACE_TEST_KEEPALIVE_MS so the e2e can exercise discard with a short window.
export function keepAliveMs(settingHours: number): number {
  const override =
    process.env.AGENT_WORKSPACE_TEST === '1' ? process.env.AGENT_WORKSPACE_TEST_KEEPALIVE_MS : undefined;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return Math.max(0, Math.floor(settingHours)) * 3_600_000;
}

export class TabManager {
  private readonly parent: NativeView;
  private readonly session: Session;
  private readonly log: TabLog;
  private readonly onCreated: TabManagerOptions['onCreated'];
  private readonly onChange: () => void;
  private readonly onBeforeUnload: TabManagerOptions['onBeforeUnload'];
  private readonly preloadPath: string | undefined;
  private readonly onActiveChanged: (() => void) | undefined;
  private readonly testMode: boolean;
  private state: TabState;
  private readonly entries = new Map<string, ManagedTab>();
  private activeViewId: string | null = null;
  private scope = GLOBAL;
  // Generation counter: a new run abandons any in-flight preload queue.
  private preloadGeneration = 0;
  // F8: while set, will-prevent-unload records a veto instead of prompting.
  private probeVetoes: Set<string> | null = null;
  private keepAliveMs: number;
  private maxLiveTabs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  // Attached views get the last layout rect so a scope switch never shows a 0x0 view.
  private lastBounds: Electron.Rectangle | null = null;
  // When the active view was last (re-)attached — read by the blank-pane diagnostics.
  private lastAttachAt = 0;
  // History of the most recent attachActive (blank-pane diagnostics).
  private lastAttachHistoryValue: { id: string; history: TabHistory } | null = null;
  // Pane hidden (setBounds(null)) while this tab was active; cleared when shown again.
  private paneHidden: { id: string; at: number } | null = null;

  constructor(options: TabManagerOptions) {
    this.parent = options.parent;
    this.session = options.session;
    this.log = options.log;
    this.onCreated = options.onCreated;
    this.onChange = options.onChange;
    this.onBeforeUnload = options.onBeforeUnload;
    this.preloadPath = options.preload;
    this.onActiveChanged = options.onActiveChanged;
    this.testMode = options.testMode;
    this.keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.maxLiveTabs = options.maxLiveTabs ?? DEFAULT_MAX_LIVE_TABS;
    this.state = pruneScopes(
      restoreTabs(options.initialTabs ?? emptyTabState()),
      Date.now(),
      SCOPE_PRUNE_AGE_MS,
    );
    for (const tab of this.state.tabs) {
      this.entries.set(tab.id, {
        ...tab,
        view: null,
        closing: false,
        closeCancelled: false,
        protected: false,
        discarded: true, // restored tabs are state-safe placeholders; load on activation
        discarding: false,
        lastActiveAt: Date.now(),
        loadedAt: 0,
        shownSinceLoad: false,
      });
    }
    this.scheduleSweep();
  }

  // ---- settings ----

  get keepAliveThresholdMs(): number {
    return this.keepAliveMs;
  }

  setKeepAliveMs(value: number): void {
    const next = Math.max(0, Math.floor(value));
    if (next === this.keepAliveMs) return;
    this.keepAliveMs = next;
    this.log('keepalive-threshold', { ms: next });
    this.scheduleSweep();
  }

  setMaxLiveTabs(value: number): void {
    const next = Math.max(1, Math.min(40, Math.floor(value)));
    if (next === this.maxLiveTabs) return;
    this.maxLiveTabs = next;
    this.log('max-live-tabs', { count: next });
    this.enforceLiveCap();
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.keepAliveMs <= 0) return;
    const interval = Math.max(250, Math.min(60_000, Math.floor(this.keepAliveMs / 2)));
    this.sweepTimer = setInterval(() => {
      void this.discardIdle();
    }, interval);
    this.sweepTimer.unref();
  }

  // ---- scope ----

  get currentScope(): string {
    return this.scope;
  }

  // Switch which session's tabs are shown. No-op when unchanged. The old scope's
  // tabs stay live (keep-alive window) but are detached from the window.
  setScope(scope: string): void {
    if (scope === this.scope) return;
    const now = Date.now();
    const previous = this.activeViewId ? this.entries.get(this.activeViewId) : undefined;
    if (previous) previous.lastActiveAt = now;
    this.state = setScopeSeen(this.state, this.scope, now);
    const prevView = this.activeViewId ? this.entries.get(this.activeViewId)?.view : null;
    if (prevView && this.parent.children.includes(prevView)) {
      this.parent.removeChildView(prevView);
    }
    this.activeViewId = null;
    this.scope = scope;

    const activeId = activeIdFor(this.state, scope);
    if (activeId) this.attachActive(activeId);
    const attached = this.lastAttachHistoryValue;
    if (activeId && this.activeViewId === activeId && attached?.id === activeId) {
      this.log('tabs-scope-switch', { scope, id: activeId, history: { ...attached.history } });
    } else {
      this.log('tabs-scope-switch', { scope });
    }
    this.enforceLiveCap();
    if (this.keepAliveMs === 0) {
      // Discard every live tab belonging to a now-hidden scope (state-safe).
      for (const entry of this.entries.values()) {
        if (scopeOf(entry) === scope || entry.closing || entry.discarding) continue;
        if (entry.view) void this.discard(entry.id);
      }
    }
    this.preloadVisibleScope();
    this.onChange();
    this.onActiveChanged?.();
  }

  // Load every discarded/placeholder tab belonging to the visible scope, one
  // per 150 ms so a big restore doesn't stampede the network. Views are created
  // but not attached (background-load). A later setScope abandons the queue.
  preloadVisibleScope(): void {
    const generation = ++this.preloadGeneration;
    const scope = this.scope;
    const pending = [...this.entries.values()]
      .filter(
        (entry) =>
          scopeOf(entry) === scope &&
          (!entry.view?.webContents || entry.view.webContents.isDestroyed()) &&
          !entry.closing &&
          !entry.discarding,
      )
      .map((entry) => entry.id);
    this.log('tabs-preload', { scope, count: pending.length });
    if (pending.length === 0) return;
    const step = (index: number) => {
      if (index >= pending.length) return;
      const timer = setTimeout(
        () => {
          if (generation !== this.preloadGeneration || scope !== this.scope) return;
          const entry = this.entries.get(pending[index]!);
          if (
            entry &&
            scopeOf(entry) === this.scope &&
            (!entry.view?.webContents || entry.view.webContents.isDestroyed()) &&
            !entry.closing &&
            !entry.discarding
          ) {
            entry.lastActiveAt = Date.now();
            this.ensureView(entry.id);
          }
          step(index + 1);
        },
        index === 0 ? 0 : 150,
      );
      timer.unref?.();
    };
    step(0);
  }

  // Live-tab LRU cap across all scopes; the visible scope is exempt — its
  // tabs are preloaded and stay live by design. beforeunload-protected tabs
  // are skipped.
  private enforceLiveCap(): void {
    const entries = [...this.entries.values()].map((entry) => {
      const contents = entry.view?.webContents;
      return {
        id: entry.id,
        lastActiveAt: entry.lastActiveAt,
        live: Boolean(entry.view && contents && !contents.isDestroyed()),
        protected: entry.protected || entry.discarding || entry.closing,
        inVisibleScope: scopeOf(entry) === this.scope,
      };
    });
    for (const id of pickDiscardCandidates(entries, this.maxLiveTabs)) {
      void this.discard(id);
    }
  }

  // Discard every inactive tab idle beyond the keep-alive threshold. Idle for a
  // hidden-scope tab is frozen at the moment its scope was hidden.
  async discardIdle(now = Date.now()): Promise<string[]> {
    if (this.keepAliveMs <= 0) return [];
    const discarded: string[] = [];
    for (const entry of this.entries.values()) {
      // The visible scope's tabs are all kept loaded — they never idle out
      // while you're looking at the session.
      if (scopeOf(entry) === this.scope || !entry.view || entry.closing || entry.discarding)
        continue;
      if (entry.loading) continue;
      if (now - entry.lastActiveAt < this.keepAliveMs) continue;
      if (await this.discard(entry.id)) discarded.push(entry.id);
    }
    return discarded;
  }

  // Close the webContents of an inactive tab but keep the tab (id/title/favicon/order).
  // A page that prevents unload (unsaved draft) cancels the discard and is kept alive.
  async discard(tabId: string): Promise<boolean> {
    const entry = this.entries.get(tabId);
    if (!entry || !entry.view || entry.closing || entry.discarding) return false;
    if (tabId === this.activeViewId) return false;
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return false;
    entry.discarding = true;
    entry.closeCancelled = false;
    const view = entry.view;
    const closed = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (didClose: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(didClose);
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
      // beforeunload kept the page: protected and back off for a full keep-alive period.
      entry.protected = true;
      entry.lastActiveAt = Date.now();
      this.log('tab-discard-cancelled', { id: tabId }, entry.url);
      return false;
    }
    if (this.parent.children.includes(view)) this.parent.removeChildView(view);
    entry.view = null;
    entry.discarded = true;
    entry.loading = false;
    if (this.activeViewId === tabId) this.activeViewId = null;
    this.log('tab-discard', { id: tabId }, entry.url);
    this.onChange();
    return true;
  }

  get activeId(): string | null {
    return activeIdFor(this.state, this.scope);
  }

  get activeView(): WebContentsView | null {
    return this.activeViewId ? (this.entries.get(this.activeViewId)?.view ?? null) : null;
  }

  get activeWebContents(): Electron.WebContents | null {
    return this.activeView?.webContents ?? null;
  }

  // The pane bounds the active view should have (null while the pane is hidden).
  get expectedBounds(): Electron.Rectangle | null {
    return this.lastBounds;
  }

  get lastAttachedAt(): number {
    return this.lastAttachAt;
  }

  // Hidden history of the active tab's most recent attach, or null.
  get lastAttachHistory(): TabHistory | null {
    const last = this.lastAttachHistoryValue;
    return last && last.id === this.activeViewId ? last.history : null;
  }

  get currentState(): TabState {
    return this.state;
  }

  getViews(): WebContentsView[] {
    return [...this.entries.values()]
      .map((entry) => entry.view)
      .filter((view): view is WebContentsView => view !== null);
  }

  getView(tabId: string): WebContentsView | null {
    return this.entries.get(tabId)?.view ?? null;
  }

  getTab(tabId: string): ManagedTab | undefined {
    return this.entries.get(tabId);
  }

  // Dedupe (core/tabModel.openTab): same owner/repo/pull/N within the scope ->
  // focus + navigate the existing tab; exact URL -> focus; otherwise a new tab.
  open(url: string, options: boolean | TabOpenOptions = {}): string {
    const opts: TabOpenOptions = typeof options === 'boolean' ? { background: options } : options;
    const lazy = opts.lazy ?? false;
    const background = lazy || (opts.background ?? false);
    const scope = opts.originSessionId ?? this.scope;
    const result = openTab(this.state, url, {
      id: randomUUID(),
      background,
      scope,
    });

    if (!result.created && lazy) {
      // Lazy opens never disturb a tab the user already has: no navigate, no
      // activation, no model change (openTab may have updated url/loading).
      this.log('tab-existing', { id: result.id, background, lazy: true }, url);
      return result.id;
    }
    this.state = result.state;

    if (!result.created) {
      const entry = this.entries.get(result.id);
      if (entry && result.navigate) {
        entry.url = url;
        entry.loading = true;
        const contents = entry.view?.webContents;
        if (contents && !contents.isDestroyed()) {
          contents.loadURL(url).catch((error: unknown) => {
            this.log('load-error', { id: result.id, message: String(error) }, url);
          });
        }
      }
      if (!background && scope === this.scope) this.activate(result.id);
      this.log(
        result.navigate ? 'tab-dedupe-navigate' : 'tab-existing',
        { id: result.id, background },
        url,
      );
      this.enforceLiveCap();
      this.onChange();
      return result.id;
    }

    const created = this.state.tabs.find((tab) => tab.id === result.id);
    const entry: ManagedTab = {
      id: result.id,
      url,
      title: created?.title ?? url,
      loading: !lazy,
      ...(scope !== GLOBAL ? { originSessionId: scope } : {}),
      view: null,
      closing: false,
      closeCancelled: false,
      protected: false,
      // Lazy tabs are state-safe placeholders (like restored tabs): the page loads on activation.
      discarded: lazy,
      discarding: false,
      lastActiveAt: Date.now(),
      loadedAt: 0,
      shownSinceLoad: false,
    };
    this.entries.set(result.id, entry);
    if (lazy) {
      // No webContents: nothing to load, nothing for the live cap to count.
      this.state = updateTab(this.state, result.id, { loading: false });
      // ...unless it is now the visible scope's only (hence active) tab: render it
      // rather than show an active-but-empty pane. Nothing else was showing, so
      // this steals no focus. activate() -> ensureView() clears `discarded`.
      if (scope === this.scope && activeIdFor(this.state, scope) === result.id) {
        this.activate(result.id);
      }
    } else if (background) {
      // Create the view now so the page loads while hidden; it is attached on activation.
      this.ensureView(result.id);
    } else {
      this.activate(result.id);
    }
    this.log(
      'tab-open',
      {
        id: result.id,
        background,
        originSessionId: scope !== GLOBAL ? scope : null,
        ...(lazy ? { lazy: true } : {}),
      },
      url,
    );
    if (!lazy) this.enforceLiveCap();
    this.onChange();
    return result.id;
  }

  ensureView(tabId: string): WebContentsView | null {
    const entry = this.entries.get(tabId);
    if (!entry) return null;
    if (entry.view && !entry.view.webContents.isDestroyed()) return entry.view;
    // A view left behind by an out-of-band webContents teardown (its 'destroyed'
    // handler clears entry.view, but a race can leave it set) is dead weight —
    // drop it so the bookkeeping below treats this as a restore.
    entry.view = null;

    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        ...(this.preloadPath ? { preload: this.preloadPath } : {}),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    entry.view = view;
    if (entry.discarded) {
      entry.discarded = false;
      this.log('tab-restore', { id: tabId }, entry.url);
    }
    entry.loading = true;
    entry.loadedAt = Date.now();
    entry.shownSinceLoad = false;
    view.setBackgroundColor('#111827');
    const contents = view.webContents;

    contents.on('page-title-updated', (_event, title) => {
      entry.title = title.slice(0, 512);
      // Page titles can contain secrets; log the event without the text.
      this.log('title', { id: tabId }, contents.getURL());
      this.onChange();
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      entry.favicon = favicons[0];
      this.log('favicon', { id: tabId, favicon: entry.favicon }, contents.getURL());
      this.onChange();
    });
    // Every main-frame load (first load, reload, in-tab navigation) restarts the
    // load clock; it counts as shown only if it starts while visible in the pane.
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || entry.view !== view) return;
      const reset = loadStartReset({
        now: Date.now(),
        attached: this.activeViewId === tabId && this.parent.children.includes(view),
        paneVisible: this.lastBounds !== null,
      });
      entry.loadedAt = reset.loadedAt;
      entry.shownSinceLoad = reset.shownSinceLoad;
    });
    contents.on('did-start-loading', () => {
      entry.loading = true;
      this.log('did-start-loading', { id: tabId }, contents.getURL());
      this.onChange();
    });
    contents.on('did-stop-loading', () => {
      entry.loading = false;
      this.updateHistoryState(entry);
      this.log('did-stop-loading', { id: tabId }, contents.getURL());
      this.onChange();
    });
    contents.on('did-navigate', (_event, url) => {
      entry.url = url;
      entry.protected = false; // draft submitted/navigated away — re-eligible for discard
      this.state = updateTab(this.state, tabId, { url });
      this.updateHistoryState(entry);
      this.onChange();
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      entry.url = url;
      entry.protected = false;
      this.state = updateTab(this.state, tabId, { url });
      this.updateHistoryState(entry);
      this.onChange();
    });
    contents.on('will-prevent-unload', (event) => {
      if (entry.discarding) {
        // Silent for discards: the page keeps its state and the discard is cancelled.
        entry.closeCancelled = true;
        this.log('will-prevent-unload', { id: tabId, leave: false, discard: true }, contents.getURL());
        return;
      }
      if (this.probeVetoes) {
        // F8 shutdown probe: record the veto instead of prompting per tab.
        this.probeVetoes.add(tabId);
        entry.closeCancelled = true;
        this.log('will-prevent-unload', { id: tabId, leave: false, probe: true }, contents.getURL());
        return;
      }
      const leave = this.onBeforeUnload(tabId, event);
      entry.closeCancelled = !leave;
      this.log('will-prevent-unload', { id: tabId, leave }, contents.getURL());
    });
    contents.on('render-process-gone', (_event, details) => {
      this.log(
        'render-process-gone',
        { id: tabId, reason: details.reason, exitCode: details.exitCode },
        contents.getURL(),
      );
    });
    // No url argument: these carry the tab id only.
    contents.on('unresponsive', () => {
      this.log('tab-unresponsive', { id: tabId });
    });
    contents.on('responsive', () => {
      this.log('tab-responsive', { id: tabId });
    });
    contents.on('destroyed', () => {
      this.log('webcontents-destroyed', { id: tabId }, entry.url);
      // Identity check: a later ensureView may already own a fresh view for this tab.
      if (entry.view !== view) return;
      if (this.parent.children.includes(view)) this.parent.removeChildView(view);
      entry.view = null;
      entry.discarded = true;
      entry.loading = false;
      if (this.activeViewId === tabId) this.activeViewId = null;
      this.onChange();
    });
    this.onCreated(tabId, view);
    contents.loadURL(entry.url).catch((error: unknown) => {
      this.log('load-error', { id: tabId, message: String(error) }, entry.url);
    });
    return view;
  }

  // Swap the attached view to `tabId`'s view (creating/restoring as needed).
  private attachActive(tabId: string): void {
    // Captured before anything below mutates the entry (ensureView, lastActiveAt).
    const before = this.entries.get(tabId);
    const createdOnAttach = !before?.view || before.view.webContents.isDestroyed();
    const wasActive = this.activeViewId === tabId;
    const lastActiveAt = before?.lastActiveAt ?? 0;
    const loadedAt = before?.loadedAt ?? 0;
    const shownSinceLoad = before?.shownSinceLoad ?? false;
    // A failed attach must not leave an older attach's history behind for this activation.
    if (this.lastAttachHistoryValue?.id === tabId) this.lastAttachHistoryValue = null;
    this.ensureView(tabId);
    const view = this.entries.get(tabId)?.view;
    if (!view || view.webContents.isDestroyed()) return;
    if (this.parent.children.includes(view)) this.parent.removeChildView(view);
    this.parent.addChildView(view);
    view.setBounds(this.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 });
    // A detached WebContentsView never leaves Chromium's VISIBLE state, so
    // re-adding it does not run the hidden→shown cycle that makes the renderer
    // submit a fresh frame — the pane stays blank until the next re-parent. A
    // hide/show round-trip on attach forces that cycle every time.
    view.setVisible(false);
    view.setVisible(true);
    this.lastAttachAt = Date.now();
    this.activeViewId = tabId;
    const entry = this.entries.get(tabId);
    if (entry) {
      const now = Date.now();
      this.lastAttachHistoryValue = {
        id: tabId,
        history: tabHistory({
          now,
          lastActiveAt,
          // A view created by this attach: its fresh load, never shown yet.
          loadedAt: createdOnAttach ? entry.loadedAt : loadedAt,
          shownSinceLoad: createdOnAttach ? false : shownSinceLoad,
          createdOnAttach,
          wasActive,
        }),
      };
      entry.lastActiveAt = now;
      if (this.lastBounds !== null) {
        entry.shownSinceLoad = true;
      } else if (this.paneHidden?.id !== tabId) {
        // Attached into a hidden pane (0x0): not shown yet; the next pane show
        // logs `tab-pane-shown` for this tab, timed from this attach.
        this.paneHidden = { id: tabId, at: now };
      }
    }
  }

  activate(tabId: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    // User is back on this tab — any earlier beforeunload protection is stale.
    entry.protected = false;
    // Idle clock: the previously active tab starts idling now; the new one is fresh.
    const previous = this.activeViewId ? this.entries.get(this.activeViewId) : undefined;
    if (previous && previous !== entry) previous.lastActiveAt = Date.now();
    this.state = activateTab(this.state, tabId);
    const current = this.activeViewId ? this.entries.get(this.activeViewId)?.view : null;
    if (current && current !== entry.view && this.parent.children.includes(current)) {
      this.parent.removeChildView(current);
    }
    this.attachActive(tabId);
    const attached = this.lastAttachHistoryValue;
    this.log('tab-activate', {
      id: tabId,
      history: attached && attached.id === tabId ? { ...attached.history } : null,
    });
    this.enforceLiveCap();
    this.onChange();
    this.onActiveChanged?.();
  }

  setBounds(bounds: Electron.Rectangle | null): void {
    this.lastBounds = bounds;
    this.notePaneVisibility(bounds !== null);
    const active = this.activeView;
    if (!active) return;
    active.setBounds(
      bounds ?? {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      },
    );
  }

  // Pane hide/show while the same tab stays active: logs how long it was hidden.
  private notePaneVisibility(visible: boolean): void {
    const activeId = this.activeView ? this.activeViewId : null;
    if (!visible) {
      if (!this.paneHidden && activeId) this.paneHidden = { id: activeId, at: Date.now() };
      return;
    }
    const hidden = this.paneHidden;
    if (!hidden) return;
    this.paneHidden = null;
    if (hidden.id !== activeId) return;
    const hiddenMs = Date.now() - hidden.at;
    const entry = this.entries.get(hidden.id);
    if (entry) entry.shownSinceLoad = true;
    this.log('tab-pane-shown', { id: hidden.id, hiddenMs });
    const last = this.lastAttachHistoryValue;
    if (last && last.id === hidden.id) last.history.paneHiddenMs = hiddenMs;
  }

  async close(tabId: string): Promise<boolean> {
    const entry = this.entries.get(tabId);
    if (!entry || entry.closing) return false;
    entry.closing = true;
    entry.closeCancelled = false;
    const contents = entry.view?.webContents;

    if (contents && !contents.isDestroyed()) {
      const closed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (didClose: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(didClose);
        };
        const timer = setTimeout(() => {
          finish(contents.isDestroyed());
        }, 3000);
        contents.once('destroyed', () => finish(true));
        contents.close({ waitForBeforeUnload: true });
        setTimeout(() => {
          if (entry.closeCancelled) finish(false);
        }, 50);
      });
      if (!closed) {
        entry.closing = false;
        this.log('tab-close-cancelled', { id: tabId }, entry.url);
        return false;
      }
    }

    const scope = scopeOf(entry);
    if (entry.view && this.parent.children.includes(entry.view)) this.parent.removeChildView(entry.view);
    this.entries.delete(tabId);
    this.state = closeTab(this.state, tabId);
    if (this.activeViewId === tabId) {
      this.activeViewId = null;
      const next = activeIdFor(this.state, scope);
      if (next) this.activate(next);
    }
    this.log('tab-close', { id: tabId }, entry.url);
    this.onChange();
    this.onActiveChanged?.();
    return true;
  }

  // F8 shutdown probe: close every live tab's webContents honouring
  // beforeunload; vetoes are collected (no prompts) and returned. Successfully
  // closed tabs become `discarded` (state-safe — chrome survives, snapshot
  // still persists, and on a vetoed quit they reload on next activation).
  async probe(): Promise<{ live: number; vetoed: string[] }> {
    this.probeVetoes = new Set();
    const vetoed: string[] = [];
    const live = [...this.entries.values()].filter(
      (entry) => entry.view?.webContents && !entry.view.webContents.isDestroyed() && !entry.closing,
    );
    try {
      // Parallel: tabs are independent; worst case stays ~3 s, not 3 s × N.
      await Promise.all(
        live.map(async (entry) => {
          const contents = entry.view!.webContents;
          const view = entry.view!;
          entry.closing = true;
          entry.closeCancelled = false;
          const closed = await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (didClose: boolean) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(didClose);
            };
            const timer = setTimeout(() => finish(contents.isDestroyed()), 3000);
            contents.once('destroyed', () => finish(true));
            contents.close({ waitForBeforeUnload: true });
            setTimeout(() => {
              if (entry.closeCancelled) finish(false);
            }, 50);
          });
          entry.closing = false;
          if (!closed) {
            vetoed.push(entry.id);
            return;
          }
          if (this.parent.children.includes(view)) this.parent.removeChildView(view);
          entry.view = null;
          entry.discarded = true;
          entry.loading = false;
          if (this.activeViewId === entry.id) this.activeViewId = null;
          this.log('tab-discard', { id: entry.id, probe: true }, entry.url);
        }),
      );
    } finally {
      this.probeVetoes = null;
      this.onChange();
    }
    return { live: live.length, vetoed };
  }

  // F8 cancel path: the probe may have discarded the visible active tab.
  // Re-activate a vetoed tab in the *visible* scope if one exists (never pull a
  // hidden-scope tab into the strip), else re-activate the scope's own active
  // tab so its discarded webContents reloads.
  restoreAfterProbeCancel(vetoed: string[]): void {
    const scope = this.scope;
    const target =
      vetoed.find((id) => {
        const entry = this.entries.get(id);
        return entry !== undefined && scopeOf(entry) === scope;
      }) ?? activeIdFor(this.state, scope);
    if (target) this.activate(target);
    this.preloadVisibleScope();
  }

  // Close every tab in a scope (hidden or visible). Respects beforeunload —
  // cancelled tabs stay live and visible. Returns the ids actually closed.
  async closeScope(scope: string): Promise<string[]> {
    const ids = this.state.tabs.filter((tab) => scopeOf(tab) === scope).map((tab) => tab.id);
    const closed: string[] = [];
    for (const id of ids) {
      if (await this.close(id)) closed.push(id);
    }
    // Only clear scope bookkeeping when nothing survived — close() already
    // maintains activeByScope per tab; stripping it wholesale would orphan
    // beforeunload-protected tabs (entries with no visible tab).
    if (!this.state.tabs.some((tab) => scopeOf(tab) === scope)) {
      this.state = closeScopeModel(this.state, scope);
    }
    this.log('tabs-scope-closed', { scope, closed: closed.length });
    this.onChange();
    return closed;
  }

  listScopes(): ScopeSummary[] {
    const byScope = new Map<string, { count: number; liveCount: number }>();
    for (const tab of this.state.tabs) {
      const scope = scopeOf(tab);
      const bucket = byScope.get(scope) ?? { count: 0, liveCount: 0 };
      bucket.count += 1;
      const contents = this.entries.get(tab.id)?.view?.webContents;
      if (contents && !contents.isDestroyed()) bucket.liveCount += 1;
      byScope.set(scope, bucket);
    }
    return [...byScope.entries()].map(([scope, bucket]) => ({
      scope,
      ...bucket,
      lastSeen: this.state.lastSeenByScope[scope] ?? 0,
    }));
  }

  // Reload every live tab in the visible scope; discarded tabs are skipped
  // (they reload on activation anyway). Returns the number reloaded.
  reloadScope(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (scopeOf(entry) !== this.scope || entry.discarded || !entry.view) continue;
      const contents = entry.view.webContents;
      if (contents.isDestroyed()) continue;
      contents.reload();
      count += 1;
    }
    this.log('tabs-reload-scope', { scope: this.scope, count });
    return count;
  }

  reorder(tabId: string, toIndex: number): void {
    this.state = reorderTab(this.state, tabId, toIndex);
    this.log('tab-reorder', { id: tabId, toIndex });
    this.onChange();
  }

  // Point the active tab at `url` (address bar / favorites with target 'current').
  // A discarded tab only records the url; its view loads it when recreated.
  navigateActive(url: string): boolean {
    const id = this.activeId;
    const entry = id ? this.entries.get(id) : undefined;
    if (!id || !entry) return false;
    // Keep per-scope dedupe: a different tab already showing this URL (or PR) wins.
    const key = pullRequestKey(url);
    const other = visibleTabs(this.state, this.scope).find(
      (tab) =>
        tab.id !== id && (tab.url === url || (key !== null && pullRequestKey(tab.url) === key)),
    );
    if (other) {
      this.activate(other.id);
      return true;
    }
    const contents = entry.view?.webContents;
    const live = !!contents && !contents.isDestroyed();
    // A discarded tab has no view to finish loading; only a live one is loading.
    if (live) entry.loading = true;
    this.updateUrl(id, url);
    if (contents && live) {
      contents.loadURL(url).catch((error: unknown) => {
        this.log('load-error', { id, message: String(error) }, url);
      });
    }
    return true;
  }

  updateUrl(tabId: string, url: string): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    entry.url = url;
    this.state = updateTab(this.state, tabId, { url });
    this.onChange();
  }

  persistableState(): PersistedTabs {
    return serializeTabs(this.state);
  }

  publicState(): PublicTabs {
    const visible = visibleTabs(this.state, this.scope);
    return {
      tabs: visible.map((tab) => {
        const entry = this.entries.get(tab.id);
        return {
          ...tab,
          title: entry?.title ?? tab.title,
          url: entry?.url ?? tab.url,
          favicon: entry?.favicon,
          loading: entry?.loading ?? false,
          ...(tab.originSessionId ? { originSessionId: tab.originSessionId } : {}),
          ...(entry?.discarded ? { discarded: true } : {}),
          canGoBack: this.canGoBack(entry),
          canGoForward: this.canGoForward(entry),
        };
      }),
      activeId: this.activeId,
      scope: this.scope,
      hiddenTabCount: this.state.tabs.length - visible.length,
    };
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const entry of this.entries.values()) {
      if (entry.view && this.parent.children.includes(entry.view)) this.parent.removeChildView(entry.view);
    }
    this.entries.clear();
    this.state = emptyTabState();
    this.activeViewId = null;
  }

  private updateHistoryState(entry: ManagedTab): void {
    entry.loading = false;
    this.onChange();
  }

  private canGoBack(entry: ManagedTab | undefined): boolean {
    const contents = entry?.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    return contents.navigationHistory.getActiveIndex() > 0;
  }

  private canGoForward(entry: ManagedTab | undefined): boolean {
    const contents = entry?.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    const history = contents.navigationHistory;
    return history.getActiveIndex() + 1 < history.length();
  }
}
