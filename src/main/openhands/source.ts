// OpenHands Cloud as a REST-poll CloudSessionSource (src/main/cloudKit/source.ts).
// Electron-free: the transport (./fetch.ts) is injected.
//
// Listing: poll 1 and every 10th poll (and after a mutation or a focus
// request) re-list everything — dropping conversations that are gone; the
// polls in between ask only for `updated_at__gte` the cursor and merge.

import type { CloudSourceCapabilities } from '../../core/cloudKit/capabilities';
import {
  listAllPages,
  mergeRows,
  nextCursor,
  parseSearchPage,
  toCloudSession,
  type OhRow,
} from '../../core/openhands';
import type { CloudListData } from '../../core/sessionTree';
import type { CloudState, OpenHandsConnection, OpenHandsShellState } from '../../shared/ipc';
import type { CloudMutation, CloudSessionSource, CloudSessionsLog } from '../cloudKit/source';
import type { OpenHandsFetch, OpenHandsFetchResult } from './fetch';

export type { OpenHandsFetch, OpenHandsFetchResult } from './fetch';

const PAGE_LIMIT = 100;
const FULL_EVERY = 10;
const SEARCH_PATH = '/api/v1/app-conversations/search';

export const OPENHANDS_CAPABILITIES: CloudSourceCapabilities = {
  folders: 'derived',
  archive: false,
  rename: true,
  delete: true,
  reorder: true,
};

export interface OpenHandsSourceDeps {
  fetch: OpenHandsFetch;
  now(): number;
  log: CloudSessionsLog;
  baseUrl(): string;
}

export interface OpenHandsSource extends CloudSessionSource {
  connection(): OpenHandsConnection;
  /** The next list re-reads everything (focus, settings change). */
  requestFull(): void;
  isListing(): boolean;
}

// Carries the fetch error code: `.message` is `code` or `HTTP <status>` —
// never response text.
export class OpenHandsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'OpenHandsError';
  }
}

function connectionFor(result: OpenHandsFetchResult): OpenHandsConnection {
  switch (result.error) {
    case 'api-key-rejected':
      return 'api-key-rejected';
    case 'login-required':
      return 'login-required';
    case undefined:
      return result.status > 0 && result.status < 500 ? (result.mode === 'api-key' ? 'api-key' : 'web-session') : 'error';
    default:
      return 'error';
  }
}

export function createOpenHandsSource(deps: OpenHandsSourceDeps): OpenHandsSource {
  let rows: OhRow[] = [];
  let cursor: number | null = null;
  let polls = 0;
  let forceFull = false;
  let listing = false;
  let connection: OpenHandsConnection = 'idle';
  let lastAuthLog = '';

  const note = (result: OpenHandsFetchResult): void => {
    connection = connectionFor(result);
    const ok = result.error === undefined && result.status >= 200 && result.status < 300;
    const key = `${result.mode}:${ok}`;
    if (key !== lastAuthLog) {
      lastAuthLog = key;
      deps.log('openhands-auth', { mode: result.mode, ok });
    }
  };

  const request = async (path: string, init?: RequestInit): Promise<OpenHandsFetchResult> => {
    const result = await deps.fetch(path, init);
    note(result);
    return result;
  };

  const toData = (): CloudListData => {
    const base = deps.baseUrl();
    const sessions = rows.map((r) => toCloudSession(r, base));
    const folderTotals: Record<string, number> = {};
    for (const s of sessions) {
      const section = s.section ?? '';
      folderTotals[section] = (folderTotals[section] ?? 0) + 1;
    }
    return { sessions, folders: Object.keys(folderTotals).sort(), folderTotals };
  };

  return {
    providerId: 'openhands',
    capabilities: OPENHANDS_CAPABILITIES,
    start() {},
    stop() {},
    connection: () => connection,
    requestFull() {
      forceFull = true;
    },
    isListing: () => listing,

    async list(): Promise<CloudListData> {
      listing = true;
      const t0 = deps.now();
      polls += 1;
      const full = forceFull || polls === 1 || polls % FULL_EVERY === 0;
      forceFull = false;
      try {
        const since = !full && cursor !== null ? new Date(cursor).toISOString() : undefined;
        const items = await listAllPages<OhRow>(async (pageId) => {
          const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
          if (pageId !== null) params.set('page_id', pageId);
          if (since !== undefined) params.set('updated_at__gte', since);
          const result = await request(`${SEARCH_PATH}?${params.toString()}`);
          if (result.error) throw new OpenHandsError(result.error, result.status);
          if (result.status < 200 || result.status >= 300) {
            throw new OpenHandsError(`HTTP ${result.status}`, result.status);
          }
          return parseSearchPage(result.body);
        });
        if (full) {
          rows = items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
          cursor = nextCursor(rows, null);
        } else {
          rows = mergeRows(rows, items);
          cursor = nextCursor(items, cursor);
        }
        deps.log('openhands-list', { count: rows.length, ms: deps.now() - t0, incremental: since !== undefined });
        return toData();
      } catch (error) {
        // A failed full list leaves the cursor as is; make the retry full.
        if (full) forceFull = true;
        throw error;
      } finally {
        listing = false;
      }
    },

    async mutate(op: CloudMutation) {
      const path = `/api/v1/app-conversations/${encodeURIComponent(op.id)}`;
      const init: RequestInit =
        op.op === 'rename'
          ? { method: 'PATCH', body: JSON.stringify({ title: op.title }) }
          : { method: 'DELETE' };
      const result = await request(path, init);
      if (result.error) {
        deps.log('openhands-mutate', { op: op.op, ok: false, status: result.status });
        throw new OpenHandsError(result.error, result.status);
      }
      const ok = result.status >= 200 && result.status < 300;
      deps.log('openhands-mutate', { op: op.op, ok, status: result.status });
      if (ok) forceFull = true;
      return { ok, status: result.status };
    },

    async readIdentity() {
      return { reason: 'unsupported' };
    },
  };
}

// The ShellState.openhands slice from a controller snapshot. A failed list
// (controller status 'error') is shown as lastError {op:'list'} — the
// controller's own lastError only carries mutation failures.
export function buildOpenHandsShellState(snapshot: CloudState, connection: OpenHandsConnection): OpenHandsShellState {
  const status: OpenHandsShellState['status'] =
    snapshot.status === 'ready' ? 'ready' : snapshot.status === 'error' ? 'error' : 'connecting';
  const lastError =
    snapshot.lastError ?? (snapshot.status === 'error' ? { op: 'list', message: snapshot.error ?? 'error' } : null);
  return {
    status,
    cached: snapshot.cached,
    sessions: snapshot.sessions,
    folders: snapshot.folders,
    lastError,
    connection,
    capabilities: snapshot.capabilities,
  };
}
