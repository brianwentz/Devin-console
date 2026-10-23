// Pure OpenHands usage model (Analytics -> OpenHands tab + the
// `openhands-quota` usage alert): parsers for the billing / quota / my-usage
// bodies (openhands-research.md §6), card outcomes, backoff and cadence.
// No electron imports — src/main/openhands/usage.ts drives it.

/** Why an endpoint refused us: not signed in (web session) / the stored API key was rejected. */
export type UsageAuthReason = 'login-required' | 'api-key-rejected';

export type Card<T> =
  | { state: 'pending' }
  | { state: 'ok'; value: T; fetchedAt: string }
  | { state: 'unavailable' }
  | { state: 'error'; stale?: T | undefined; reason?: UsageAuthReason | undefined };

export interface OpenHandsQuota {
  percent: number;
  resetsAt: string | null;
}

export interface OpenHandsTopItem {
  id: string;
  title: string;
  cost: number;
}

export interface OpenHandsUsageCards {
  /** `GET /api/billing/credits` — remaining balance (USD). */
  credits: Card<number>;
  /** `GET /api/quota/status` — today's sandbox quota. */
  quota: Card<OpenHandsQuota>;
  /** `GET /api/organizations/{org}/conversations/my-usage?time_window=30d` — total spend. */
  spend30d: Card<number>;
}

export interface OpenHandsUsageState extends OpenHandsUsageCards {
  /** Most expensive listed conversations (`metrics.accumulated_cost`). */
  topByCost: OpenHandsTopItem[];
}

export const OPENHANDS_USAGE_HIDDEN_MS = 15 * 60_000;
export const OPENHANDS_USAGE_VISIBLE_MS = 60_000;
export const OPENHANDS_USAGE_MAX_BACKOFF_MS = 16 * 60_000;
const MIN_BACKOFF_MS = 60_000;
export const OPENHANDS_TOP_LIMIT = 5;

export function emptyOpenHandsUsageState(): OpenHandsUsageState {
  return { credits: { state: 'pending' }, quota: { state: 'pending' }, spend30d: { state: 'pending' }, topByCost: [] };
}

const record = (body: unknown): Record<string, unknown> | null =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `{credits: "12.34"}` (a decimal string) -> 12.34; null / anything else -> null. */
export function parseCredits(body: unknown): number | null {
  const raw = record(body)?.credits;
  if (typeof raw === 'number') return finite(raw);
  if (typeof raw !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return null;
  return Number(raw);
}

/** `{daily_limit, used_today, reset_at}` -> percent of today's quota used; null when unlimited/malformed. */
export function parseQuota(body: unknown): OpenHandsQuota | null {
  const o = record(body);
  const limit = finite(o?.daily_limit);
  const used = finite(o?.used_today);
  if (limit === null || limit <= 0 || used === null || used < 0) return null;
  const reset = o?.reset_at;
  return { percent: (used / limit) * 100, resetsAt: typeof reset === 'string' && reset ? reset : null };
}

/** `OrgMyUsageStats {total_spend, …}` -> `{totalCost}`. */
export function parseMyUsage(body: unknown): { totalCost: number } | null {
  const total = finite(record(body)?.total_spend);
  return total === null ? null : { totalCost: total };
}

/** `GET /api/v1/users/me` -> the current org id (needed by my-usage). */
export function parseOrgId(body: unknown): string | null {
  const id = record(body)?.org_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}

const okValue = <T>(card: Card<T>): T | undefined =>
  card.state === 'ok' ? card.value : card.state === 'error' ? card.stale : undefined;

/** The value a card shows: the fresh one, else the last good one kept by an error. */
export function cardValue<T>(card: Card<T>): T | null {
  return okValue(card) ?? null;
}

/**
 * Next card for one endpoint answer. `status` 0 = no response (network,
 * refused redirect). A 200 whose body does not parse is unavailable — unless a
 * good value is already known: then it is an error keeping that value (schema
 * drift must not blank a card), without backoff. 404/503 = not available on
 * this server (no backoff);
 * 429/5xx/network and 401/403 keep the last good value and back off (a
 * signed-out visible tab must not poll every minute); 401/403 also carry the
 * auth `reason` so the tab can say how to sign in. Any other failure keeps
 * the value without backing off.
 */
export function nextCard<T>(
  prev: Card<T>,
  status: number,
  parsed: T | null,
  fetchedAt: string,
  authReason?: UsageAuthReason,
): { card: Card<T>; retry: boolean } {
  if (status === 200 && parsed !== null) return { card: { state: 'ok', value: parsed, fetchedAt }, retry: false };
  const stale = okValue(prev);
  if (status === 200) {
    return { card: stale === undefined ? { state: 'unavailable' } : { state: 'error', stale }, retry: false };
  }
  if (status === 404 || status === 503) return { card: { state: 'unavailable' }, retry: false };
  const auth = status === 401 || status === 403;
  const card: Card<T> = {
    state: 'error',
    ...(stale === undefined ? {} : { stale }),
    ...(auth && authReason ? { reason: authReason } : {}),
  };
  return { card, retry: auth || status === 0 || status === 429 || status >= 500 };
}

export type UsageAuthHint = 'login-required' | 'api-key-rejected' | 'api-key-required';

/**
 * What the Analytics -> OpenHands tab should ask the user to do, if anything:
 * from the source's connection (Settings status) or an auth-refused card.
 * A rejected key wins over a missing web sign-in.
 */
export function usageAuthHint(cards: OpenHandsUsageCards, connection: string | null | undefined): UsageAuthHint | null {
  const reasons = [cards.credits, cards.quota, cards.spend30d].map((c) => (c.state === 'error' ? c.reason : undefined));
  if (connection === 'api-key-rejected' || reasons.includes('api-key-rejected')) return 'api-key-rejected';
  if (connection === 'api-key-required') return 'api-key-required';
  if (connection === 'login-required' || reasons.includes('login-required')) return 'login-required';
  return null;
}

/** 1 -> 16 min exponential backoff while a retryable failure repeats; 0 after a clean pass. */
export function nextBackoffMs(prev: number, retry: boolean): number {
  if (!retry) return 0;
  return Math.min(Math.max(prev * 2, MIN_BACKOFF_MS), OPENHANDS_USAGE_MAX_BACKOFF_MS);
}

/** Poll delay: 60 s while the tab is visible, else 15 min; a backoff only ever slows it. */
export function usageDelayMs(visible: boolean, backoffMs: number): number {
  return Math.max(visible ? OPENHANDS_USAGE_VISIBLE_MS : OPENHANDS_USAGE_HIDDEN_MS, backoffMs);
}

/** Origin of the base URL — the account key of the quota metric. */
export function usageAccount(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/** The `openhands-quota` alert reading; the period is the reset time, else the UTC day. */
export function quotaReading(
  quota: OpenHandsQuota,
  baseUrl: string,
  nowMs: number,
): { metric: 'openhands-quota'; account: string; percent: number; periodKey: string } {
  return {
    metric: 'openhands-quota',
    account: usageAccount(baseUrl),
    percent: quota.percent,
    periodKey: quota.resetsAt ?? new Date(nowMs).toISOString().slice(0, 10),
  };
}

/** Costed conversations, most expensive first. */
export function topByCost(
  sessions: readonly { id: string; title: string; cost?: number | null | undefined }[],
  limit = OPENHANDS_TOP_LIMIT,
): OpenHandsTopItem[] {
  return sessions
    .filter((s): s is { id: string; title: string; cost: number } => typeof s.cost === 'number' && s.cost > 0)
    .map((s) => ({ id: s.id, title: s.title, cost: s.cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit);
}
