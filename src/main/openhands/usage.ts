// OpenHands usage service: credits, today's sandbox quota and the 30-day spend,
// fetched through the runtime's gated, redirect-safe transport
// (createOpenHandsFetch). Electron-free — the runtime builds one per active
// base URL (runtimeCore `build`), so nothing is fetched while the opt-in gate
// is closed and a base URL change starts from empty cards.
//
// Cadence: 15 min, every 60 s while Analytics -> OpenHands is visible;
// 429/5xx/network and 401/403 (signed out, key rejected) back off 1 -> 16 min. Logs `openhands-usage-fetch
// {endpoint, ok, status}` only — never bodies, org ids or amounts.

import {
  OPENHANDS_USAGE_VISIBLE_MS,
  cardValue,
  emptyOpenHandsUsageState,
  nextBackoffMs,
  nextCard,
  parseCredits,
  parseMyUsage,
  parseOrgId,
  parseQuota,
  quotaReading,
  usageAccount,
  usageDelayMs,
  type Card,
  type OpenHandsUsageCards,
  type UsageAuthReason,
} from '../../core/openhandsUsage';
import { USAGE_METRIC_LABEL } from '../../core/usageAlerts';
import type { UsageReading, UsageSummaryItem } from '../cloudKit/usage';
import type { OpenHandsFetch, OpenHandsFetchResult } from './fetch';

// First poll after the gate opens with the tab hidden (startup must not wait
// on it; the tab itself fetches at once).
const FIRST_POLL_MS = 5_000;

export type UsageEndpoint = 'credits' | 'quota' | 'me' | 'usage';

