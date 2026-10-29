// Devin Cloud sidebar folder paging (pure; Branch B + C1 of
// docs/plans/devin-session-panel-show-all-folder-sessions.md). Page 1 of
// session/list caps every folder at PAGE_SIZE top-level rows; complete() pages
// the folders that page 1 truncated, strictly one request at a time, and keeps
// a slim per-folder memo so a steady-state poll costs no extra request.
// cloudSessions.ts owns the socket, the coalescing and the apply.

import {
  buildFolderPageParams,
  parseListResult,
  type CloudListResult,
  type CloudSession,
} from './cloudAcp';
import {
  CHILD_CAP,
  FULL_REPAGE_MS,
  MAX_PAGES_PER_FOLDER,
  MAX_PAGES_PER_LIST,
  PAGE_SIZE,
  PAGE_TIMEOUT_MS,
  PAGING_BUDGET_MS,
} from './cloudFolderPagingLimits';

export {
  CHILD_CAP,
  FULL_REPAGE_MS,
  MAX_PAGES_PER_FOLDER,
  MAX_PAGES_PER_LIST,
  PAGE_SIZE,
  PAGE_TIMEOUT_MS,
  PAGING_BUDGET_MS,
} from './cloudFolderPagingLimits';

export type ArchivedStatus = 'ACTIVE' | 'ALL';
export type PagingStop = 'end' | 'no-progress' | 'max-pages' | 'list-max-pages' | 'budget' | 'error';
export type PageErrorCode = 'timeout' | 'rpc' | 'socket' | 'parse' | 'other';
export type PageRequest = { kind: 'folder'; folder: string; rootsOffset: number; pageSize: number };
/** Throws a PageError; anything else thrown is treated as code 'other'. */
export type PageFetch = (req: PageRequest, timeoutMs: number) => Promise<CloudListResult>;

export class PageError extends Error {
  constructor(
    readonly code: PageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PageError';
  }
}

export interface PagingConfig {
  /** Page-1 maxRootsPerFolder — the R0 "slice full" threshold. */
  rootsCap: number;
  childCap: number;
  pageSize: number;
  maxPagesPerFolder: number;
  maxPagesPerList: number;
  budgetMs: number;
  pageTimeoutMs: number;
  fullRepageMs: number;
}

export const PAGING_CONFIG: PagingConfig = {
  rootsCap: PAGE_SIZE,
  childCap: CHILD_CAP,
  pageSize: PAGE_SIZE,
  maxPagesPerFolder: MAX_PAGES_PER_FOLDER,
  maxPagesPerList: MAX_PAGES_PER_LIST,
  budgetMs: PAGING_BUDGET_MS,
  pageTimeoutMs: PAGE_TIMEOUT_MS,
  fullRepageMs: FULL_REPAGE_MS,
};

const PINNED = 'pinned';

/** Rows of `folder` whose parent is not in the same response (orphans, pinned and archived included). */
export function topLevelRows(rows: readonly CloudSession[], folder: string): CloudSession[] {
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter(
    (row) => row.folder === folder && (row.parentId === null || !ids.has(row.parentId)),
  );
}

/** Distinct real roots of `folder` (no parent, not pinned, not archived) — can only under-count. */
export function countedRoots(rows: readonly CloudSession[], folder: string): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.folder === folder && row.parentId === null && !row.isPinned && !row.isArchived) {
      out.add(row.id);
    }
  }
  return out;
}

/** R0: page `folder` iff its total exceeds the counted roots and the head slice is full. */
export function shouldPage(head: CloudListResult, folder: string, cap: number): boolean {
  if (folder === PINNED) return false;
  if (topLevelRows(head.sessions, folder).length < cap) return false;
  const total = head.folderTotals[folder];
  if (total === undefined) return true;
  return total > countedRoots(head.sessions, folder).size;
}

export interface ListContext {
  socketGen: number;
  orgId: string;
  archivedStatus: ArchivedStatus;
}

export type CompleteResult =
  | {
      kind: 'apply';
      sessions: CloudSession[];
      folderTotals: Record<string, number>;
      incompleteFolders: string[];
    }
  | { kind: 'discard' };

export interface FolderPaging {
  requestForce(f: { all?: boolean; folders?: string[] }): void;
  loadMore(folder: string): void;
  complete(
    head: CloudListResult,
    ctx: ListContext,
    fetch: PageFetch,
    current: () => ListContext,
    reason: string,
  ): Promise<CompleteResult>;
  reset(): void;
}

interface ForceState {
  all: boolean;
  folders: Set<string>;
  loadMore: Set<string>;
}

interface MemoEntry {
  total: number | undefined;
  archivedStatus: ArchivedStatus;
  rows: CloudSession[];
  ids: Set<string>;
}

interface FolderOutcome {
  rows: CloudSession[];
  stop: PagingStop;
  code: PageErrorCode | null;
}

const LIST_STOPS: ReadonlySet<PagingStop> = new Set(['list-max-pages', 'budget']);

