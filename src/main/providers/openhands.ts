// OpenHands Cloud runtime: a REST-poll source (../openhands/source.ts) driven by
// the generic CloudSessionsController. The lifecycle (opt-in gate, poll timer,
// focus, base URL change) lives in ../openhands/runtimeCore.ts; this module
// wires it to Electron. Top level only builds the object — Electron singletons
// are resolved inside methods (this module sits in import cycles with
// window/shortcuts).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, net, session, webContents } from 'electron';
import { sanitizeMessage } from '../../core/devinApi';
import { isConversationId, normalizeBaseUrl, openhandsOwnsUrl } from '../../core/openhands';
import { providerScope } from '../../core/tabModel';
import type { OpenHandsContextMenuRequest } from '../../shared/ipc';
import { providerById } from '../../core/providers';
import type { CloudCache } from '../../core/cloudCache';
import { topByCost, type OpenHandsUsageState } from '../../core/openhandsUsage';
import { CloudSessionsController } from '../cloudKit/sessionsController';
import { UsageFeed, usageSource } from '../cloudKit/usage';
import { autoOpenLocalPr } from '../local/prAutoOpen';
import { log } from '../log';
import { notificationStore } from '../notifications';
import { createOpenHandsPrTracker, type OpenHandsPrTracker } from '../openhands/prs';
import { allOpenPullRequests, prStore } from '../prs';
import { prTitles } from '../prTitles';
import { createTransitionNotifier } from '../openhands/notify';
import { OpenHandsContextMenu } from '../openhands/contextMenu';
import { createOpenHandsFetch } from '../openhands/fetch';
import {
  cacheMatchesTenant,
  createOpenHandsRuntimeCore,
  type OhSettingsLike,
} from '../openhands/runtimeCore';
import { buildOpenHandsShellState, createOpenHandsSource } from '../openhands/source';
import { createOpenHandsUsageService, type OpenHandsUsageService } from '../openhands/usage';
import {
  openhandsForgetSession,
  openhandsOpenSession,
  openhandsShowHome,
  openhandsViews,
  resetOpenHandsViews,
} from '../openhands/views';
import {
  idleOpenHandsState,
  openhandsEffectiveBase,
  setOpenHandsSnapshotSource,
  setOpenHandsUsageSource,
} from '../openhandsConfig';
import { fixtureOrigins, state, testMode } from '../state';
import { activateWindow, applyLayout, notifyShell } from '../window';
import type { ProviderRuntime } from './runtime';

const PARTITION = 'persist:openhands';
// Last key the transport read — only used to scrub error text.
let knownKey: string | null = null;

const cachePath = (): string => join(app.getPath('userData'), 'openhands-cache.json');
const tenantKey = (base: string): string => normalizeBaseUrl(base, true) ?? base;
const effective = openhandsEffectiveBase;

