// Pure OpenHands Cloud (REST /api/v1) model: URL helpers, tolerant conversation
// parsing, status mapping, PR urls, polling cursor and transition detection.
// No electron imports.
import { z } from 'zod';
import type { CloudSessionState } from '../shared/ipc';

export type OhStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'finished' | 'error' | 'paused';

export interface OhRow {
  id: string;
  title: string;
  updatedAt: number;
  status: OhStatus;
  section: string;
  repo: string | null;
  gitProvider: string | null;
  prUrls: string[];
  cost: number | null;
}

export const UNTITLED = 'Untitled conversation';
export const NO_REPOSITORY = 'No repository';
const CONVERSATION_ID_RE = /\/conversations\/([0-9a-f]{32})(?:[/?#]|$)/;
const REPO_RE = /^[\w.-]+(\/[\w.-]+)+$/;
const CURSOR_OVERLAP_MS = 5000;

export function normalizeBaseUrl(raw: string, allowHttp = false): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The base URL the app talks to: a test-mode override (AGENT_WORKSPACE_TEST_OPENHANDS_URL,
// http allowed for loopback only) wins over the saved setting; an unusable
// override falls back to the saved value.
export function effectiveBaseUrl(saved: string, override: string | undefined): string {
  if (!override) return saved;
  let loopback = false;
  try {
    loopback = LOOPBACK_HOSTS.has(new URL(override.trim()).hostname);
  } catch {
    return saved;
  }
  return normalizeBaseUrl(override, loopback) ?? saved;
}

export function apiUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return `${b}${p}${qs ? `?${qs}` : ''}`;
}

export function conversationUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/conversations/${id}`;
}

export function conversationIdFromUrl(base: string, url: string, pattern: RegExp = CONVERSATION_ID_RE): string | null {
  const b = base.replace(/\/+$/, '');
  if (url !== b && !url.startsWith(`${b}/`)) return null;
  // Never reuse a caller's global/sticky regex: lastIndex state would leak between calls.
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  const m = re.exec(url.slice(b.length));
  return m?.[1] ?? null;
}

export const OhConversationSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    selected_repository: z.string().nullish(),
    git_provider: z.string().nullish(),
    pr_number: z.array(z.number().int()).nullish(),
    sandbox_status: z.string().nullish(),
    execution_status: z.string().nullish(),
    updated_at: z.string().nullish(),
    created_at: z.string().nullish(),
    metrics: z.object({ accumulated_cost: z.number().finite().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export function mapStatus(sandbox: string | null | undefined, execution: string | null | undefined): OhStatus {
  switch ((sandbox ?? '').toUpperCase()) {
    case 'STARTING':
      return 'starting';
    case 'ERROR':
      return 'error';
    case 'RUNNING':
      switch ((execution ?? '').toLowerCase()) {
        case 'waiting_for_confirmation':
          return 'waiting';
        case 'stuck':
        case 'error':
          return 'error';
        case 'finished':
          return 'finished';
        case 'idle':
          return 'idle';
        case 'paused':
          return 'paused';
        default:
          return 'running';
      }
    default:
      return 'paused';
  }
}

export function prUrl(gitProvider: string | null | undefined, repo: string | null | undefined, n: number): string | null {
  if (!repo || !REPO_RE.test(repo) || repo.split('/').some((x) => x === '.' || x === '..')) return null;
  if (!Number.isInteger(n) || n <= 0) return null;
  switch (gitProvider) {
    case 'github':
      return `https://github.com/${repo}/pull/${n}`;
    case 'gitlab':
      return `https://gitlab.com/${repo}/-/merge_requests/${n}`;
    case 'bitbucket':
      return `https://bitbucket.org/${repo}/pull-requests/${n}`;
    default:
      return null;
  }
}

// OpenHands timestamps may omit the zone; treat those as UTC.
function parseTime(s: string | null | undefined): number {
  if (!s) return 0;
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : 0;
}