function emptyForce(): ForceState {
  return { all: false, folders: new Set(), loadMore: new Set() };
}

function mergeForce(into: ForceState, from: ForceState): void {
  into.all ||= from.all;
  for (const folder of from.folders) into.folders.add(folder);
  for (const folder of from.loadMore) into.loadMore.add(folder);
}

// Folders the head knows about, in sidebar order first.
function candidateFolders(head: CloudListResult): string[] {
  const out = new Set<string>(head.folders);
  for (const folder of Object.keys(head.folderTotals)) out.add(folder);
  for (const row of head.sessions) if (row.folder !== null) out.add(row.folder);
  return [...out];
}

function sameContext(a: ListContext, b: ListContext): boolean {
  return a.socketGen === b.socketGen && a.orgId === b.orgId && a.archivedStatus === b.archivedStatus;
}

export function createFolderPaging(deps: {
  config: PagingConfig;
  now: () => number;
  log: (event: string, detail: Record<string, unknown>) => void;
}): FolderPaging {
  const { config, now } = deps;
  let pending = emptyForce();
  let memos = new Map<string, MemoEntry>();
  let lastFullRepage: number | null = null;

  const safeLog = (detail: Record<string, unknown>): void => {
    try {
      deps.log('cloud-folder-paging', detail);
    } catch {
      // Logging must never fail a list.
    }
  };

  async function run(
    head: CloudListResult,
    ctx: ListContext,
    fetch: PageFetch,
    current: () => ListContext,
    reason: string,
    force: ForceState,
    started: number,
    r0: string[],
  ): Promise<CompleteResult> {
    const fullDue = lastFullRepage === null || started - lastFullRepage >= config.fullRepageMs;
    const forceAll = force.all || fullDue;
    const order = [
      ...[...force.loadMore].filter((folder) => r0.includes(folder)),
      ...r0.filter((folder) => !force.loadMore.has(folder)),
    ];

    let listPages = 0;
    let listStop: PagingStop | null = null;
    let firstStop: PagingStop | null = null;
    let code: PageErrorCode | null = null;
    let anyEnd = false;
    let anyError = false;
    // Set when the context (socket / org / archived filter) changed mid-run.
    let superseded = false;
    let reused = 0;
    let mismatch = 0;
    const extra = new Map<string, CloudSession>();
    const memoWrites = new Map<string, MemoEntry>();
    const incomplete: string[] = [];
    const addExtra = (rows: readonly CloudSession[]): void => {
      for (const row of rows) if (!extra.has(row.id)) extra.set(row.id, row);
    };

    const pageFolder = async (folder: string, allowance: number): Promise<FolderOutcome> => {
      const seen = new Map<string, CloudSession>();
      const rows = (): CloudSession[] => [...seen.values()];
      let rootsOffset = 0;
      let pages = 0;
      for (;;) {
        // A superseded run must not issue another request.
        if (!sameContext(current(), ctx)) {
          superseded = true;
          return { rows: rows(), stop: 'error', code: null };
        }
        if (pages >= allowance) return { rows: rows(), stop: 'max-pages', code: null };
        if (listPages >= config.maxPagesPerList) return { rows: rows(), stop: 'list-max-pages', code: null };
        const remaining = config.budgetMs - (now() - started);
        if (remaining <= 0) return { rows: rows(), stop: 'budget', code: null };
        pages += 1;
        listPages += 1;
        let page: CloudListResult;
        try {
          page = await fetch(
            { kind: 'folder', folder, rootsOffset, pageSize: config.pageSize },
            Math.min(config.pageTimeoutMs, remaining),
          );
        } catch (error) {
          return { rows: rows(), stop: 'error', code: error instanceof PageError ? error.code : 'other' };
        }
        const top = topLevelRows(page.sessions, folder);
        const topIds = new Set(top.map((row) => row.id));
        let added = 0;
        let advance = 0;
        for (const row of page.sessions) {
          if (seen.has(row.id)) continue;
          seen.set(row.id, row);
          added += 1;
          // R1: only new non-pinned top-level rows of the folder move the offset.
          if (topIds.has(row.id) && !row.isPinned) advance += 1;
        }
        // R2 before R3: the trailing empty page of an exact multiple is an end.
        if (top.length < config.pageSize) return { rows: rows(), stop: 'end', code: null };
        if (added === 0) return { rows: rows(), stop: 'no-progress', code: null };
        rootsOffset += advance;
      }
    };

    for (const folder of order) {
      const total = head.folderTotals[folder];
      const memo = memos.get(folder);
      const memoMatches =
        memo !== undefined && memo.archivedStatus === ctx.archivedStatus && memo.total === total;
      const forced = forceAll || force.folders.has(folder) || force.loadMore.has(folder);
      if (
        !forced &&
        memoMatches &&
        topLevelRows(head.sessions, folder).every((row) => memo.ids.has(row.id))
      ) {
        reused += 1;
        addExtra(memo.rows);
        continue;
      }
      let outcome: FolderOutcome;
      if (listStop) {
        outcome = { rows: [], stop: listStop, code: null };
      } else {
        const allowance = force.loadMore.has(folder)
          ? 2 * config.maxPagesPerFolder
          : config.maxPagesPerFolder;
        outcome = await pageFolder(folder, allowance);
        if (superseded) break;
        if (LIST_STOPS.has(outcome.stop)) listStop = outcome.stop;
      }
      addExtra(outcome.rows);
      if (outcome.stop === 'end') {
        anyEnd = true;
        memoWrites.set(folder, {
          total,
          archivedStatus: ctx.archivedStatus,
          rows: outcome.rows,
          ids: new Set(outcome.rows.map((row) => row.id)),
        });
        if (total !== undefined) {
          const counted = countedRoots([...head.sessions, ...outcome.rows], folder).size;
          if (counted < total) mismatch += 1;
        }
        continue;
      }
      incomplete.push(folder);
      firstStop ??= outcome.stop;
      if (outcome.stop === 'error') anyError = true;
      code ??= outcome.code;
      // A transient failure never shrinks a folder that was complete before.
      if (memoMatches) addExtra(memo.rows);
    }

    const stop = listStop ?? firstStop ?? (anyEnd ? 'end' : null);
    const detail = {
      reason,
      folders: r0.length,
      reused,
      pages: listPages,
      childPages: 0,
      incomplete: incomplete.length,
      mismatch,
      stop,
      code,
      ms: now() - started,
    };

    const latest = current();
    if (superseded || !sameContext(latest, ctx)) {
      if (latest.orgId === ctx.orgId) mergeForce(pending, force);
      safeLog({ ...detail, discarded: true });
      return { kind: 'discard' };
    }

    for (const folder of [...memos.keys()]) if (!r0.includes(folder)) memos.delete(folder);
    for (const [folder, entry] of memoWrites) memos.set(folder, entry);
    // A due full re-page that stopped early is retried on the next list.
    if (fullDue && listStop === null && !anyError) lastFullRepage = started;
    if (listPages > 0 || incomplete.length > 0 || reused > 0) safeLog({ ...detail, discarded: false });

    const headIds = new Set(head.sessions.map((row) => row.id));
    const sessions = [...head.sessions];
    for (const [id, row] of extra) if (!headIds.has(id)) sessions.push(row);
    return { kind: 'apply', sessions, folderTotals: head.folderTotals, incompleteFolders: incomplete };
  }

  return {
    requestForce(f) {
      pending.all ||= f.all === true;
      for (const folder of f.folders ?? []) pending.folders.add(folder);
    },
    loadMore(folder) {
      pending.folders.add(folder);
      pending.loadMore.add(folder);
    },
    async complete(head, ctx, fetch, current, reason) {
      const started = now();
      const force = pending;
      pending = emptyForce();
      let r0: string[] = [];
      try {
        r0 = candidateFolders(head).filter((folder) => shouldPage(head, folder, config.rootsCap));
        return await run(head, ctx, fetch, current, reason, force, started, r0);
      } catch {
        try {
          if (current().orgId === ctx.orgId) mergeForce(pending, force);
        } catch {
          // current() itself failed — drop the force rather than throw.
        }
        safeLog({
          reason,
          folders: r0.length,
          reused: 0,
          pages: 0,
          childPages: 0,
          incomplete: r0.length,
          mismatch: 0,
          stop: 'error',
          code: 'other',
          ms: now() - started,
          discarded: false,
        });
        return {
          kind: 'apply',
          sessions: [...head.sessions],
          folderTotals: head.folderTotals,
          incompleteFolders: r0,
        };
      }
    },
    reset() {
      pending = emptyForce();
      memos = new Map();
      lastFullRepage = null;
    },
  };
}

