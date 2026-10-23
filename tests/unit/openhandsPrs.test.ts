import { describe, expect, it, vi } from 'vitest';
import type { OhRow } from '../../src/core/openhands';
import type { OpenHandsFetch, OpenHandsFetchResult } from '../../src/main/openhands/fetch';
import { createOpenHandsPrTracker, EVENTS_SCAN_LIMIT, PRS_PER_CONVERSATION } from '../../src/main/openhands/prs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const pr = (n: number, repo = 'o/r') => `https://github.com/${repo}/pull/${n}`;
const row = (id: string, prUrls: string[] = [], extra: Partial<OhRow> = {}): OhRow => ({
  id,
  title: `Secret ${id.slice(0, 1)}`,
  updatedAt: 1,
  status: 'running',
  section: 'o/r',
  repo: 'o/r',
  gitProvider: 'github',
  prUrls,
  cost: null,
  ...extra,
});
const ok = (body: unknown): OpenHandsFetchResult => ({ status: 200, body, mode: 'api-key' });

function make(opts: { fetch?: OpenHandsFetch; stateOf?: (url: string) => string | null } = {}) {
  const autoOpen = vi.fn();
  const onChange = vi.fn();
  const log = vi.fn();
  const fetch: OpenHandsFetch = opts.fetch ?? vi.fn(async () => ok({ items: [] }));
  const tracker = createOpenHandsPrTracker({ fetch, autoOpen, onChange, log, ...(opts.stateOf ? { stateOf: opts.stateOf } : {}) });
  return { tracker, autoOpen, onChange, log, fetch };
}

