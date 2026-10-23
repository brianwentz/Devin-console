import type { Surface } from '../shared/ipc';
import { providerBySurface, type ProviderDescriptor } from './providers';

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string | undefined;
  loading?: boolean | undefined;
  canGoBack?: boolean;
  canGoForward?: boolean;
  originSessionId?: string | undefined;
  // webContents discarded while idle (O6); reloads on activation.
  discarded?: boolean | undefined;
}

// P8: the GitHub strip is session-scoped. Scope key = the Devin session the tab
// was opened from; GLOBAL collects tabs opened outside any session.
export const GLOBAL = '';

// Local (Devin CLI) sessions get their own GitHub tab scope, namespaced so a
// local session id can never collide with a Cloud session id.
export function localScope(sessionId: string): string {
  return providerScope('local', sessionId);
}

// Claude Code sessions get their own GitHub tab scope, namespaced like the
// local one so ids can never collide across sources.
export function claudeScope(sessionId: string): string {
  return providerScope('claude', sessionId);
}

// Scope key of a provider session: the descriptor's scopePrefix + the id.
export function providerScope(surface: Surface, sessionId: string): string {
  return `${providerBySurface(surface)?.scopePrefix ?? ''}${sessionId}`;
}

type ScopeDescriptor = Pick<ProviderDescriptor, 'scopePrefix' | 'scopeFallback'>;

// The scope the tab strip currently serves: the selected session of the
// current surface (prefixed per provider), else the surface's fallback - the
// Cloud session (GLOBAL outside any session) unless the provider says 'global'.
// `sessions` is keyed by surface id; `lookup` is injectable for tests.
export function effectiveScope(
  surface: Surface,
  sessions: Partial<Record<string, string | null>>,
  lookup: (surface: string) => ScopeDescriptor | undefined = providerBySurface,
): string {
  const descriptor = lookup(surface);
  const id = descriptor ? sessions[surface] : null;
  if (descriptor && id) return `${descriptor.scopePrefix}${id}`;
  if (descriptor?.scopeFallback === 'global') return GLOBAL;
  return sessions.cloud ?? GLOBAL;
}

export function scopeOf(tab: Pick<BrowserTab, 'originSessionId'>): string {
  return tab.originSessionId ?? GLOBAL;
}

export interface TabState {
  tabs: BrowserTab[]; // all scopes; strip order within a scope = array order
  activeByScope: Record<string, string>; // scope -> active tab id
  lastSeenByScope: Record<string, number>; // scope -> ms epoch it was last visible
}

export interface PersistedTabs {
  version: 2;
  tabs: Array<Pick<BrowserTab, 'id' | 'url' | 'title' | 'originSessionId'>>;
  activeByScope: Record<string, string>;
  lastSeenByScope: Record<string, number>;
}

// v1 snapshots: { tabs, activeId }
interface PersistedTabsV1 {
  tabs: Array<Pick<BrowserTab, 'id' | 'url' | 'title' | 'originSessionId'>>;
  activeId: string | null;
}

export interface OpenOptions {
  background?: boolean;
  scope?: string;
  // Id for a newly created tab; callers (TabManager) supply a UUID, tests pass fixed ids.
  id: string;
}

export interface OpenResult {
  state: TabState;
  id: string;
  created: boolean;
  navigate: boolean;
}

export const emptyTabState = (): TabState => ({
  tabs: [],
  activeByScope: {},
  lastSeenByScope: {},
});

// `owner/repo/pull/N` identity of a GitHub PR URL, ignoring sub-paths (/files,
// /commits, ...), query and hash. Null for anything else.
export function pullRequestKey(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  const host = url.host.toLowerCase().replace(/\.$/, '');
  return `${host}/${match[1]}/${match[2]}/pull/${match[3]}`.toLowerCase();
}

export function visibleTabs(state: TabState, scope: string): BrowserTab[] {
  return state.tabs.filter((tab) => scopeOf(tab) === scope);
}

export function activeIdFor(state: TabState, scope: string): string | null {
  const id = state.activeByScope[scope];
  if (id && visibleTabs(state, scope).some((tab) => tab.id === id)) return id;
  return visibleTabs(state, scope)[0]?.id ?? null;
}

export function setScopeSeen(state: TabState, scope: string, now: number): TabState {
  if (state.lastSeenByScope[scope] === now) return state;
  return { ...state, lastSeenByScope: { ...state.lastSeenByScope, [scope]: now } };
}

