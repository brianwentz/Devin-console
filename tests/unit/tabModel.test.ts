import { describe, expect, it } from 'vitest';
import {
  GLOBAL,
  claudeScope,
  effectiveScope,
  localScope,
  activateTab,
  activeIdFor,
  addTab,
  closeScope,
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
  type TabState,
} from '../../src/core/tabModel';

const tab = (id: string, originSessionId?: string): BrowserTab => ({
  id,
  url: `https://github.com/org/${id}`,
  title: id,
  ...(originSessionId ? { originSessionId } : {}),
});

function build(...urls: string[]): TabState {
  let state = emptyTabState();
  urls.forEach((url, index) => {
    state = openTab(state, url, { id: `t${index + 1}` }).state;
  });
  return state;
}

// Tabs A/B/C in scope 'sess-a', D/E in 'sess-b', interleaved in the flat array.
function interleaved(): TabState {
  let state = emptyTabState();
  state = openTab(state, 'https://github.com/org/a', { id: 'A', scope: 'sess-a' }).state;
  state = openTab(state, 'https://github.com/org/b', { id: 'B', scope: 'sess-a' }).state;
  state = openTab(state, 'https://github.com/org/c', { id: 'D', scope: 'sess-b' }).state;
  state = openTab(state, 'https://github.com/org/d', { id: 'C', scope: 'sess-a' }).state;
  state = openTab(state, 'https://github.com/org/e', { id: 'E', scope: 'sess-b' }).state;
  return state;
}

describe('pullRequestKey', () => {
  it.each([
    ['https://github.com/org/repo/pull/42', 'github.com/org/repo/pull/42'],
    ['https://github.com/org/repo/pull/42/files', 'github.com/org/repo/pull/42'],
    ['https://github.com/org/repo/pull/42/commits/abc', 'github.com/org/repo/pull/42'],
    ['https://github.com/org/repo/pull/42?diff=split#issuecomment-1', 'github.com/org/repo/pull/42'],
    ['https://GitHub.com/Org/Repo/pull/42/', 'github.com/org/repo/pull/42'],
  ])('%s -> %s', (url, key) => {
    expect(pullRequestKey(url)).toBe(key);
  });

  it.each([
    'https://github.com/org/repo/pulls',
    'https://github.com/org/repo/pull/',
    'https://github.com/org/repo/pull/abc',
    'https://github.com/org/repo/issues/42',
    'https://github.com/org/repo',
    'https://github.com/org/repo/blob/main/pull/42',
    'not a url',
  ])('%s has no PR key', (url) => {
    expect(pullRequestKey(url)).toBeNull();
  });
});

describe('scope', () => {
  it('derives scope from originSessionId; GLOBAL otherwise', () => {
    expect(scopeOf(tab('a', 'sess-1'))).toBe('sess-1');
    expect(scopeOf(tab('a'))).toBe(GLOBAL);
  });

  it('visibleTabs filters by scope, preserving strip order', () => {
    const state = interleaved();
    expect(visibleTabs(state, 'sess-a').map((t) => t.id)).toEqual(['A', 'B', 'C']);
    expect(visibleTabs(state, 'sess-b').map((t) => t.id)).toEqual(['D', 'E']);
    expect(visibleTabs(state, GLOBAL)).toEqual([]);
  });

  it('activeIdFor tracks per-scope active and falls back to first visible', () => {
    const state = interleaved();
    expect(activeIdFor(state, 'sess-a')).toBe('C');
    expect(activeIdFor(state, 'sess-b')).toBe('E');
    expect(activeIdFor(state, GLOBAL)).toBeNull();
    const stale: TabState = { ...state, activeByScope: { 'sess-a': 'gone' } };
    expect(activeIdFor(stale, 'sess-a')).toBe('A');
  });

  it('setScopeSeen records the last-visible timestamp', () => {
    const state = setScopeSeen(emptyTabState(), 'sess-a', 1234);
    expect(state.lastSeenByScope['sess-a']).toBe(1234);
    expect(setScopeSeen(state, 'sess-a', 1234)).toBe(state);
  });
});