describe('openhands PR tracker: rows', () => {
  it('the first rows are a baseline: listed, never auto-opened', () => {
    const { tracker, autoOpen, onChange } = make();
    tracker.onRows([row(A, [pr(7)])]);
    expect(autoOpen).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(tracker.openPullRequests()).toEqual([
      { sessionId: A, sessionTitle: 'Secret a', ref: 'o/r#7', url: pr(7), state: null, source: 'openhands' },
    ]);
  });

  it('a URL first seen after the baseline auto-opens exactly once', () => {
    const { tracker, autoOpen, onChange } = make();
    tracker.onRows([row(A)]);
    tracker.onRows([row(A, [pr(8)]), row(B, [pr(1, 'x/y')])]);
    expect(autoOpen.mock.calls).toEqual([
      [pr(8), A],
      [pr(1, 'x/y'), B],
    ]);
    onChange.mockClear();
    tracker.onRows([row(A, [pr(8)]), row(B, [pr(1, 'x/y')])]);
    expect(autoOpen).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops conversations that left the list', () => {
    const { tracker, onChange } = make();
    tracker.onRows([row(A, [pr(7)]), row(B, [pr(9)])]);
    onChange.mockClear();
    tracker.onRows([row(A, [pr(7)])]);
    expect(tracker.openPullRequests().map((p) => p.url)).toEqual([pr(7)]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it(`keeps at most ${PRS_PER_CONVERSATION} PRs per conversation, newest kept`, () => {
    const { tracker } = make();
    tracker.onRows([row(A, Array.from({ length: 25 }, (_, i) => pr(i + 1)))]);
    const urls = tracker.openPullRequests().map((p) => p.url);
    expect(urls).toHaveLength(PRS_PER_CONVERSATION);
    expect(urls).toContain(pr(25));
    expect(urls).not.toContain(pr(5));
    expect(urls).toContain(pr(6));
  });

  it('a capped-out URL is not re-added or re-announced on later polls', async () => {
    const many = Array.from({ length: 25 }, (_, i) => pr(i + 1));
    const fetch = vi.fn<OpenHandsFetch>(async () => ok({ items: [{ t: pr(99) }] }));
    const { tracker, autoOpen, onChange } = make({ fetch });
    tracker.onRows([row(A, many)]);
    onChange.mockClear();
    tracker.onRows([row(A, many)]);
    expect(autoOpen).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    // An event PR evicts the oldest row PR; the next poll does not bring it back.
    await tracker.onFinished(A);
    expect(autoOpen.mock.calls).toEqual([[pr(99), A]]);
    onChange.mockClear();
    tracker.onRows([row(A, many)]);
    expect(autoOpen).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(tracker.openPullRequests()).toHaveLength(PRS_PER_CONVERSATION);
  });

  it('a baseline with PRs stays quiet when the same rows come again', () => {
    const { tracker, autoOpen, onChange } = make();
    tracker.onRows([row(A, [pr(7)])]);
    onChange.mockClear();
    tracker.onRows([row(A, [pr(7)])]);
    expect(autoOpen).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('excludes merged/closed PRs and orders by conversation recency, newest PR first', () => {
    const states: Record<string, string> = { [pr(2)]: 'merged', [pr(3)]: 'open' };
    const { tracker } = make({ stateOf: (u) => states[u] ?? null });
    tracker.onRows([row(A, [pr(1), pr(2), pr(3)], { updatedAt: 1 }), row(B, [pr(9)], { updatedAt: 5, title: '' })]);
    const out = tracker.openPullRequests();
    expect(out.map((p) => p.url)).toEqual([pr(9), pr(3), pr(1)]);
    expect(out[0]!.sessionTitle).toBe('Untitled conversation');
    expect(out[1]!.state).toBe('open');
  });
});

describe('openhands PR tracker: events scan', () => {
  it('fetches the event search once and auto-opens PR URLs found in event JSON', async () => {
    const fetch = vi.fn<OpenHandsFetch>(async () =>
      ok({ items: [{ kind: 'MessageEvent', text: `Opened ${pr(9)} for you` }, { observation: 'x' }] }),
    );
    const { tracker, autoOpen, onChange, log } = make({ fetch });
    tracker.onRows([row(A)]);
    onChange.mockClear();
    await tracker.onFinished(A);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0]![0], 'https://oh.test');
    expect(url.pathname).toBe(`/api/v1/conversation/${A}/events/search`);
    expect(url.searchParams.get('limit')).toBe(String(EVENTS_SCAN_LIMIT));
    expect(url.searchParams.get('sort_order')).toBe('TIMESTAMP_DESC');
    expect(autoOpen.mock.calls).toEqual([[pr(9), A]]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(tracker.openPullRequests().map((p) => p.url)).toEqual([pr(9)]);
    expect(log.mock.calls).toEqual([['openhands-events-scan', { count: 2, prs: 1 }]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Opened');
  });

  it('accepts a bare array and does not re-open a URL already known from the row', async () => {
    const fetch = vi.fn<OpenHandsFetch>(async () => ok([{ t: pr(7) }, { t: pr(10) }]));
    const { tracker, autoOpen } = make({ fetch });
    tracker.onRows([row(A, [pr(7)])]);
    await tracker.onFinished(A);
    expect(autoOpen.mock.calls).toEqual([[pr(10), A]]);
  });

  it('skips a second scan for the same conversation while one is in flight', async () => {
    let release!: (r: OpenHandsFetchResult) => void;
    const fetch = vi.fn<OpenHandsFetch>(() => new Promise((resolve) => (release = resolve)));
    const { tracker } = make({ fetch });
    tracker.onRows([row(A)]);
    const first = tracker.onFinished(A);
    await tracker.onFinished(A);
    expect(fetch).toHaveBeenCalledTimes(1);
    release(ok({ items: [] }));
    await first;
    const third = tracker.onFinished(A);
    expect(fetch).toHaveBeenCalledTimes(2);
    release(ok({ items: [] }));
    await third;
  });

  it('a failed fetch logs only an error code and changes nothing', async () => {
    const fetch = vi.fn<OpenHandsFetch>(async () => ({ status: 0, body: null, mode: 'api-key', error: 'redirect-refused' }));
    const { tracker, autoOpen, log } = make({ fetch });
    tracker.onRows([row(A)]);
    await tracker.onFinished(A);
    expect(autoOpen).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([['openhands-events-scan-error', { code: 'redirect-refused' }]]);
    const http = vi.fn<OpenHandsFetch>(async () => ({ status: 500, body: 'boom', mode: 'api-key' }));
    const second = make({ fetch: http });
    second.tracker.onRows([row(A)]);
    await second.tracker.onFinished(A);
    expect(second.log.mock.calls).toEqual([['openhands-events-scan-error', { code: 'HTTP 500' }]]);
    const thrown = make({ fetch: vi.fn<OpenHandsFetch>(async () => Promise.reject(new TypeError('net'))) });
    thrown.tracker.onRows([row(A)]);
    await thrown.tracker.onFinished(A);
    expect(thrown.log.mock.calls).toEqual([['openhands-events-scan-error', { code: 'TypeError' }]]);
    const odd = make({ fetch: vi.fn<OpenHandsFetch>(async () => ok({ data: [{ t: pr(9) }] })) });
    odd.tracker.onRows([row(A)]);
    await odd.tracker.onFinished(A);
    expect(odd.autoOpen).not.toHaveBeenCalled();
    expect(odd.log.mock.calls).toEqual([['openhands-events-scan', { count: 0, prs: 0 }]]);
  });

  it('a scan resolving after stop() opens nothing and later rows are ignored', async () => {
    let release!: (r: OpenHandsFetchResult) => void;
    const fetch = vi.fn<OpenHandsFetch>(() => new Promise((resolve) => (release = resolve)));
    const { tracker, autoOpen, onChange } = make({ fetch });
    tracker.onRows([row(A)]);
    const pending = tracker.onFinished(A);
    tracker.stop();
    onChange.mockClear();
    release(ok({ items: [{ t: pr(9) }] }));
    await pending;
    expect(autoOpen).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    tracker.onRows([row(A, [pr(3)])]);
    expect(onChange).not.toHaveBeenCalled();
    expect(tracker.openPullRequests()).toEqual([]);
  });

  it('a scan for a conversation that left the list opens nothing', async () => {
    let release!: (r: OpenHandsFetchResult) => void;
    const fetch = vi.fn<OpenHandsFetch>(() => new Promise((resolve) => (release = resolve)));
    const { tracker, autoOpen } = make({ fetch });
    tracker.onRows([row(A), row(B)]);
    const pending = tracker.onFinished(A);
    tracker.onRows([row(B)]);
    release(ok({ items: [{ t: pr(9) }] }));
    await pending;
    expect(autoOpen).not.toHaveBeenCalled();
    expect(tracker.openPullRequests()).toEqual([]);
  });
});

describe('openhands PR tracker: listed()', () => {
  it('is false until the first rows arrive and again after stop()', () => {
    const { tracker, onChange } = make();
    let listedDuringChange: boolean | null = null;
    onChange.mockImplementation(() => (listedDuringChange = tracker.listed()));
    expect(tracker.listed()).toBe(false);
    tracker.onRows([row(A, [pr(7)])]);
    expect(listedDuringChange).toBe(true); // the reconcile it triggers may prune
    expect(tracker.listed()).toBe(true);
    tracker.stop();
    expect(tracker.listed()).toBe(false);
  });
});

describe('openhands PR tracker: state refresh', () => {
  it('every list re-ensures the tracked non-final PR urls', () => {
    const states = new Map<string, string>();
    const ensureStates = vi.fn();
    const tracker = createOpenHandsPrTracker({
      fetch: vi.fn(async () => ok({ items: [] })),
      autoOpen: vi.fn(),
      onChange: vi.fn(),
      log: vi.fn(),
      stateOf: (url) => states.get(url) ?? null,
      ensureStates,
    });
    tracker.onRows([row(A, [pr(1), pr(2)]), row(B, [pr(3)])]);
    expect(ensureStates).toHaveBeenLastCalledWith(expect.arrayContaining([pr(1), pr(2), pr(3)]));
    expect(ensureStates.mock.calls.at(-1)![0]).toHaveLength(3);
    // No row change, still re-ensured; a merged URL is no longer asked for.
    states.set(pr(2), 'merged');
    tracker.onRows([row(A, [pr(1), pr(2)]), row(B, [pr(3)])]);
    expect(ensureStates).toHaveBeenCalledTimes(2);
    expect(ensureStates.mock.calls.at(-1)![0]).toEqual(expect.arrayContaining([pr(1), pr(3)]));
    expect(ensureStates.mock.calls.at(-1)![0]).not.toContain(pr(2));
  });

  it('a state flip to merged drops the url from the open list; refreshStates re-ensures on demand', () => {
    const states = new Map<string, string>();
    const ensureStates = vi.fn();
    const tracker = createOpenHandsPrTracker({
      fetch: vi.fn(async () => ok({ items: [] })),
      autoOpen: vi.fn(),
      onChange: vi.fn(),
      log: vi.fn(),
      stateOf: (url) => states.get(url) ?? null,
      ensureStates,
    });
    tracker.onRows([row(A, [pr(1)])]);
    expect(tracker.openPullRequests().map((p) => p.url)).toEqual([pr(1)]);
    states.set(pr(1), 'merged');
    expect(tracker.openPullRequests()).toEqual([]);
    expect(tracker.hasPullRequests()).toBe(true);
    ensureStates.mockClear();
    tracker.refreshStates();
    expect(ensureStates).not.toHaveBeenCalled();
    states.delete(pr(1));
    tracker.refreshStates();
    expect(ensureStates).toHaveBeenCalledWith([pr(1)]);
  });

  it('a stopped tracker asks for nothing', () => {
    const ensureStates = vi.fn();
    const tracker = createOpenHandsPrTracker({
      fetch: vi.fn(async () => ok({ items: [] })),
      autoOpen: vi.fn(),
      onChange: vi.fn(),
      log: vi.fn(),
      ensureStates,
    });
    tracker.onRows([row(A, [pr(1)])]);
    ensureStates.mockClear();
    tracker.stop();
    tracker.refreshStates();
    tracker.onRows([row(A, [pr(1)])]);
    expect(ensureStates).not.toHaveBeenCalled();
  });
});