// Drop whole scopes not seen for maxAgeMs (persist hygiene, e.g. 30 days).
// Scopes with no recorded lastSeen are kept — we can't prove them stale.
export function pruneScopes(state: TabState, now: number, maxAgeMs: number): TabState {
  const stale = new Set(
    Object.entries(state.lastSeenByScope)
      .filter(([, seen]) => now - seen > maxAgeMs)
      .map(([scope]) => scope),
  );
  if (stale.size === 0) return state;
  const tabs = state.tabs.filter((tab) => !stale.has(scopeOf(tab)));
  const activeByScope = Object.fromEntries(
    Object.entries(state.activeByScope).filter(([scope]) => !stale.has(scope)),
  );
  const lastSeenByScope = Object.fromEntries(
    Object.entries(state.lastSeenByScope).filter(([scope]) => !stale.has(scope)),
  );
  return { tabs, activeByScope, lastSeenByScope };
}

export function openTab(state: TabState, url: string, options: OpenOptions): OpenResult {
  const scope = options.scope ?? GLOBAL;
  const background = options.background ?? false;
  const inScope = (tab: BrowserTab) => scopeOf(tab) === scope;
  const activate = (s: TabState, id: string): TabState =>
    background ? s : { ...s, activeByScope: { ...s.activeByScope, [scope]: id } };

  // Dedupe is per-scope: the same PR open from two sessions keeps two tabs.
  const key = pullRequestKey(url);
  const byPullRequest = key
    ? state.tabs.find((tab) => inScope(tab) && pullRequestKey(tab.url) === key)
    : undefined;
  if (byPullRequest) {
    const tabs = state.tabs.map((tab) =>
      tab === byPullRequest ? { ...tab, url, loading: tab.url !== url || tab.loading } : tab,
    );
    return {
      state: activate({ ...state, tabs }, byPullRequest.id),
      id: byPullRequest.id,
      created: false,
      navigate: byPullRequest.url !== url,
    };
  }

  const exact = state.tabs.find((tab) => inScope(tab) && tab.url === url);
  if (exact) {
    return { state: activate(state, exact.id), id: exact.id, created: false, navigate: false };
  }

  const tab: BrowserTab = {
    id: options.id,
    url,
    title: safeHostname(url),
    loading: true,
    ...(scope !== GLOBAL ? { originSessionId: scope } : {}),
  };
  const tabs = [...state.tabs, tab];
  const next = { ...state, tabs };
  const withActive =
    background && activeIdFor(next, scope)
      ? next
      : { ...next, activeByScope: { ...next.activeByScope, [scope]: tab.id } };
  return { state: withActive, id: tab.id, created: true, navigate: false };
}

export function addTab(state: TabState, tab: BrowserTab): TabState {
  const scope = scopeOf(tab);
  const existing = state.tabs.findIndex((candidate) => candidate.id === tab.id);
  const tabs = [...state.tabs];
  if (existing >= 0) tabs.splice(existing, 1);
  tabs.push(tab);
  return { ...state, tabs, activeByScope: { ...state.activeByScope, [scope]: tab.id } };
}

export function activateTab(state: TabState, id: string): TabState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab) return state;
  return { ...state, activeByScope: { ...state.activeByScope, [scopeOf(tab)]: id } };
}

export function updateTab(
  state: TabState,
  id: string,
  patch: Partial<Omit<BrowserTab, 'id'>>,
): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = [...state.tabs];
  tabs[index] = { ...tabs[index]!, ...patch };
  return { ...state, tabs };
}

// Neighbour selection is within the closed tab's own scope.
export function closeTab(state: TabState, id: string): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const scope = scopeOf(state.tabs[index]!);
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const scopeTabs = tabs.filter((tab) => scopeOf(tab) === scope);
  const next: TabState = { ...state, tabs };
  if (state.activeByScope[scope] === id) {
    // Position within the scope's visible list: the closed tab's index among scope tabs.
    const scopeIndex = visibleTabs(state, scope).findIndex((tab) => tab.id === id);
    const replacement = scopeTabs[Math.min(scopeIndex, scopeTabs.length - 1)]?.id;
    next.activeByScope = { ...state.activeByScope };
    if (replacement) next.activeByScope[scope] = replacement;
    else delete next.activeByScope[scope];
  }
  return next;
}

// Remove every tab of a scope and drop its bookkeeping.
export function closeScope(state: TabState, scope: string): TabState {
  const tabs = state.tabs.filter((tab) => scopeOf(tab) !== scope);
  if (tabs.length === state.tabs.length) return state;
  const activeByScope = { ...state.activeByScope };
  delete activeByScope[scope];
  const lastSeenByScope = { ...state.lastSeenByScope };
  delete lastSeenByScope[scope];
  return { tabs, activeByScope, lastSeenByScope };
}