describe('openTab (scoped)', () => {
  it('creates a new focused tab with hostname title and scope tag', () => {
    const result = openTab(emptyTabState(), 'https://github.com/org/repo', {
      id: 'a',
      scope: 'sess-1',
    });
    expect(result).toMatchObject({ id: 'a', created: true, navigate: false });
    expect(activeIdFor(result.state, 'sess-1')).toBe('a');
    expect(result.state.tabs[0]).toEqual({
      id: 'a',
      url: 'https://github.com/org/repo',
      title: 'github.com',
      loading: true,
      originSessionId: 'sess-1',
    });
  });

  it('background opens keep the active tab', () => {
    const state = build('https://github.com/org/a');
    const result = openTab(state, 'https://github.com/org/b', { id: 'b', background: true });
    expect(result.created).toBe(true);
    expect(activeIdFor(result.state, GLOBAL)).toBe('t1');
    expect(result.state.tabs.map((item) => item.id)).toEqual(['t1', 'b']);
  });

  it('background open into an empty scope still activates the new tab', () => {
    const result = openTab(emptyTabState(), 'https://github.com/org/a', {
      id: 'a',
      background: true,
      scope: 's',
    });
    expect(activeIdFor(result.state, 's')).toBe('a');
  });

  it('dedupe is per-scope: same PR in two sessions yields two tabs', () => {
    let state = openTab(emptyTabState(), 'https://github.com/org/repo/pull/7', {
      id: 'a',
      scope: 'sess-a',
    }).state;
    const result = openTab(state, 'https://github.com/org/repo/pull/7/files', {
      id: 'b',
      scope: 'sess-b',
    });
    expect(result).toMatchObject({ id: 'b', created: true });
    state = result.state;
    // Same PR again inside sess-a dedupes to tab 'a'.
    const again = openTab(state, 'https://github.com/org/repo/pull/7/commits', {
      id: 'c',
      scope: 'sess-a',
    });
    expect(again).toMatchObject({ id: 'a', created: false, navigate: true });
    expect(visibleTabs(again.state, 'sess-a')).toHaveLength(1);
    expect(visibleTabs(again.state, 'sess-b')).toHaveLength(1);
  });

  it('dedupes PR sub-paths: focuses the existing tab and navigates it', () => {
    const state = build(
      'https://github.com/org/x',
      'https://github.com/org/repo/pull/7',
      'https://github.com/org/y',
    );
    const result = openTab(state, 'https://github.com/org/repo/pull/7/files?w=1#diff-abc', {
      id: 'new',
    });
    expect(result).toMatchObject({ id: 't2', created: false, navigate: true });
    expect(result.state.tabs).toHaveLength(3);
    expect(activeIdFor(result.state, GLOBAL)).toBe('t2');
    expect(result.state.tabs[1]?.url).toBe('https://github.com/org/repo/pull/7/files?w=1#diff-abc');
  });

  it('exact-URL match focuses within scope only', () => {
    let state = openTab(emptyTabState(), 'https://github.com/org/issues/1', {
      id: 'a',
      scope: 's1',
    }).state;
    const other = openTab(state, 'https://github.com/org/issues/1', { id: 'b', scope: 's2' });
    expect(other.created).toBe(true); // not deduped across scopes
    state = other.state;
    const again = openTab(state, 'https://github.com/org/issues/1', { id: 'n', scope: 's1' });
    expect(again).toMatchObject({ id: 'a', created: false, navigate: false });
    expect(activeIdFor(again.state, 's1')).toBe('a');
  });
});

describe('closeTab (scoped)', () => {
  it('picks the neighbour within the tab\'s own scope', () => {
    // flat order: A B D C E; closing B in sess-a should activate C (the next tab
    // within scope order A B C), not D — the other scope's tab between them.
    let state = interleaved();
    state = closeTab(state, 'B');
    expect(activeIdFor(state, 'sess-a')).toBe('C');
    state = closeTab(state, 'C');
    expect(activeIdFor(state, 'sess-a')).toBe('A');
    expect(visibleTabs(state, 'sess-a').map((t) => t.id)).toEqual(['A']);
  });

  it('closing an inactive tab in a hidden scope keeps the active ids', () => {
    let state = interleaved();
    state = closeTab(state, 'A');
    expect(activeIdFor(state, 'sess-a')).toBe('C');
    expect(activeIdFor(state, 'sess-b')).toBe('E');
  });

  it('closing the last tab of a scope drops its bookkeeping', () => {
    let state = interleaved();
    state = closeTab(state, 'D');
    state = closeTab(state, 'E');
    expect(state.activeByScope['sess-b']).toBeUndefined();
    expect(visibleTabs(state, 'sess-b')).toEqual([]);
  });

  it('closeScope removes every tab and bookkeeping of a scope', () => {
    let state = interleaved();
    state = setScopeSeen(state, 'sess-b', 42);
    state = closeScope(state, 'sess-b');
    expect(visibleTabs(state, 'sess-b')).toEqual([]);
    expect(state.activeByScope['sess-b']).toBeUndefined();
    expect(state.lastSeenByScope['sess-b']).toBeUndefined();
    expect(visibleTabs(state, 'sess-a')).toHaveLength(3);
    expect(closeScope(state, 'sess-b')).toBe(state);
  });
});