async function readCacheFile(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(cachePath(), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Status transitions of a successful list -> notification entries (gate in
// ../openhands/notify.ts, same defaults as the Claude chat path).
const notifyTransitions = createTransitionNotifier({
  settings: () => state.settings?.current.notifications,
  add: (entry) => void notificationStore().add(entry),
  log: (event, detail) => log('shell', event, { detail }),
});

// Usage (Analytics -> OpenHands, `openhands-quota` alerts): one service per
// base URL, built with the source, so it only runs while a gate is open.
// Quota readings land in this feed (the runtime's UsageSource).
const openhandsUsageFeed = new UsageFeed();
// Analytics -> OpenHands on screen (60 s cadence instead of 15 min).
let usageVisible = false;

const unrefTimer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
};

// PR panel + auto-open: one tracker per base URL (built with its source), so a
// base change drops the old origin's PRs and starts a fresh baseline.
let prTracker: OpenHandsPrTracker | null = null;
let unsubscribePrTitles: (() => void) | null = null;
// Same cadence as Claude's refreshPrStates: a tracked non-final PR's state is
// re-fetched at most every 10 min (the prTitles cache gates the rest).
const PR_STATE_REFRESH_MS = 10 * 60_000;

function reconcilePrs(): void {
  try {
    prStore().reconcile(allOpenPullRequests(), Date.now());
  } catch {
    // PR store not initialised yet (boot order): the next poll reconciles.
  }
  notifyShell();
}

function build(base: string) {
  const fetcher = createOpenHandsFetch({
    baseUrl: () => base,
    apiKey: async () => {
      knownKey = (await state.secrets?.getOpenHandsApiKey()) ?? null;
      return knownKey;
    },
    netFetch: ((url, init) => net.fetch(String(url), init as RequestInit)) as typeof fetch,
    sessionFetch: ((url, init) =>
      session.fromPartition(PARTITION).fetch(String(url), init as RequestInit)) as typeof fetch,
  });
  const tracker = createOpenHandsPrTracker({
    fetch: fetcher,
    githubOrigins: fixtureOrigins,
    autoOpen: (url, id) => void autoOpenLocalPr(url, providerScope('openhands', id), 'openhands-poll'),
    onChange: (added) => {
      if (added.length > 0) prTitles.ensure(added);
      reconcilePrs();
    },
    stateOf: (url) => prTitles.getInfo(url)?.state ?? null,
    ensureStates: (urls) => prTitles.ensure(urls, { maxAgeMs: PR_STATE_REFRESH_MS }),
    log: (event, detail) => log('shell', event, { detail }),
  });
  const previous = prTracker;
  previous?.stop();
  prTracker = tracker;
  // A state landing in the title cache (merged/closed) drops the PR from the
  // panel + badge; prStore.reconcile honours the prsKnown pruning gate.
  unsubscribePrTitles?.();
  unsubscribePrTitles = prTitles.addChangeListener(() => {
    if (prTracker === tracker && tracker.hasPullRequests()) reconcilePrs();
  });
  if (previous) reconcilePrs();
  const source = createOpenHandsSource({
    fetch: fetcher,
    now: () => Date.now(),
    log: (event, detail) => log('shell', event, { detail }),
    baseUrl: () => base,
    onRows: (rows) => tracker.onRows(rows),
    onTransitions: (transitions) => {
      notifyTransitions(transitions);
      // One events scan per finished transition (skipped while one is in flight).
      for (const t of transitions) if (t.kind === 'finished') void tracker.onFinished(t.id);
    },
  });
  const controller = new CloudSessionsController(source, {
    tenantKey: () => tenantKey(base),
    readCache: readCacheFile,
    writeCache: async (data: CloudCache) => {
      const file = cachePath();
      await mkdir(join(file, '..'), { recursive: true });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(data), 'utf8');
      await rename(temporary, file);
    },
    log: (event, detail) => log('shell', event, { detail }),
    sanitize: (message) => sanitizeMessage(message, knownKey ?? ''),
    onChange: () => notifyShell(),
  });
  // A new base (or a reopened gate) starts with no readings: drop the old base's.
  openhandsUsageFeed.publish([]);
  const usage = createOpenHandsUsageService({
    fetch: fetcher,
    baseUrl: () => base,
    now: () => Date.now(),
    visible: () => usageVisible,
    setTimer: unrefTimer,
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (event, detail) => log('shell', event, { detail }),
    onChange: () => notifyShell(),
    publish: (readings) => openhandsUsageFeed.publish(readings),
  });
  return { source, controller, usage };
}

// The hosted view navigating onto the base origin while the list is refused
// (a web sign-in just finished) lists now instead of waiting out the backoff.
let unsubscribeNavigate: (() => void) | null = null;
function watchViewNavigation(): void {
  if (unsubscribeNavigate) return;
  unsubscribeNavigate = openhandsViews().onActiveNavigate(() => {
    const url = openhandsViews().activeView()?.webContents.getURL() ?? '';
    if (url && openhandsOwnsUrl(url, effective(state.settings?.current.openhands.baseUrl))) {
      core.onViewNavigatedHome();
    }
  });
}

const core = createOpenHandsRuntimeCore<OpenHandsUsageService>({
  currentBase: () => effective(state.settings?.current.openhands.baseUrl),
  baseOf: (s: OhSettingsLike) => effective(s.openhands.baseUrl),
  pollSeconds: () => state.settings?.current.openhands.pollSeconds ?? 30,
  pollMs: (seconds) => {
    const override = testMode ? Number(process.env.AGENT_WORKSPACE_TEST_OPENHANDS_POLL_MS) : 0;
    return override > 0 ? override : seconds * 1000;
  },
  build,
  hasKey: async () => ((await state.secrets?.getOpenHandsApiKey()) ?? null) !== null,
  cacheMatches: async (base) => cacheMatchesTenant(await readCacheFile(), tenantKey(base)),
  dropCache: () => rm(cachePath(), { force: true }),
  setTimer: unrefTimer,
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // A hosted WebContentsView leaves BaseWindow.isFocused() false.
  focused: () => webContents.getFocusedWebContents() !== null,
  onChange: () => notifyShell(),
  log: (event, detail) => log('shell', event, { detail }),
});

// Live controller state only (null before a gate opens).
function liveSnapshot() {
  const live = core.snapshot();
  return live ? buildOpenHandsShellState(live.state, live.connection) : null;
}

// ShellState slice: the live state, or an idle one carrying the error of a
// rename/delete that found no gate open.
function snapshot() {
  const live = liveSnapshot();
  const local = core.localError();
  if (live) return live.lastError || !local ? live : { ...live, lastError: local };
  return local ? idleOpenHandsState(local) : null;
}

// ShellState.usage.openhands (null = pending cards: no gate open yet).
function usageState(): OpenHandsUsageState | null {
  const usage = core.usage();
  if (!usage) return null;
  return { ...usage.cards(), topByCost: topByCost(liveSnapshot()?.sessions ?? []) };
}

const menu = new OpenHandsContextMenu({
  titleOf: (id) => liveSnapshot()?.sessions.find((s) => s.id === id)?.title,
  capabilities: () => liveSnapshot()?.capabilities ?? { rename: false, delete: false },
  baseUrl: () => effective(state.settings?.current.openhands.baseUrl),
  newSession: () => void openhandsRuntime.newSession?.(),
  refresh: () => void openhandsRefresh(),
  remove: (id) => openhandsDelete(id),
});

export const openhandsRuntime: ProviderRuntime & { showHome?: () => void } = {
  descriptor: providerById('openhands'),
  usage: usageSource({
    providerId: 'openhands',
    source: 'openhands',
    feed: () => openhandsUsageFeed,
    summary: () => core.usage()?.summary() ?? [],
  }),
  start() {
    setOpenHandsSnapshotSource(snapshot);
    setOpenHandsUsageSource(usageState);
    void core.start();
  },
  onPrPanelOpen() {
    prTracker?.refreshStates();
  },
  dispose: () => {
    unsubscribeNavigate?.();
    unsubscribeNavigate = null;
    unsubscribePrTitles?.();
    unsubscribePrTitles = null;
    prTracker?.stop();
    return core.dispose();
  },
  onFocus() {
    core.onFocus();
  },
  onSettingsChanged(previous, next) {
    void core.onSettingsChanged(previous, next);
    // The pooled pages belong to the old origin: drop them (cache + source
    // are handled by the core above).
    if (effective(previous.openhands.baseUrl) !== effective(next.openhands.baseUrl)) {
      resetOpenHandsViews();
    }
    const was = previous.openhands;
    const now = next.openhands;
    if (was.maxLiveViews !== now.maxLiveViews || was.keepAliveHours !== now.keepAliveHours) {
      openhandsViews().applyLimits();
    }
  },
  onCredentialsChanged() {
    void (async () => {
      const key = (await state.secrets?.getOpenHandsApiKey()) ?? null;
      await core.onCredentialsChanged(key !== null);
    })();
  },
  onSurfaceEnter() {
    core.onSurfaceEnter();
    watchViewNavigation();
    // The pool opens no view until the user is here (no request before that).
    if (!openhandsViews().activeView()) openhandsShowHome();
  },
  // Ctrl+N / the sidebar '+': the OpenHands home page (its composer).
  showHome: () => openhandsShowHome({ reload: true, focus: true }),
  openNotification(entry) {
    if (entry.source !== 'openhands' || !entry.sessionId) return false;
    openConversationPr(entry.sessionId, entry.prUrl ?? undefined);
    activateWindow('notification-open');
    return true;
  },
  openPullRequests() {
    return prTracker?.openPullRequests() ?? [];
  },
  // No gate (never used here, nothing cached): there are no OpenHands PRs to
  // protect. An open gate counts only once the current tracker has listed.
  prsKnown() {
    const gate = core.gate();
    return gate === 'closed' || (gate === 'open' && (prTracker?.listed() ?? false));
  },
  openSessionPr(sessionId, prUrl) {
    log('shell', 'pr-open', { url: prUrl, detail: { sessionId } });
    openConversationPr(sessionId, prUrl);
    activateWindow('session-pr');
  },
  async newSession() {
    menu.record('new-session');
    openhandsRuntime.showHome?.();
    notifyShell();
  },
};

// Notification / PR panel: the conversation on the OpenHands surface, and the
// PR (if any) as a tab in its `openhands:<id>` scope.
function openConversationPr(id: string, prUrl?: string): void {
  // A malformed id cannot open a conversation: land on home instead.
  if (!openhandsOpenSession(id)) {
    openhandsShowHome();
  } else if (prUrl) {
    state.tabManager?.open(prUrl, { originSessionId: providerScope('openhands', id) });
    applyLayout();
  }
  notifyShell();
}

// Sidebar actions (src/main/ipc.ts) and test hooks.
export function openhandsContextMenu(arg: OpenHandsContextMenuRequest) {
  return menu.show(arg);
}
export const openhandsMenuItems = () => menu.menuItems();
export const openhandsMenuClick = (id: string) => menu.clickItem(id);
export const openhandsMutations = () => menu.mutationLog();

const validId = (id: string): boolean =>
  isConversationId(effective(state.settings?.current.openhands.baseUrl), id);

export async function openhandsRename(id: string, title: string): Promise<void> {
  if (!validId(id)) return;
  menu.record('rename', { id });
  await core.mutate({ op: 'rename', id, title });
}
export async function openhandsDelete(id: string): Promise<void> {
  if (!validId(id)) return;
  // Only a server-accepted delete touches the pool; a failure changes nothing.
  if (await core.mutate({ op: 'delete', id })) {
    openhandsForgetSession(id);
    // The conversation is gone: so are its GitHub tabs.
    try {
      await state.tabManager?.closeScope(providerScope('openhands', id));
    } finally {
      applyLayout();
    }
  }
}
// Sidebar refresh button.
export function openhandsUiRefresh(): Promise<void> {
  menu.record('refresh');
  return core.forceRefresh();
}

// Test hooks (src/main/testHooks.ts). Refresh opens the gate.
export const openhandsState = snapshot;
export function openhandsRefresh(): Promise<void> {
  return core.forceRefresh();
}

// Analytics -> OpenHands tab (src/main/ipc.ts). Showing it is an explicit
// OpenHands action: it opens the gate (never the hosted pool — that is the
// surface's job) and switches the usage cadence to 60 s.
export function openhandsUsageVisible(visible: boolean): void {
  usageVisible = visible;
  if (visible) core.onSurfaceEnter();
  core.usage()?.visibilityChanged();
}
// The tab's Refresh button and the `openhandsUsageRefresh` test hook (opens the gate).
export async function openhandsUsageRefresh(): Promise<void> {
  core.onSurfaceEnter();
  await core.usage()?.refresh();
}