export interface OpenHandsUsageDeps {
  fetch: OpenHandsFetch;
  baseUrl(): string;
  now(): number;
  /** Analytics -> OpenHands is on screen. */
  visible(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(event: string, detail: Record<string, unknown>): void;
  onChange(): void;
  /** Fresh quota readings (alerts). */
  publish(readings: UsageReading[]): void;
}

export interface OpenHandsUsageService {
  start(): void;
  stop(): void;
  /** One pass over every endpoint (coalesced). */
  refresh(): Promise<void>;
  /** Re-reads `visible()`: fetches at once when it became visible and the last pass is ≥ 60 s old. */
  visibilityChanged(): void;
  /**
   * Credentials changed or the connection became authenticated: drop the
   * backoff and run a pass now (after one already in flight, which used the
   * old credentials). No-op unless running.
   */
  recover(): void;
  cards(): OpenHandsUsageCards;
  summary(): UsageSummaryItem[];
  backoffMs(): number;
}

const fetchedOk = (r: OpenHandsFetchResult): boolean => r.status === 200 && !r.error;

export function createOpenHandsUsageService(deps: OpenHandsUsageDeps): OpenHandsUsageService {
  const empty = emptyOpenHandsUsageState();
  let cards: OpenHandsUsageCards = { credits: empty.credits, quota: empty.quota, spend30d: empty.spend30d };
  let orgId: string | null = null;
  let backoff = 0;
  let timer: unknown = null;
  let running = false;
  // stop() is final: a pass still in flight must not touch cards or alerts.
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastAttempt: number | null = null;

  const clear = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const schedule = (ms: number): void => {
    clear();
    if (!running) return;
    timer = deps.setTimer(() => {
      timer = null;
      void refresh().finally(() => schedule(usageDelayMs(deps.visible(), backoff)));
    }, ms);
  };

  const call = async (endpoint: UsageEndpoint, path: string): Promise<OpenHandsFetchResult> => {
    let result: OpenHandsFetchResult;
    try {
      result = await deps.fetch(path);
    } catch {
      result = { status: 0, body: null, mode: 'web-session', error: 'network' };
    }
    deps.log('openhands-usage-fetch', { endpoint, ok: fetchedOk(result), status: result.status });
    return result;
  };

  // A transport error (refused redirect, network) is "no response".
  const statusOf = (r: OpenHandsFetchResult): number =>
    r.error === 'redirect-refused' || r.error === 'network' ? 0 : r.status;
  // The transport's auth verdict (cards show how to sign in).
  const authOf = (r: OpenHandsFetchResult): UsageAuthReason | undefined =>
    r.error === 'login-required' || r.error === 'api-key-rejected' ? r.error : undefined;

  const spend = async (prev: Card<number>, at: string): Promise<{ card: Card<number>; retry: boolean }> => {
    if (orgId === null) {
      const me = await call('me', '/api/v1/users/me');
      if (statusOf(me) !== 200) return nextCard(prev, statusOf(me), null, at, authOf(me));
      orgId = parseOrgId(me.body);
      // No org on this server/account: there is no my-usage to ask for
      // (unavailable, or an error keeping a spend known before — nextCard).
      if (orgId === null) return nextCard(prev, 200, null, at);
    }
    const r = await call(
      'usage',
      `/api/organizations/${encodeURIComponent(orgId)}/conversations/my-usage?time_window=30d`,
    );
    if (statusOf(r) === 404) orgId = null; // re-resolve next pass (org changed)
    return nextCard(
      prev,
      statusOf(r),
      statusOf(r) === 200 ? (parseMyUsage(r.body)?.totalCost ?? null) : null,
      at,
      authOf(r),
    );
  };

  const run = async (): Promise<void> => {
    lastAttempt = deps.now();
    const at = new Date(deps.now()).toISOString();
    const [c, q, s] = await Promise.all([
      call('credits', '/api/billing/credits'),
      call('quota', '/api/quota/status'),
      spend(cards.spend30d, at),
    ]);
    if (stopped) return;
    const credits = nextCard(
      cards.credits,
      statusOf(c),
      statusOf(c) === 200 ? parseCredits(c.body) : null,
      at,
      authOf(c),
    );
    const quota = nextCard(cards.quota, statusOf(q), statusOf(q) === 200 ? parseQuota(q.body) : null, at, authOf(q));
    cards = { credits: credits.card, quota: quota.card, spend30d: s.card };
    backoff = nextBackoffMs(backoff, credits.retry || quota.retry || s.retry);
    deps.onChange();
    if (quota.card.state === 'ok') {
      const reading = quotaReading(quota.card.value, deps.baseUrl(), deps.now());
      deps.publish([
        {
          ...reading,
          stale: false,
          body: `${Math.round(reading.percent)}% of today's OpenHands sandbox quota used`,
        },
      ]);
    }
  };

  const refresh = (): Promise<void> =>
    (inFlight ??= run().finally(() => {
      inFlight = null;
    }));

  return {
    start() {
      if (running || stopped) return;
      running = true;
      if (deps.visible()) {
        void refresh().finally(() => schedule(usageDelayMs(deps.visible(), backoff)));
      } else {
        schedule(FIRST_POLL_MS);
      }
    },
    stop() {
      running = false;
      stopped = true;
      clear();
    },
    refresh,
    recover() {
      if (!running) return;
      clear();
      backoff = 0;
      const pass = inFlight
        ? inFlight.then(() => {
            backoff = 0;
            return refresh();
          })
        : refresh();
      void pass.finally(() => schedule(usageDelayMs(deps.visible(), backoff)));
    },
    visibilityChanged() {
      if (!running) return;
      const due = lastAttempt === null || deps.now() - lastAttempt >= OPENHANDS_USAGE_VISIBLE_MS;
      if (deps.visible() && due) {
        clear();
        void refresh().finally(() => schedule(usageDelayMs(deps.visible(), backoff)));
        return;
      }
      schedule(usageDelayMs(deps.visible(), backoff));
    },
    cards: () => cards,
    summary() {
      const quota = cardValue(cards.quota);
      if (!quota) return [];
      return [
        {
          metric: 'openhands-quota',
          accountKey: usageAccount(deps.baseUrl()),
          label: USAGE_METRIC_LABEL['openhands-quota'],
          percent: quota.percent,
        },
      ];
    },
    backoffMs: () => backoff,
  };
}