describe('reorderTab (scope-relative)', () => {
  it('maps the scope index onto interleaved positions', () => {
    // flat: A B D C E — sess-a scope: A B C. Move C (scope idx 2) to idx 0.
    let state = interleaved();
    state = reorderTab(state, 'C', 0);
    // C should land at the first sess-a position; other scopes keep their slots.
    expect(state.tabs.map((t) => t.id)).toEqual(['C', 'A', 'D', 'B', 'E']);
    expect(visibleTabs(state, 'sess-a').map((t) => t.id)).toEqual(['C', 'A', 'B']);
    expect(visibleTabs(state, 'sess-b').map((t) => t.id)).toEqual(['D', 'E']);
    expect(activeIdFor(state, 'sess-b')).toBe('E');
  });

  it('clamps to scope bounds and ignores foreign ids', () => {
    const state = interleaved();
    expect(reorderTab(state, 'missing', 0)).toBe(state);
    expect(reorderTab(state, 'C', 99).tabs.map((t) => t.id)).toEqual(['A', 'B', 'D', 'C', 'E']);
    expect(reorderTab(state, 'C', -5).tabs.map((t) => t.id)).toEqual(['C', 'A', 'D', 'B', 'E']);
    const single = addTab(emptyTabState(), tab('only'));
    expect(reorderTab(single, 'only', 3)).toBe(single);
  });
});

describe('tabModel misc', () => {
  it('activating an unknown id is a no-op', () => {
    const state = addTab(emptyTabState(), tab('a'));
    expect(activateTab(state, 'zzz')).toBe(state);
  });

  it('updates a tab in place', () => {
    const state = addTab(emptyTabState(), tab('a'));
    const next = updateTab(state, 'a', { title: 'New', loading: false });
    expect(next.tabs[0]).toMatchObject({ id: 'a', title: 'New', loading: false });
    expect(updateTab(state, 'missing', { title: 'x' })).toBe(state);
  });
});

describe('serialize/restore', () => {
  it('round-trips a v2 snapshot', () => {
    let state = emptyTabState();
    state = openTab(state, 'https://github.com/org/a', { id: 'A', scope: 'sess-a' }).state;
    state = openTab(state, 'https://github.com/org/b', { id: 'B' }).state;
    state = setScopeSeen(state, 'sess-a', 999);
    const snapshot = serializeTabs(state);
    expect(snapshot.version).toBe(2);
    const restored = restoreTabs(snapshot);
    expect(restored.tabs.map((t) => t.id)).toEqual(['A', 'B']);
    expect(activeIdFor(restored, 'sess-a')).toBe('A');
    expect(activeIdFor(restored, GLOBAL)).toBe('B');
    expect(restored.lastSeenByScope['sess-a']).toBe(999);
  });

  it('migrates a v1 snapshot: activeId lands in its tab\'s scope', () => {
    const v1 = {
      tabs: [tab('A', 'sess-a'), tab('B', 'sess-a'), tab('C')],
      activeId: 'B',
    };
    const restored = restoreTabs(v1, 500);
    expect(activeIdFor(restored, 'sess-a')).toBe('B');
    expect(activeIdFor(restored, GLOBAL)).toBe('C'); // fallback: first visible
    expect(restored.lastSeenByScope['sess-a']).toBe(500);
    expect(restored.lastSeenByScope[GLOBAL]).toBe(500);
  });

  it('drops malformed snapshots', () => {
    expect(restoreTabs(null)).toEqual(emptyTabState());
    expect(restoreTabs({ tabs: 'nope' })).toEqual(emptyTabState());
    expect(restoreTabs({ tabs: [{ id: 1, url: 'x', title: 'x' }] })).toEqual(emptyTabState());
    expect(restoreTabs({ version: 2, tabs: [] })).toEqual(emptyTabState());
  });
});

