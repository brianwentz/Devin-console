import { describe, expect, it } from 'vitest';
import type { CloudListResult, CloudSession } from '../../src/core/cloudAcp';
import {
  CHILD_CAP,
  FULL_REPAGE_MS,
  MAX_PAGES_PER_FOLDER,
  MAX_PAGES_PER_LIST,
  PAGE_SIZE,
  PAGE_TIMEOUT_MS,
  PAGING_BUDGET_MS,
  PAGING_CONFIG,
  PageError,
  countedRoots,
  createFolderPaging,
  createPageFetch,
  shouldPage,
  topLevelRows,
  type CompleteResult,
  type ListContext,
  type PageErrorCode,
  type PageFetch,
  type PageRequest,
  type PagingConfig,
} from '../../src/core/cloudFolderPaging';

// ---------------------------------------------------------------- helpers

function row(id: string, folder: string | null, opts: Partial<CloudSession> = {}): CloudSession {
  return {
    id,
    acpId: `devin-${id}`,
    title: '',
    url: '',
    status: '',
    statusEnum: null,
    userActionRequired: null,
    folder,
    parentId: null,
    isPinned: false,
    isUnread: false,
    isStarred: false,
    directChildrenCount: 0,
    hasMoreChildren: false,
    prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 },
    isArchived: false,
    updatedAt: 0,
    ...opts,
  };
}

function roots(folder: string, count: number, prefix = folder): CloudSession[] {
  return Array.from({ length: count }, (_, i) => row(`${prefix}${i + 1}`, folder));
}

function list(
  sessions: CloudSession[],
  folderTotals: Record<string, number>,
  folders: string[] = Object.keys(folderTotals),
): CloudListResult {
  return { sessions, folders, folderTotals, nextCursor: null };
}

const CFG: PagingConfig = {
  rootsCap: 3,
  childCap: 200,
  pageSize: 3,
  maxPagesPerFolder: 10,
  maxPagesPerList: 50,
  budgetMs: 45_000,
  pageTimeoutMs: 20_000,
  fullRepageMs: 300_000,
};

const CTX: ListContext = { socketGen: 1, orgId: 'org', archivedStatus: 'ACTIVE' };

interface Call {
  folder: string;
  offset: number;
  timeoutMs: number;
}

// Fake server: `content[k]` is the full folder content (top-level rows in
// server order plus children after their parent). A slice is the top-level
// rows [offset, offset+pageSize) plus their children; `inject` rows are
// added to every page (a pinned row repeated by the server).
function server(
  content: Record<string, CloudSession[]>,
  opts: {
    inject?: Record<string, CloudSession[]>;
    onFetch?: (req: PageRequest) => void;
    override?: (req: PageRequest, call: number) => CloudListResult | Error | undefined;
  } = {},
) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: PageFetch = async (req, timeoutMs) => {
    calls.push({ folder: req.folder, offset: req.rootsOffset, timeoutMs });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      opts.onFetch?.(req);
      const custom = opts.override?.(req, calls.length);
      if (custom instanceof Error) throw custom;
      if (custom) return custom;
      const all = content[req.folder] ?? [];
      const top = all.filter((r) => r.parentId === null || !all.some((p) => p.id === r.parentId));
      const slice = top.slice(req.rootsOffset, req.rootsOffset + req.pageSize);
      const ids = new Set(slice.map((r) => r.id));
      const children = all.filter((r) => r.parentId !== null && ids.has(r.parentId));
      return list([...(opts.inject?.[req.folder] ?? []), ...slice, ...children], {});
    } finally {
      inFlight -= 1;
    }
  };
  return {
    fetch,
    calls,
    offsets: (folder?: string) =>
      calls.filter((c) => folder === undefined || c.folder === folder).map((c) => c.offset),
    maxInFlight: () => maxInFlight,
  };
}