// `toIndex` is relative to the tab's scope (what the visible strip shows).
export function reorderTab(state: TabState, id: string, toIndex: number): TabState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab) return state;
  const scope = scopeOf(tab);
  const scopeIds = visibleTabs(state, scope).map((item) => item.id);
  const fromScopeIndex = scopeIds.indexOf(id);
  if (fromScopeIndex < 0 || scopeIds.length < 2) return state;
  const targetScopeIndex = Math.max(
    0,
    Math.min(scopeIds.length - 1, Math.floor(toIndex)),
  );
  const newScopeIds = scopeIds.filter((item) => item !== id);
  newScopeIds.splice(targetScopeIndex, 0, id);
  // Rebuild the flat array, preserving the positions non-scope tabs occupy.
  const byId = new Map(scopeIds.map((item, i) => [item, newScopeIds[i]!] as const));
  const tabs = state.tabs.map((item) =>
    scopeOf(item) === scope ? state.tabs.find((t) => t.id === byId.get(item.id))! : item,
  );
  return { ...state, tabs };
}

export function serializeTabs(state: TabState): PersistedTabs {
  return {
    version: 2,
    tabs: state.tabs.map(({ id, url, title, originSessionId }) => ({
      id,
      url,
      title,
      ...(originSessionId ? { originSessionId } : {}),
    })),
    activeByScope: { ...state.activeByScope },
    lastSeenByScope: { ...state.lastSeenByScope },
  };
}

// Accepts v1 ({tabs, activeId}) and v2 ({version:2, tabs, activeByScope, lastSeenByScope}).
export function restoreTabs(value: unknown, now = Date.now()): TabState {
  if (!value || typeof value !== 'object') return emptyTabState();
  const snapshot = value as Partial<PersistedTabs & PersistedTabsV1>;
  if (!Array.isArray(snapshot.tabs)) return emptyTabState();
  const tabs = snapshot.tabs
    .filter(
      (tab): tab is PersistedTabs['tabs'][number] =>
        Boolean(tab) &&
        typeof tab.id === 'string' &&
        typeof tab.url === 'string' &&
        typeof tab.title === 'string',
    )
    .map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      ...(typeof tab.originSessionId === 'string' ? { originSessionId: tab.originSessionId } : {}),
    }));
  if (tabs.length === 0) return emptyTabState();

  const lastSeenByScope: Record<string, number> = {};
  const activeByScope: Record<string, string> = {};
  if (snapshot.version === 2) {
    for (const [scope, seen] of Object.entries(snapshot.lastSeenByScope ?? {})) {
      if (typeof seen === 'number' && Number.isFinite(seen)) lastSeenByScope[scope] = seen;
    }
    for (const [scope, id] of Object.entries(snapshot.activeByScope ?? {})) {
      if (typeof id === 'string' && tabs.some((tab) => tab.id === id)) activeByScope[scope] = id;
    }
  } else if (typeof snapshot.activeId === 'string') {
    const active = tabs.find((tab) => tab.id === snapshot.activeId);
    if (active) activeByScope[scopeOf(active)] = active.id;
  }
  // Scopes that lack a lastSeen stamp get "now" so they aren't instantly pruned.
  for (const tab of tabs) {
    const scope = scopeOf(tab);
    if (lastSeenByScope[scope] === undefined) lastSeenByScope[scope] = now;
  }
  return { tabs, activeByScope, lastSeenByScope };
}

export interface DiscardCandidateEntry {
  id: string;
  lastActiveAt: number;
  live: boolean;
  // beforeunload-protected (a cancelled discard / unsaved draft) — always skipped.
  protected: boolean;
  // Belongs to the visible scope — those tabs are all preloaded/live by design
  // and never count toward, nor get picked by, the cap.
  inVisibleScope: boolean;
}

// LRU: which live, hidden-scope, unprotected tabs to discard so that live
// hidden tabs stay under `cap`. Returns ids, oldest first.
export function pickDiscardCandidates(
  entries: DiscardCandidateEntry[],
  cap: number,
): string[] {
  const live = entries.filter((entry) => entry.live && !entry.inVisibleScope);
  const excess = live.length - cap;
  if (excess <= 0) return [];
  return live
    .filter((entry) => !entry.protected)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    .slice(0, excess)
    .map((entry) => entry.id);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
