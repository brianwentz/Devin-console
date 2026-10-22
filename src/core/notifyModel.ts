import type { DevinSession } from './devinApi';
import type { ProviderSource } from './providers';

export const ACTIVE_POLL_MS = 10_000;
export const IDLE_POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

// Statuses that mean Devin is busy and the user is likely to be waited on soon.
const ACTIVE_STATUSES = new Set(['new', 'claimed', 'running', 'resuming', 'working']);
// Status / status_detail values that mean the user must act.
const WAITING_DETAILS = new Set(['waiting_for_user', 'waiting_for_approval', 'blocked']);

export function effectiveStatus(session: Pick<DevinSession, 'status' | 'status_detail'>): string {
  const detail = (session.status_detail ?? '').toLowerCase();
  const status = (session.status ?? '').toLowerCase();
  if (WAITING_DETAILS.has(detail)) return detail;
  if (WAITING_DETAILS.has(status)) return status;
  // A finished-but-still-"running" session is not active for polling purposes.
  if (status === 'running' && detail === 'finished') return 'finished';
  return status;
}

export function isWaiting(session: Pick<DevinSession, 'status' | 'status_detail'>): boolean {
  return WAITING_DETAILS.has(effectiveStatus(session));
}

export function isActive(session: Pick<DevinSession, 'status' | 'status_detail'>): boolean {
  const key = effectiveStatus(session);
  return ACTIVE_STATUSES.has(key) && !WAITING_DETAILS.has(key);
}

// P8/Q3: which previously-seen session scopes should have their tabs closed.
// `archived` is explicit; `missing` only counts when the polled list was
// complete (no next page) — otherwise absence just means it fell off page 1.
export function archivedScopes(
  previous: readonly DevinSession[],
  next: readonly DevinSession[],
  listComplete: boolean,
): string[] {
  const out: string[] = [];
  for (const before of previous) {
    const after = next.find((item) => item.session_id === before.session_id);
    if (after?.status === 'archived' || (!after && listComplete)) out.push(before.session_id);
  }
  return out;
}

// F10: label for a scope in the strip overflow menu — the session title
// (truncated) when known, else a short id form; GLOBAL reads plainly.
export function scopeLabel(scope: string, sessions: readonly DevinSession[]): string {
  if (scope === '') return 'Outside any session';
  const title = sessions.find((s) => s.session_id === scope)?.title;
  if (title) return title.length > 60 ? `${title.slice(0, 60)}…` : title;
  return `Session ${scope.slice(0, 8)}`;
}

export function pollInterval(sessions: DevinSession[], base = { active: ACTIVE_POLL_MS, idle: IDLE_POLL_MS }): number {
  return sessions.some(isActive) ? base.active : base.idle;
}

// Exponential backoff for consecutive failures, capped.
export function backoffMs(failures: number, baseMs: number): number {
  const factor = 2 ** Math.max(0, Math.min(failures - 1, 10));
  return Math.min(MAX_BACKOFF_MS, baseMs * factor);
}

export interface SessionPrLink {
  sessionId: string;
  sessionTitle: string;
  ref: string;
  url: string;
  state: string | null;
  // Which agent the PR belongs to; absent = Devin (API poller).
  source?: ProviderSource | undefined;
}

// "owner/repo#123" for GitHub PR URLs, otherwise the URL host+path.
export function prTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(parsed.pathname);
    if (match) return `${match[1]}/${match[2]}#${match[3]}`;
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function truncateTitle(title: string, max = 64): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

export function prMenuLabel(ref: string, title: string | null): string {
  return title ? `${ref}  ${truncateTitle(title)}` : ref;
}

// Open PRs across all sessions, sessions sorted by updated_at desc (archived
// excluded). A PR counts as open when pr_state is 'open' or null.
export function openPullRequests(sessions: readonly DevinSession[]): SessionPrLink[] {
  const sorted = [...sessions]
    .filter((session) => session.status !== 'archived')
    .sort((a, b) => b.updated_at - a.updated_at);
  const out: SessionPrLink[] = [];
  for (const session of sorted) {
    for (const pr of session.pull_requests) {
      if (pr.pr_state !== 'open' && pr.pr_state !== null) continue;
      out.push({
        sessionId: session.session_id,
        sessionTitle: session.title?.trim() || session.session_id,
        ref: prTitle(pr.pr_url),
        url: pr.pr_url,
        state: pr.pr_state,
      });
    }
  }
  return out;
}

export interface NewPullRequest {
  sessionId: string;
  url: string;
}

// F1: PR URLs that appeared on a session between two polls. Only sessions
// already present in `previous` count — sessions first seen in `next` are a
// baseline, so the first poll (and the first after a restart, which clears the
// cached list) opens nothing. A PR URL the user already saw (and maybe closed)
// is in `previous`, so it never comes back. URLs are deduped within the result.
export function newPullRequests(
  previous: readonly DevinSession[],
  next: readonly DevinSession[],
): NewPullRequest[] {
  const out: NewPullRequest[] = [];
  const seen = new Set<string>();
  for (const before of previous) {
    const after = next.find((item) => item.session_id === before.session_id);
    // An archived session's scope is being closed by the same poll — never open into it.
    if (!after || after.status === 'archived') continue;
    const known = new Set(before.pull_requests.map((pr) => pr.pr_url));
    for (const pr of after.pull_requests) {
      if (known.has(pr.pr_url) || seen.has(pr.pr_url)) continue;
      seen.add(pr.pr_url);
      out.push({ sessionId: after.session_id, url: pr.pr_url });
    }
  }
  return out;
}

export const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60_000;
export const CATCH_UP_LIMIT = 10;

// PRs present on non-archived sessions that were never seen by any earlier
// successful poll (persisted ledger) — used on a baseline poll (empty
// `previous`) so an outage or restart doesn't swallow new PRs. Only when the
// ledger is recent (lastGoodAt within maxAgeMs); open/null state only;
// sessions by updated_at desc; capped.
export function catchUpPullRequests(
  sessions: readonly DevinSession[],
  seen: ReadonlySet<string>,
  opts: { lastGoodAt: number; now: number; maxAgeMs?: number; limit?: number },
): NewPullRequest[] {
  const maxAgeMs = opts.maxAgeMs ?? CATCH_UP_MAX_AGE_MS;
  const limit = opts.limit ?? CATCH_UP_LIMIT;
  if (opts.lastGoodAt <= 0 || opts.now - opts.lastGoodAt > maxAgeMs) return [];
  const sorted = [...sessions]
    .filter((session) => session.status !== 'archived')
    .sort((a, b) => b.updated_at - a.updated_at);
  const out: NewPullRequest[] = [];
  const emitted = new Set<string>();
  for (const session of sorted) {
    for (const pr of session.pull_requests) {
      if (pr.pr_state !== 'open' && pr.pr_state !== null) continue;
      if (seen.has(pr.pr_url) || emitted.has(pr.pr_url)) continue;
      emitted.add(pr.pr_url);
      out.push({ sessionId: session.session_id, url: pr.pr_url });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