function setup(config: PagingConfig = CFG) {
  let clock = 1_000_000;
  const logs: Record<string, unknown>[] = [];
  const paging = createFolderPaging({
    config,
    now: () => clock,
    log: (event, detail) => {
      expect(event).toBe('cloud-folder-paging');
      logs.push(detail);
    },
  });
  return {
    paging,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function applied(result: CompleteResult) {
  if (result.kind !== 'apply') throw new Error(`expected apply, got ${result.kind}`);
  return result;
}

const ids = (rows: readonly CloudSession[]) => rows.map((r) => r.id);
const sortedIds = (rows: readonly CloudSession[]) => [...ids(rows)].sort();
const same = () => CTX;

// --------------------------------------------------------------- constants

describe('constants', () => {
  it('match the S0 decision (Branch B + C1)', () => {
    expect(PAGE_SIZE).toBe(20);
    expect(CHILD_CAP).toBe(200);
    expect(MAX_PAGES_PER_FOLDER).toBe(100);
    expect(MAX_PAGES_PER_LIST).toBe(200);
    expect(PAGING_BUDGET_MS).toBe(45_000);
    expect(PAGE_TIMEOUT_MS).toBe(20_000);
    expect(FULL_REPAGE_MS).toBe(300_000);
    expect(PAGING_CONFIG).toEqual({
      rootsCap: 20,
      childCap: 200,
      pageSize: 20,
      maxPagesPerFolder: 100,
      maxPagesPerList: 200,
      budgetMs: 45_000,
      pageTimeoutMs: 20_000,
      fullRepageMs: 300_000,
    });
  });
});

// ------------------------------------------------------- row classification

describe('topLevelRows / countedRoots', () => {
  const rows = [
    row('r1', 'A'),
    row('c1', 'A', { parentId: 'r1' }), // child, parent present
    row('o1', 'A', { parentId: 'gone' }), // orphan: parent absent
    row('p1', 'A', { isPinned: true }),
    row('a1', 'A', { isArchived: true }),
    row('b1', 'B'),
    row('n1', null),
  ];

  it('excludes children whose parent is present, other folders and null folders', () => {
    expect(ids(topLevelRows(rows, 'A'))).toEqual(['r1', 'o1', 'p1', 'a1']);
    expect(ids(topLevelRows(rows, 'B'))).toEqual(['b1']);
  });

  it('counts only real roots: not orphans, pinned, archived or children', () => {
    expect([...countedRoots(rows, 'A')]).toEqual(['r1']);
  });

  it('dedupes counted roots by id', () => {
    expect(countedRoots([row('r1', 'A'), row('r1', 'A')], 'A').size).toBe(1);
  });
});

// --------------------------------------------------------------------- R0

describe('shouldPage (R0)', () => {
  it('pages iff total > counted and the slice is full', () => {
    expect(shouldPage(list(roots('A', 3), { A: 4 }), 'A', 3)).toBe(true);
    expect(shouldPage(list(roots('A', 3), { A: 3 }), 'A', 3)).toBe(false);
  });

  it('never pages a folder whose slice is not full', () => {
    expect(shouldPage(list(roots('A', 2), { A: 50 }), 'A', 3)).toBe(false);
  });

  it('counts pinned/archived/orphan rows toward a full slice but not toward the total', () => {
    const head = list(
      [row('r1', 'A'), row('p1', 'A', { isPinned: true }), row('o1', 'A', { parentId: 'x' })],
      { A: 2 },
    );
    expect(shouldPage(head, 'A', 3)).toBe(true);
  });

  it('never pages pinned; pages participated', () => {
    expect(shouldPage(list(roots('pinned', 3), { pinned: 9 }), 'pinned', 3)).toBe(false);
    expect(shouldPage(list(roots('participated', 3), { participated: 9 }), 'participated', 3)).toBe(true);
  });

  it('pages a folder missing from folderTotals only when its slice is full', () => {
    expect(shouldPage(list(roots('A', 3), {}), 'A', 3)).toBe(true);
    expect(shouldPage(list(roots('A', 2), {}), 'A', 3)).toBe(false);
  });
});

// ---------------------------------------------------- paging rules R1..R4

describe('paging rules', () => {
  it('pinned row repeated on every page: offsets 0 → 3 → 6, ends with end', async () => {
    const { paging, logs } = setup();
    const pinned = row('P', 'A', { isPinned: true });
    const content = roots('A', 7);
    const srv = server({ A: content }, { inject: { A: [pinned] } });
    const head = list([pinned, ...content.slice(0, 3)], { A: 7 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'P']);
    expect(res.incompleteFolders).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ stop: 'end', pages: 3, mismatch: 0 });
  });

  it('a pinned row inside a slice overlaps and is deduped', async () => {
    const { paging } = setup();
    // Server counts P as a root at position 0; the total excludes it.
    const content = [row('P', 'A', { isPinned: true }), ...roots('A', 5)];
    const srv = server({ A: content });
    const head = list(content.slice(0, 3), { A: 5 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    // P does not advance: 0 → 2 (overlap at A2, deduped) → 4 (overlap at A4).
    expect(srv.offsets('A')).toEqual([0, 2, 4]);
    expect(ids(res.sessions).filter((id) => id === 'A2')).toHaveLength(1);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'P']);
    expect(res.incompleteFolders).toEqual([]);
  });

  it('children never advance the offset (roots only) and are kept', async () => {
    const { paging } = setup();
    const content = [
      row('A1', 'A'),
      row('A1c1', 'A', { parentId: 'A1' }),
      row('A1c2', 'A', { parentId: 'A1' }),
      row('A2', 'A'),
      row('A3', 'A'),
      row('A4', 'A'),
    ];
    const srv = server({ A: content });
    const head = list([row('A1', 'A'), row('A2', 'A'), row('A3', 'A')], { A: 4 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A1c1', 'A1c2', 'A2', 'A3', 'A4']);
  });

  it('an orphan child on a page does not advance the offset but is kept', async () => {
    const { paging } = setup();
    // The orphan is a child row (its parent is not in the page) that does not
    // belong to the paged folder — not a top-level row of A, so it must not
    // move the offset, but it is still part of the fetched rows.
    const orphan = row('X1', null, { parentId: 'elsewhere' });
    const content = roots('A', 5);
    const srv = server(
      { A: content },
      { inject: { A: [orphan] } },
    );
    const head = list(content.slice(0, 3), { A: 5 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(ids(res.sessions)).toContain('X1');
    expect(res.incompleteFolders).toEqual([]);
  });

  it('an orphan top-level row of the folder advances the offset (server counts it as a root)', async () => {
    const { paging } = setup();
    const content = [row('O1', 'A', { parentId: 'gone' }), ...roots('A', 4)];
    const srv = server({ A: content });
    const head = list(content.slice(0, 3), { A: 4 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3', 'A4', 'O1']);
  });

  it('a short page ends with end', async () => {
    const { paging, logs } = setup();
    const content = roots('A', 4);
    const srv = server({ A: content });
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 4 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(res.incompleteFolders).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ stop: 'end', incomplete: 0, pages: 2 });
  });

  it('a folder of exactly 2 × pageSize costs one extra empty request', async () => {
    const { paging } = setup();
    const content = roots('A', 6);
    const srv = server({ A: content });
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 6 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    expect(res.incompleteFolders).toEqual([]);
  });

  it('an inflated total ends with end plus a mismatch', async () => {
    const { paging, logs } = setup();
    const content = roots('A', 4);
    const srv = server({ A: content });
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 10 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(res.incompleteFolders).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ stop: 'end', mismatch: 1 });
  });

  it('a deflated total still pages to the short page', async () => {
    const { paging, logs } = setup();
    const content = roots('A', 8);
    const srv = server({ A: content });
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 4 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
    expect(ids(res.sessions)).toHaveLength(8);
    expect(logs.at(-1)).toMatchObject({ stop: 'end', mismatch: 0 });
  });

  it('a repeated page stops with no-progress and keeps its rows', async () => {
    const { paging, logs } = setup();
    const content = roots('A', 9);
    // Server ignores rootsOffset: always the first slice.
    const srv = server(
      { A: content },
      { override: () => list(content.slice(0, 3), {}) },
    );
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 9 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(res.incompleteFolders).toEqual(['A']);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3']);
    expect(logs.at(-1)).toMatchObject({ stop: 'no-progress', incomplete: 1 });
  });

  it('max-pages stops the folder and keeps the fetched rows', async () => {
    const { paging, logs } = setup({ ...CFG, maxPagesPerFolder: 2 });
    const content = roots('A', 12);
    const srv = server({ A: content });
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 12 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.offsets('A')).toEqual([0, 3]);
    expect(res.incompleteFolders).toEqual(['A']);
    expect(ids(res.sessions)).toHaveLength(6);
    expect(logs.at(-1)).toMatchObject({ stop: 'max-pages' });
  });

  it('list-max-pages stops this and every later folder', async () => {
    const { paging, logs } = setup({ ...CFG, maxPagesPerList: 3 });
    const srv = server({ A: roots('A', 7), B: roots('B', 7) });
    const head = list([...roots('A', 3), ...roots('B', 3)], { A: 7, B: 7 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.calls.map((c) => `${c.folder}${c.offset}`)).toEqual(['A0', 'A3', 'A6']);
    // A ended on its third (short) page; B never got a request.
    expect(res.incompleteFolders).toEqual(['B']);
    expect(logs.at(-1)).toMatchObject({ stop: 'list-max-pages', pages: 3, incomplete: 1 });
  });

  it('budget: per-page timeout is min(page timeout, remaining budget), then stops', async () => {
    const { paging, logs, advance } = setup();
    const content = roots('A', 30);
    const srv = server({ A: content }, { onFetch: () => advance(15_000) });
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 30 }), CTX, srv.fetch, same, 'poll'),
    );
    expect(srv.calls.map((c) => c.timeoutMs)).toEqual([20_000, 20_000, 15_000]);
    expect(res.incompleteFolders).toEqual(['A']);
    expect(ids(res.sessions)).toHaveLength(9);
    expect(logs.at(-1)).toMatchObject({ stop: 'budget', pages: 3 });
  });

  it.each<[unknown, PageErrorCode]>([
    [new PageError('timeout', 'x'), 'timeout'],
    [new PageError('rpc', 'x'), 'rpc'],
    [new PageError('socket', 'x'), 'socket'],
    [new PageError('parse', 'x'), 'parse'],
    [new TypeError('boom'), 'other'],
  ])('a fetch error %s stops the folder with error/%s and keeps fetched rows', async (thrown, code) => {
    const { paging, logs } = setup();
    const content = roots('A', 9);
    const srv = server(
      { A: content },
      {
        override: (_req, call) => {
          if (call === 2) throw thrown;
          return undefined;
        },
      },
    );
    const promise = paging.complete(list(content.slice(0, 3), { A: 9 }), CTX, srv.fetch, same, 'poll');
    await expect(promise).resolves.toMatchObject({ kind: 'apply' });
    const res = applied(await promise);
    expect(res.incompleteFolders).toEqual(['A']);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3']);
    expect(logs.at(-1)).toMatchObject({ stop: 'error', code });
  });

  it('a failing folder does not stop the next folder', async () => {
    const { paging } = setup();
    const srv = server(
      { A: roots('A', 5), B: roots('B', 5) },
      { override: (req) => (req.folder === 'A' ? new PageError('rpc', 'x') : undefined) },
    );
    const head = list([...roots('A', 3), ...roots('B', 3)], { A: 5, B: 5 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(res.incompleteFolders).toEqual(['A']);
    expect(ids(res.sessions)).toContain('B5');
  });

  it('requests are strictly sequential (max 1 in flight)', async () => {
    const { paging } = setup();
    const srv = server({ A: roots('A', 10), B: roots('B', 10), participated: roots('participated', 10, 'p') });
    const head = list(
      [...roots('A', 3), ...roots('B', 3), ...roots('participated', 3, 'p')],
      { A: 10, B: 10, participated: 10 },
    );
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.calls.length).toBe(12);
    expect(srv.maxInFlight()).toBe(1);
  });

  it('pages folders in sidebar order and never pages pinned', async () => {
    const { paging } = setup();
    const srv = server({ B: roots('B', 4), A: roots('A', 4), pinned: roots('pinned', 4, 'P') });
    const head = list(
      [...roots('A', 3), ...roots('B', 3), ...roots('pinned', 3, 'P')],
      { A: 4, B: 4, pinned: 4 },
      ['pinned', 'B', 'A'],
    );
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.calls.map((c) => c.folder)).toEqual(['B', 'B', 'A', 'A']);
  });

  it('the head wins on duplicate ids', async () => {
    const { paging } = setup();
    const content = roots('A', 4).map((r) => ({ ...r, title: 'page' }));
    const srv = server({ A: content });
    const head = list(roots('A', 3).map((r) => ({ ...r, title: 'head' })), { A: 4 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(res.sessions.map((r) => `${r.id}:${r.title}`)).toEqual([
      'A1:head',
      'A2:head',
      'A3:head',
      'A4:page',
    ]);
  });

  it('returns the head folderTotals unchanged', async () => {
    const { paging } = setup();
    const srv = server({ A: roots('A', 4) });
    const head = list(roots('A', 3), { A: 4, B: 1 });
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(res.folderTotals).toEqual({ A: 4, B: 1 });
  });
});