function toRow(c: z.infer<typeof OhConversationSchema>): OhRow {
  const repo = c.selected_repository || null;
  const gitProvider = c.git_provider || null;
  const prUrls: string[] = [];
  for (const n of c.pr_number ?? []) {
    const u = prUrl(gitProvider, repo, n);
    if (u) prUrls.push(u);
  }
  const cost = c.metrics?.accumulated_cost;
  return {
    id: c.id,
    title: c.title?.trim() || UNTITLED,
    updatedAt: parseTime(c.updated_at) || parseTime(c.created_at),
    status: mapStatus(c.sandbox_status, c.execution_status),
    section: repo ?? NO_REPOSITORY,
    repo,
    gitProvider,
    prUrls,
    cost: typeof cost === 'number' ? cost : null,
  };
}

export function parseSearchPage(json: unknown): { items: OhRow[]; nextPageId: string | null } {
  const empty = { items: [], nextPageId: null };
  if (!json || typeof json !== 'object') return empty;
  const o = json as { items?: unknown; next_page_id?: unknown };
  if (!Array.isArray(o.items)) return empty;
  const items: OhRow[] = [];
  for (const raw of o.items) {
    const r = OhConversationSchema.safeParse(raw);
    if (r.success) items.push(toRow(r.data));
  }
  return { items, nextPageId: typeof o.next_page_id === 'string' && o.next_page_id ? o.next_page_id : null };
}

export class PagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PagingError';
  }
}

export async function listAllPages<T>(
  fetchPage: (pageId: string | null) => Promise<{ items: T[]; nextPageId: string | null }>,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let pageId: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) throw new PagingError(`more than ${maxPages} pages`);
    const page = await fetchPage(pageId);
    out.push(...page.items);
    if (page.nextPageId === null) return out;
    if (seen.has(page.nextPageId)) throw new PagingError('repeated page id');
    seen.add(page.nextPageId);
    pageId = page.nextPageId;
  }
}

export function nextCursor(rows: OhRow[], prev: number | null): number | null {
  // Rows with unparseable dates carry updatedAt 0 and must not move the cursor.
  const newest = rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0);
  if (newest <= 0) return prev;
  const next = Math.max(0, newest - CURSOR_OVERLAP_MS);
  return prev === null ? next : Math.max(prev, next);
}

export function mergeRows(prev: OhRow[], incoming: OhRow[]): OhRow[] {
  const byId = new Map<string, OhRow>();
  for (const r of prev) byId.set(r.id, r);
  for (const r of incoming) {
    const cur = byId.get(r.id);
    if (!cur || r.updatedAt >= cur.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function statusTransitions(
  prev: Map<string, OhStatus>,
  next: OhRow[],
): { id: string; kind: 'finished' | 'waiting' | 'blocked' }[] {
  const out: { id: string; kind: 'finished' | 'waiting' | 'blocked' }[] = [];
  for (const r of next) {
    const before = prev.get(r.id);
    if (before === undefined || before === r.status) continue;
    if (r.status === 'finished') out.push({ id: r.id, kind: 'finished' });
    else if (r.status === 'waiting') out.push({ id: r.id, kind: 'waiting' });
    else if (r.status === 'error') out.push({ id: r.id, kind: 'blocked' });
  }
  return out;
}

export function toCloudSession(row: OhRow, baseUrl: string): CloudSessionState {
  return {
    id: row.id,
    acpId: row.id,
    title: row.title,
    url: conversationUrl(baseUrl, row.id),
    status: row.status,
    statusEnum: row.status,
    userActionRequired: row.status === 'waiting' ? 'confirmation' : null,
    folder: null,
    parentId: null,
    isPinned: false,
    isUnread: false,
    isStarred: false,
    directChildrenCount: 0,
    hasMoreChildren: false,
    // PR state is unknown at this layer, so every known PR counts as open.
    prs: { open: row.prUrls.length, queued: 0, draft: 0, merged: 0, closed: 0 },
    isArchived: false,
    updatedAt: row.updatedAt,
    section: row.section,
    cost: row.cost,
  };
}

// --- hosted view pool keying + ownership (src/main/openhands/views.ts) -------

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// True only for URLs on the base URL's origin (scheme + host + port).
export function openhandsOwnsUrl(url: string, baseUrl: string): boolean {
  const parsed = parseUrl(url);
  const base = parseUrl(baseUrl);
  return !!parsed && !!base && parsed.origin === base.origin;
}

// Pool key for a URL: the conversation id for `<base>/conversations/<id>`,
// 'home' for any other page on the origin, null for a foreign origin (or an
// unparseable URL).
export function openhandsViewKey(url: string, baseUrl: string): string | null {
  const parsed = parseUrl(url);
  const base = parseUrl(baseUrl);
  if (!parsed || !base || parsed.origin !== base.origin) return null;
  return conversationIdFromUrl(base.href, parsed.href) ?? 'home';
}

// --- auth origins (link routing) --------------------------------------------
//
// Login hops an OpenHands view may follow in place. RESEARCH-DERIVED defaults,
// not yet confirmed against a live session: run `npm run openhands:probe`
// (B0) and update this list from its evidence before merging.

export const OPENHANDS_IDP_AUTH_ORIGINS: readonly string[] = [
  'https://github.com/login',
  'https://github.com/sessions',
  'https://gitlab.com/oauth',
  'https://gitlab.com/users/sign_in',
  'https://bitbucket.org/site/oauth2',
  'https://bitbucket.org/account/signin',
];

const ALL_HANDS_APP_HOST = 'app.all-hands.dev';
const ALL_HANDS_AUTH_ORIGINS: readonly string[] = [
  'https://auth.app.all-hands.dev',
  'https://auth.all-hands.dev',
];

// Prefixes (origin, optionally + path) for `RouteProvider.authOrigins`:
// the hosted service's own auth hosts when `baseUrl` is app.all-hands.dev,
// then the git IdPs. `extra` (test mode fixture origins) is appended.
export function openHandsAuthOrigins(baseUrl: string, extra: readonly string[] = []): string[] {
  const base = parseUrl(baseUrl);
  const own = base?.hostname.toLowerCase() === ALL_HANDS_APP_HOST ? ALL_HANDS_AUTH_ORIGINS : [];
  return [...new Set([...own, ...OPENHANDS_IDP_AUTH_ORIGINS, ...extra])];
}

// `AGENT_WORKSPACE_TEST_OPENHANDS_AUTH_ORIGIN`: comma-separated http(s) origins/prefixes.
export function parseExtraAuthOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      const url = parseUrl(part);
      return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
    });
}