describe('pruneScopes', () => {
  it('drops scopes unseen past maxAge and keeps fresh ones', () => {
    let state = interleaved();
    state = setScopeSeen(state, 'sess-a', 0);
    state = setScopeSeen(state, 'sess-b', 1800);
    const pruned = pruneScopes(state, 2000, 500);
    expect(visibleTabs(pruned, 'sess-a')).toEqual([]);
    expect(visibleTabs(pruned, 'sess-b').map((t) => t.id)).toEqual(['D', 'E']);
    expect(pruned.activeByScope['sess-a']).toBeUndefined();
    expect(pruned.lastSeenByScope['sess-a']).toBeUndefined();
  });

  it('keeps scopes with no lastSeen stamp', () => {
    const state = interleaved(); // no lastSeen entries
    expect(pruneScopes(state, 10 ** 15, 1)).toEqual(state);
  });
});

describe('pickDiscardCandidates', () => {
  const entry = (
    id: string,
    lastActiveAt: number,
    extra: Partial<{ live: boolean; protected: boolean; inVisibleScope: boolean }> = {},
  ) => ({ id, lastActiveAt, live: true, protected: false, inVisibleScope: false, ...extra });

  it('returns LRU-ordered ids until under the cap', () => {
    const entries = [
      entry('newest', 300),
      entry('oldest', 100),
      entry('middle', 200),
      entry('active', 50, { inVisibleScope: true }),
    ];
    expect(pickDiscardCandidates(entries, 2)).toEqual(['oldest']);
    expect(pickDiscardCandidates(entries, 1)).toEqual(['oldest', 'middle']);
    expect(pickDiscardCandidates(entries, 4)).toEqual([]);
  });

  it('skips protected and dead tabs, exempts the visible active tab', () => {
    const entries = [
      entry('guarded', 100, { protected: true }),
      entry('dead', 50, { live: false }),
      entry('open', 150),
      entry('other', 120),
    ];
    // 3 live non-active (guarded, open, other) over cap=1 -> skip protected 'guarded'.
    expect(pickDiscardCandidates(entries, 1)).toEqual(['other', 'open']);
  });

  it('exempts every visible-scope tab from both the count and the candidates', () => {
    const entries = [
      entry('vis1', 100, { inVisibleScope: true }),
      entry('vis2', 90, { inVisibleScope: true }),
      entry('vis3', 80, { inVisibleScope: true }),
      entry('vis4', 70, { inVisibleScope: true }),
      entry('vis5', 60, { inVisibleScope: true }),
      entry('hid-oldest', 10),
      entry('hid-mid', 20),
      entry('hid-new', 30),
    ];
    // 5 visible + 3 hidden live, cap 2 → only the oldest hidden goes.
    expect(pickDiscardCandidates(entries, 2)).toEqual(['hid-oldest']);
    expect(pickDiscardCandidates(entries, 3)).toEqual([]);
  });

  it('localScope namespaces local sessions under local:', () => {
    expect(localScope('abc')).toBe('local:abc');
    expect(localScope('x')).not.toBe(GLOBAL);
  });

  it('effectiveScope picks the local session on the local surface, cloud otherwise', () => {
    expect(effectiveScope('local', 'cloud-1', 'local-1', null)).toBe('local:local-1');
    expect(effectiveScope('local', 'cloud-1', null, null)).toBe('cloud-1');
    expect(effectiveScope('local', null, null, null)).toBe(GLOBAL);
    expect(effectiveScope('cloud', 'cloud-1', 'local-1', null)).toBe('cloud-1');
    expect(effectiveScope('settings', 'cloud-1', 'local-1', null)).toBe('cloud-1');
    expect(effectiveScope('cloud', null, 'local-1', null)).toBe(GLOBAL);
  });

  it('effectiveScope picks the claude session on the claude surface, cloud otherwise', () => {
    expect(claudeScope('abc')).toBe('claude:abc');
    expect(effectiveScope('claude', 'cloud-1', 'local-1', 'claude-1')).toBe('claude:claude-1');
    expect(effectiveScope('claude', 'cloud-1', 'local-1', null)).toBe('cloud-1');
    expect(effectiveScope('claude', null, null, null)).toBe(GLOBAL);
    expect(effectiveScope('settings', null, null, 'claude-1')).toBe(GLOBAL);
    expect(effectiveScope('local', null, null, 'claude-1')).toBe(GLOBAL);
  });
});