// ---------------------------------------------------------- paging module

describe('paging module', () => {
  it('does not log a list that needed no paging', async () => {
    const { paging, logs } = setup();
    const srv = server({});
    const res = applied(await paging.complete(list(roots('A', 2), { A: 2 }), CTX, srv.fetch, same, 'poll'));
    expect(srv.calls).toEqual([]);
    expect(res.incompleteFolders).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('logs counts/enums/ms only — never folder names or ids', async () => {
    const { paging, logs } = setup();
    const srv = server({ Secret: roots('Secret', 4) });
    await paging.complete(list(roots('Secret', 3), { Secret: 4 }), CTX, srv.fetch, same, 'shell');
    expect(Object.keys(logs[0]!).sort()).toEqual(
      [
        'childPages',
        'code',
        'discarded',
        'folders',
        'incomplete',
        'mismatch',
        'ms',
        'pages',
        'reason',
        'reused',
        'stop',
      ].sort(),
    );
    expect(logs[0]).toMatchObject({ reason: 'shell', folders: 1, childPages: 0, discarded: false });
    expect(JSON.stringify(logs)).not.toContain('Secret');
  });

  it('force flags accumulate across calls and are consumed by complete()', async () => {
    const { paging } = setup();
    const contentA = roots('A', 4);
    const contentB = roots('B', 4);
    const srv = server({ A: contentA, B: contentB });
    const head = list([...contentA.slice(0, 3), ...contentB.slice(0, 3)], { A: 4, B: 4 });
    await paging.complete(head, CTX, srv.fetch, same, 'poll'); // memo both
    srv.calls.length = 0;
    await paging.complete(head, CTX, srv.fetch, same, 'poll'); // reuse both
    expect(srv.calls).toEqual([]);

    paging.requestForce({ folders: ['A'] });
    paging.requestForce({ folders: ['B'] });
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.offsets()).toEqual([0, 3, 0, 3]);

    srv.calls.length = 0;
    await paging.complete(head, CTX, srv.fetch, same, 'poll'); // force consumed
    expect(srv.calls).toEqual([]);

    paging.requestForce({ all: true });
    paging.requestForce({});
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.calls.map((c) => c.folder)).toEqual(['A', 'A', 'B', 'B']);
  });

  it.each<[string, Partial<ListContext>, boolean]>([
    ['socketGen', { socketGen: 2 }, true],
    ['archivedStatus', { archivedStatus: 'ALL' }, true],
    ['orgId', { orgId: 'other' }, false],
  ])('discards on a %s change; restores the force unless the org changed', async (_name, change, restored) => {
    const { paging, logs } = setup();
    const content = roots('A', 4);
    const srv = server({ A: content });
    const head = list(content.slice(0, 3), { A: 4 });
    await paging.complete(head, CTX, srv.fetch, same, 'poll'); // memo A

    paging.requestForce({ folders: ['A'] });
    const res = await paging.complete(head, CTX, srv.fetch, () => ({ ...CTX, ...change }), 'shell');
    expect(res).toEqual({ kind: 'discard' });
    expect(logs.at(-1)).toMatchObject({ discarded: true, reason: 'shell' });

    srv.calls.length = 0;
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    // Restored force → A re-paged; otherwise the memo is reused.
    expect(srv.calls.length > 0).toBe(restored);
  });

  it('a discarded list does not write the memo', async () => {
    const { paging } = setup();
    const content = roots('A', 4);
    const srv = server({ A: content });
    const head = list(content.slice(0, 3), { A: 4 });
    await paging.complete(head, CTX, srv.fetch, () => ({ ...CTX, socketGen: 9 }), 'poll');
    srv.calls.length = 0;
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('A')).toEqual([0, 3]);
  });

  it('reset() clears the pending force, the memo and the full-repage timestamp', async () => {
    const { paging, advance } = setup();
    const content = roots('A', 4);
    const srv = server({ A: content });
    const head = list(content.slice(0, 3), { A: 4 });
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    advance(1_000);
    paging.loadMore('A');
    paging.reset();
    srv.calls.length = 0;
    // Memo gone → A is re-paged (with the normal allowance — the loadMore went too).
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('A')).toEqual([0, 3]);
    // The full-repage timestamp restarted at that list: 1 s later reuses.
    advance(1_000);
    srv.calls.length = 0;
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.calls).toEqual([]);
  });

  it('reset() drops a pending loadMore allowance', async () => {
    const { paging } = setup({ ...CFG, maxPagesPerFolder: 1 });
    const content = roots('A', 12);
    const srv = server({ A: content });
    const head = list(content.slice(0, 3), { A: 12 });
    paging.loadMore('A');
    paging.reset();
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('A')).toEqual([0]);
  });

  it('an internal throw never rejects: head-only apply, every R0 folder incomplete', async () => {
    const { paging, logs } = setup();
    const srv = server({ A: roots('A', 4), B: roots('B', 4) });
    const head = list([...roots('A', 3), ...roots('B', 3), row('C1', 'C')], { A: 4, B: 4, C: 1 });
    const res = applied(
      await paging.complete(
        head,
        CTX,
        srv.fetch,
        () => {
          throw new Error('bug');
        },
        'poll',
      ),
    );
    expect(ids(res.sessions)).toEqual(ids(head.sessions));
    expect(res.incompleteFolders).toEqual(['A', 'B']);
    expect(logs.at(-1)).toMatchObject({ stop: 'error', incomplete: 2 });
  });

  it('a throwing logger never fails a list', async () => {
    const paging = createFolderPaging({
      config: CFG,
      now: () => 0,
      log: () => {
        throw new Error('log down');
      },
    });
    const srv = server({ A: roots('A', 4) });
    const res = applied(await paging.complete(list(roots('A', 3), { A: 4 }), CTX, srv.fetch, same, 'poll'));
    expect(ids(res.sessions)).toHaveLength(4);
    expect(res.incompleteFolders).toEqual([]);
  });
});