// --- sidebar context menu (src/main/openhands/contextMenu.ts) ---------------

export type OpenHandsMenuId =
  | 'new-session'
  | 'refresh'
  | 'rename'
  | 'copy-id'
  | 'open-in-browser'
  | 'delete';
export type OpenHandsMenuEntry = { id: OpenHandsMenuId; label: string } | 'separator';

// The items a native menu offers, gated by what the source advertises.
export function openhandsMenuEntries(
  kind: 'session' | 'header',
  caps: { rename: boolean; delete: boolean },
): OpenHandsMenuEntry[] {
  if (kind === 'header') {
    return [
      { id: 'new-session', label: 'New session' },
      { id: 'refresh', label: 'Refresh' },
    ];
  }
  const entries: OpenHandsMenuEntry[] = [];
  if (caps.rename) entries.push({ id: 'rename', label: 'Rename…' });
  entries.push(
    { id: 'copy-id', label: 'Copy session ID' },
    { id: 'open-in-browser', label: 'Open in browser' },
  );
  if (caps.delete) entries.push('separator', { id: 'delete', label: 'Delete…' });
  return entries;
}

// Sidebar status line for the states the generic Devin-worded text does not
// fit; undefined = use the default ('Connecting…', 'synced …').
export function openhandsStatusLine(
  status: 'idle' | 'connecting' | 'ready' | 'error',
  connection: string,
): string | undefined {
  if (status === 'idle') return 'Not connected yet';
  if (status !== 'error') return undefined;
  switch (connection) {
    case 'login-required':
      return 'Sign in to OpenHands to load sessions';
    case 'api-key-required':
      return 'OpenHands needs an API key to load sessions';
    case 'api-key-rejected':
      return 'OpenHands rejected the API key';
    default:
      return "Couldn't load OpenHands sessions";
  }
}

// A renderer-supplied id is only trusted when the conversation URL rebuilt
// from it parses back to the same id (rejects '../x', 'a/b', '?'/'#' tricks).
export function isConversationId(base: string, id: string): boolean {
  return conversationIdFromUrl(base, conversationUrl(base, id)) === id;
}