function toPageError(error: unknown): PageError {
  if (error instanceof PageError) return error;
  const message = error instanceof Error ? error.message : '';
  if (message === 'request timeout') return new PageError('timeout', 'request timeout');
  if (message === 'ws not open' || message === 'ws closed') return new PageError('socket', message);
  return new PageError('other', error instanceof Error ? error.name : typeof error);
}

/** session/list folder pages over the cloud socket's `request`; failures become PageErrors. */
export function createPageFetch(o: {
  request: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<Record<string, unknown>>;
  orgId: string;
  userId: string | null;
  archivedStatus: ArchivedStatus;
  config: PagingConfig;
}): PageFetch {
  return async (req, timeoutMs) => {
    const params = buildFolderPageParams({
      orgId: o.orgId,
      userId: o.userId,
      folder: req.folder,
      rootsOffset: req.rootsOffset,
      archivedStatus: o.archivedStatus,
      pageSize: req.pageSize,
      childCap: o.config.childCap,
    });
    let message: Record<string, unknown>;
    try {
      message = await o.request('session/list', params, timeoutMs);
    } catch (error) {
      throw toPageError(error);
    }
    // Server error text is never carried — only the code.
    if (message.error) throw new PageError('rpc', 'rpc error');
    const result = message.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new PageError('parse', 'result is not an object');
    }
    return parseListResult(result, o.orgId);
  };
}