// --------------------------------------------------------------- Show more

describe('Show more (loadMore)', () => {
  it('pages the folder first, from 0, with 2× allowance; the next list is normal again', async () => {
    const { paging } = setup({ ...CFG, maxPagesPerFolder: 2 });
    const big = roots('Z', 20);
    const srv = server({ A: roots('A', 4), Z: big });
    const head = list([...roots('A', 3), ...big.slice(0, 3)], { A: 4, Z: 20 });

    const first = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(first.incompleteFolders).toEqual(['Z']);
    expect(srv.calls.map((c) => `${c.folder}${c.offset}`)).toEqual(['A0', 'A3', 'Z0', 'Z3']);

    paging.loadMore('Z');
    srv.calls.length = 0;
    const second = applied(await paging.complete(head, CTX, srv.fetch, same, 'load-more'));
    // Z first, from 0, 4 pages (2 × 2); A's memo is reused.
    expect(srv.calls.map((c) => `${c.folder}${c.offset}`)).toEqual(['Z0', 'Z3', 'Z6', 'Z9']);
    expect(second.incompleteFolders).toEqual(['Z']);
    expect(ids(second.sessions).filter((id) => id.startsWith('Z'))).toHaveLength(12);

    srv.calls.length = 0;
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('Z')).toEqual([0, 3]);
  });

  it('loadMore during an in-flight complete() applies to the follow-up list', async () => {
    const { paging } = setup({ ...CFG, maxPagesPerFolder: 1 });
    const big = roots('Z', 20);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const inner = server({ Z: big });
    const fetch: PageFetch = async (req, t) => {
      if (gated) {
        gated = false;
        await gate;
      }
      return inner.fetch(req, t);
    };
    const head = list(big.slice(0, 3), { Z: 20 });

    const p1 = paging.complete(head, CTX, fetch, same, 'poll');
    await Promise.resolve();
    paging.loadMore('Z');
    release();
    const r1 = applied(await p1);
    // #1 ran with the normal allowance (1 page).
    expect(inner.offsets('Z')).toEqual([0]);
    expect(r1.incompleteFolders).toEqual(['Z']);

    inner.calls.length = 0;
    await paging.complete(head, CTX, fetch, same, 'load-more');
    expect(inner.offsets('Z')).toEqual([0, 3]);
  });

  it('a discarded in-flight list merges its force with the pending loadMore', async () => {
    const { paging } = setup({ ...CFG, maxPagesPerFolder: 1 });
    const srv = server({ A: roots('A', 4), Z: roots('Z', 20) });
    const head = list([...roots('A', 3), ...roots('Z', 3)], { A: 4, Z: 20 });
    await paging.complete(head, CTX, srv.fetch, same, 'poll'); // memo A

    let gen = 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const fetch: PageFetch = async (req, t) => {
      if (gated) {
        gated = false;
        await gate;
      }
      return srv.fetch(req, t);
    };
    paging.requestForce({ folders: ['A'] });
    srv.calls.length = 0;
    const p1 = paging.complete(head, CTX, fetch, () => ({ ...CTX, socketGen: gen }), 'shell');
    await Promise.resolve();
    paging.loadMore('Z');
    gen = 2; // new socket while #1 is paging
    release();
    expect(await p1).toEqual({ kind: 'discard' });

    srv.calls.length = 0;
    await paging.complete(head, { ...CTX, socketGen: 2 }, srv.fetch, () => ({ ...CTX, socketGen: 2 }), 'load-more');
    // Z (load-more) first with 2 × 1 pages, then A re-paged (normal 1-page
    // allowance) by the restored force — without it A's memo would be reused.
    expect(srv.calls.map((c) => `${c.folder}${c.offset}`)).toEqual(['Z0', 'Z3', 'A0']);
  });
});

// ----------------------------------------------------------- Branch B memo

describe('Branch B memo', () => {
  const content = roots('A', 7);
  const head = list(content.slice(0, 3), { A: 7 });

  async function primed(config: PagingConfig = CFG) {
    const t = setup(config);
    const srv = server({ A: content });
    await t.paging.complete(head, CTX, srv.fetch, same, 'poll');
    srv.calls.length = 0;
    return { ...t, srv };
  }

  it('reuses the memo without a request when total, status and head subset match', async () => {
    const { paging, srv, logs, advance } = await primed();
    advance(1_000);
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.calls).toEqual([]);
    expect(sortedIds(res.sessions)).toEqual(ids(content).sort());
    expect(res.incompleteFolders).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ reused: 1, pages: 0 });
  });

  it('re-pages from 0 when the total changes', async () => {
    const { paging, srv } = await primed();
    await paging.complete(list(content.slice(0, 3), { A: 8 }), CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
  });

  it('re-pages from 0 when the archived status changes', async () => {
    const { paging, srv } = await primed();
    const all: ListContext = { ...CTX, archivedStatus: 'ALL' };
    await paging.complete(head, all, srv.fetch, () => all, 'shell');
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
  });

  it('re-pages from 0 when a head row is not in the memo', async () => {
    const { paging, srv } = await primed();
    const fresh = row('NEW', 'A');
    srv.calls.length = 0;
    await paging.complete(list([fresh, ...content.slice(0, 2)], { A: 7 }), CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
  });

  it('re-pages a forced folder', async () => {
    const { paging, srv } = await primed();
    paging.requestForce({ folders: ['A'] });
    await paging.complete(head, CTX, srv.fetch, same, 'shell');
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
  });

  it('a row that moved up keeps the displaced row', async () => {
    const { paging, srv } = await primed();
    // A5 updated → now in the head; A3 fell out of the head slice.
    const moved = list([content[4]!, content[0]!, content[1]!], { A: 7 });
    const res = applied(await paging.complete(moved, CTX, srv.fetch, same, 'poll'));
    expect(srv.calls).toEqual([]);
    expect(ids(res.sessions)).toContain('A3');
    expect(sortedIds(res.sessions)).toEqual(ids(content).sort());
  });

  it('FULL_REPAGE_MS forces every folder once', async () => {
    const { paging, srv, advance } = await primed();
    advance(CFG.fullRepageMs - 1);
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.calls).toEqual([]);
    advance(1);
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.offsets('A')).toEqual([0, 3, 6]);
    srv.calls.length = 0;
    advance(1_000);
    await paging.complete(head, CTX, srv.fetch, same, 'poll');
    expect(srv.calls).toEqual([]);
  });

  it('a partial outcome merges the memo rows when memo.total === total', async () => {
    const { paging, advance } = await primed();
    advance(1_000);
    paging.requestForce({ folders: ['A'] });
    const failing = server(
      { A: content },
      { override: (_req, call) => (call === 2 ? new PageError('timeout', 'x') : undefined) },
    );
    const res = applied(await paging.complete(head, CTX, failing.fetch, same, 'shell'));
    expect(res.incompleteFolders).toEqual(['A']);
    expect(sortedIds(res.sessions)).toEqual(ids(content).sort());
  });

  it('a partial outcome does not merge the memo when the total changed', async () => {
    const { paging } = await primed();
    const failing = server(
      { A: content },
      { override: (_req, call) => (call === 2 ? new PageError('timeout', 'x') : undefined) },
    );
    const res = applied(
      await paging.complete(list(content.slice(0, 3), { A: 6 }), CTX, failing.fetch, same, 'poll'),
    );
    expect(res.incompleteFolders).toEqual(['A']);
    expect(sortedIds(res.sessions)).toEqual(['A1', 'A2', 'A3']);
  });

  it('an incomplete stop keeps the previous memo for later reuse', async () => {
    const { paging, srv, advance } = await primed();
    paging.requestForce({ folders: ['A'] });
    const failing = server({ A: content }, { override: () => new PageError('socket', 'x') });
    await paging.complete(head, CTX, failing.fetch, same, 'shell');
    advance(1_000);
    const res = applied(await paging.complete(head, CTX, srv.fetch, same, 'poll'));
    expect(srv.calls).toEqual([]);
    expect(res.incompleteFolders).toEqual([]);
    expect(ids(res.sessions)).toHaveLength(7);
  });
});

// --------------------------------------------------------- createPageFetch

describe('createPageFetch', () => {
  const ok = { result: { sessions: [], _meta: {} } };

  function capture(reply: () => Promise<Record<string, unknown>>) {
    const seen: { method: string; params: Record<string, unknown>; timeoutMs: number }[] = [];
    const request = (method: string, params: Record<string, unknown>, timeoutMs: number) => {
      seen.push({ method, params, timeoutMs });
      return reply();
    };
    return { seen, request };
  }

  it.each<['ACTIVE' | 'ALL', string | null]>([
    ['ACTIVE', 'user-1'],
    ['ALL', null],
  ])('sends a folder page with status %s (user %s)', async (archivedStatus, userId) => {
    const { seen, request } = capture(async () => ok);
    const fetch = createPageFetch({
      request,
      orgId: 'org',
      userId,
      archivedStatus,
      config: { ...PAGING_CONFIG, childCap: 77 },
    });
    await fetch({ kind: 'folder', folder: 'F', rootsOffset: 40, pageSize: 20 }, 1234);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('session/list');
    expect(seen[0]!.timeoutMs).toBe(1234);
    const meta = seen[0]!.params._meta as Record<string, unknown>;
    expect(meta['cognition.ai/archivedStatus']).toBe(archivedStatus);
    expect(meta['cognition.ai/folder']).toBe('F');
    expect(meta['cognition.ai/rootsOffset']).toBe(40);
    expect(meta['cognition.ai/maxRootsPerFolder']).toBe(20);
    expect(meta['cognition.ai/maxChildrenPerRoot']).toBe(77);
    expect(meta).not.toHaveProperty('cognition.ai/limit');
    if (userId) expect(meta['cognition.ai/participant']).toEqual([userId]);
    else expect(meta).not.toHaveProperty('cognition.ai/participant');
  });

  it('parses the result like page 1', async () => {
    const { request } = capture(async () => ({
      result: {
        sessions: [{ sessionId: 'devin-abc', _meta: { 'cognition.ai/folder': 'F' } }],
        _meta: { 'cognition.ai/folderTotals': { F: 3 } },
      },
    }));
    const fetch = createPageFetch({ request, orgId: 'org', userId: null, archivedStatus: 'ACTIVE', config: PAGING_CONFIG });
    const page = await fetch({ kind: 'folder', folder: 'F', rootsOffset: 0, pageSize: 20 }, 1);
    expect(page.sessions.map((s) => [s.id, s.folder])).toEqual([['abc', 'F']]);
    expect(page.folderTotals).toEqual({ F: 3 });
  });

  it.each<[string, () => Promise<Record<string, unknown>>, PageErrorCode]>([
    ['message.error', async () => ({ error: { code: -1, message: 'server says no' } }), 'rpc'],
    ['request timeout', async () => Promise.reject(new Error('request timeout')), 'timeout'],
    ['ws not open', async () => Promise.reject(new Error('ws not open')), 'socket'],
    ['ws closed', async () => Promise.reject(new Error('ws closed')), 'socket'],
    ['null result', async () => ({ result: null }), 'parse'],
    ['array result', async () => ({ result: [] }), 'parse'],
    ['string result', async () => ({ result: 'nope' }), 'parse'],
    ['other throw', async () => Promise.reject(new Error('something else')), 'other'],
    ['non-error throw', async () => Promise.reject('weird'), 'other'],
  ])('maps %s to PageError(%s)', async (_name, reply, code) => {
    const { request } = capture(reply);
    const fetch = createPageFetch({ request, orgId: 'org', userId: null, archivedStatus: 'ACTIVE', config: PAGING_CONFIG });
    const error = await fetch({ kind: 'folder', folder: 'F', rootsOffset: 0, pageSize: 20 }, 1).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PageError);
    expect((error as PageError).code).toBe(code);
    expect((error as PageError).message).not.toContain('server says no');
  });
});
