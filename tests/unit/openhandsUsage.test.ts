import { describe, expect, it, vi } from 'vitest';
import {
  OPENHANDS_USAGE_HIDDEN_MS,
  OPENHANDS_USAGE_VISIBLE_MS,
  nextBackoffMs,
  nextCard,
  parseCredits,
  parseMyUsage,
  parseOrgId,
  parseQuota,
  quotaReading,
  topByCost,
  usageAuthHint,
  usageDelayMs,
  type Card,
  type OpenHandsUsageCards,
} from '../../src/core/openhandsUsage';
import { createOpenHandsUsageService } from '../../src/main/openhands/usage';
import type { OpenHandsFetchResult } from '../../src/main/openhands/fetch';
import type { UsageReading } from '../../src/main/cloudKit/usage';
import type { OpenHandsConnection } from '../../src/shared/ipc';
import {
  createOpenHandsRuntimeCore,
  type CoreController,
  type CoreUsage,
} from '../../src/main/openhands/runtimeCore';

// Research-shaped bodies (openhands-research.md §6), as the e2e fixture serves them.
const QUOTA_BODY = {
  daily_limit: 10,
  used_today: 3,
  remaining: 7,
  reset_at: '2026-10-24T00:00:00Z',
  work_email: null,
  work_email_verified: false,
  latest_request_status: null,
  latest_request_requested_limit: null,
};
const MY_USAGE_BODY = { total_spend: 4.2, previous_period_spend: 1.1, daily_spend: [], model_usage: [], recent_usage: [] };
const FETCHED = '2026-10-23T10:00:00.000Z';

describe('openhands usage parsers', () => {
  it('parseCredits: decimal string -> number, anything else -> null', () => {
    expect(parseCredits({ credits: '12.34' })).toBe(12.34);
    expect(parseCredits({ credits: 'x' })).toBeNull();
    expect(parseCredits({ credits: null })).toBeNull();
    expect(parseCredits({ credits: '' })).toBeNull();
    expect(parseCredits(null)).toBeNull();
    expect(parseCredits({ credits: '-1' })).toBe(-1);
  });

  it('parseQuota: used_today / daily_limit as a percent, reset_at kept', () => {
    expect(parseQuota(QUOTA_BODY)).toEqual({ percent: 30, resetsAt: '2026-10-24T00:00:00Z' });
    expect(parseQuota({ ...QUOTA_BODY, used_today: 17, daily_limit: 20, reset_at: null })).toEqual({
      percent: 85,
      resetsAt: null,
    });
    // No daily limit (unlimited) or a malformed body -> nothing to show.
    expect(parseQuota({ ...QUOTA_BODY, daily_limit: null })).toBeNull();
    expect(parseQuota({ ...QUOTA_BODY, daily_limit: 0 })).toBeNull();
    expect(parseQuota({ used: 3, limit: 10 })).toBeNull();
  });

  it('parseMyUsage / parseOrgId', () => {
    expect(parseMyUsage(MY_USAGE_BODY)).toEqual({ totalCost: 4.2 });
    expect(parseMyUsage({ total_spend: 'x' })).toBeNull();
    expect(parseOrgId({ org_id: 'org-1', org_name: 'Acme' })).toBe('org-1');
    expect(parseOrgId({ org_id: null })).toBeNull();
    expect(parseOrgId({ org_id: '' })).toBeNull();
  });
});

describe('openhands usage cards', () => {
  const ok: Card<number> = { state: 'ok', value: 5, fetchedAt: FETCHED };

  it('200 + parsed value -> ok; 200 + nothing parsed -> unavailable when no value is known', () => {
    expect(nextCard<number>({ state: 'pending' }, 200, 12.34, FETCHED)).toEqual({
      card: { state: 'ok', value: 12.34, fetchedAt: FETCHED },
      retry: false,
    });
    expect(nextCard<number>({ state: 'pending' }, 200, null, FETCHED)).toEqual({
      card: { state: 'unavailable' },
      retry: false,
    });
    expect(nextCard<number>({ state: 'unavailable' }, 200, null, FETCHED)).toEqual({
      card: { state: 'unavailable' },
      retry: false,
    });
  });

  it('200 + nothing parsed keeps a known value as stale (error), without backoff', () => {
    expect(nextCard<number>(ok, 200, null, FETCHED)).toEqual({ card: { state: 'error', stale: 5 }, retry: false });
    // A stale value carried by an earlier error survives too.
    expect(nextCard<number>({ state: 'error', stale: 5 }, 200, null, FETCHED)).toEqual({
      card: { state: 'error', stale: 5 },
      retry: false,
    });
  });

  it('503 and 404 -> unavailable, no backoff', () => {
    expect(nextCard<number>(ok, 503, null, FETCHED)).toEqual({ card: { state: 'unavailable' }, retry: false });
    expect(nextCard<number>(ok, 404, null, FETCHED)).toEqual({ card: { state: 'unavailable' }, retry: false });
  });

  it('429 / 5xx / network keep the last good value as stale and back off', () => {
    expect(nextCard<number>(ok, 429, null, FETCHED)).toEqual({ card: { state: 'error', stale: 5 }, retry: true });
    expect(nextCard<number>(ok, 500, null, FETCHED)).toEqual({ card: { state: 'error', stale: 5 }, retry: true });
    expect(nextCard<number>(ok, 0, null, FETCHED)).toEqual({ card: { state: 'error', stale: 5 }, retry: true });
    // A second failure keeps the stale value.
    expect(nextCard<number>({ state: 'error', stale: 5 }, 502, null, FETCHED).card).toEqual({
      state: 'error',
      stale: 5,
    });
    expect(nextCard<number>({ state: 'pending' }, 500, null, FETCHED).card).toEqual({ state: 'error' });
  });

  it('401/403 -> error with stale and the auth reason, backing off', () => {
    expect(nextCard<number>(ok, 401, null, FETCHED, 'login-required')).toEqual({
      card: { state: 'error', stale: 5, reason: 'login-required' },
      retry: true,
    });
    expect(nextCard<number>({ state: 'pending' }, 403, null, FETCHED, 'api-key-rejected')).toEqual({
      card: { state: 'error', reason: 'api-key-rejected' },
      retry: true,
    });
    // No transport verdict: still an error that backs off, without a reason.
    expect(nextCard<number>(ok, 401, null, FETCHED)).toEqual({ card: { state: 'error', stale: 5 }, retry: true });
    // A reason only rides an auth status.
    expect(nextCard<number>(ok, 500, null, FETCHED, 'login-required')).toEqual({
      card: { state: 'error', stale: 5 },
      retry: true,
    });
  });

  it('usageAuthHint: connection or an auth-refused card; a rejected key wins', () => {
    const pending: OpenHandsUsageCards = {
      credits: { state: 'pending' },
      quota: { state: 'pending' },
      spend30d: { state: 'pending' },
    };
    const refused = (reason: 'login-required' | 'api-key-rejected'): OpenHandsUsageCards => ({
      ...pending,
      quota: { state: 'error', reason },
    });
    expect(usageAuthHint(pending, 'web-session')).toBeNull();
    expect(usageAuthHint(pending, null)).toBeNull();
    expect(usageAuthHint(pending, 'login-required')).toBe('login-required');
    expect(usageAuthHint(pending, 'api-key-required')).toBe('api-key-required');
    expect(usageAuthHint(pending, 'api-key-rejected')).toBe('api-key-rejected');
    expect(usageAuthHint(refused('login-required'), 'idle')).toBe('login-required');
    expect(usageAuthHint(refused('api-key-rejected'), 'login-required')).toBe('api-key-rejected');
    // A plain 5xx error is not a sign-in problem.
    expect(usageAuthHint({ ...pending, credits: { state: 'error' } }, 'error')).toBeNull();
  });

  it('usageAuthHint: a healthy live connection hides a stale card auth reason', () => {
    const refused = (reason: 'login-required' | 'api-key-rejected'): OpenHandsUsageCards => ({
      credits: { state: 'error', reason },
      quota: { state: 'error', reason, stale: { percent: 30, resetsAt: null } },
      spend30d: { state: 'pending' },
    });
    expect(usageAuthHint(refused('api-key-rejected'), 'api-key')).toBeNull();
    expect(usageAuthHint(refused('api-key-rejected'), 'web-session')).toBeNull();
    expect(usageAuthHint(refused('login-required'), 'web-session')).toBeNull();
    expect(usageAuthHint(refused('login-required'), 'api-key')).toBeNull();
    // Not yet known to be healthy: the card reason still speaks.
    expect(usageAuthHint(refused('login-required'), 'idle')).toBe('login-required');
    expect(usageAuthHint(refused('api-key-rejected'), 'error')).toBe('api-key-rejected');
  });

  it('backoff 1 -> 16 min, reset on success; delay = max(cadence, backoff)', () => {
    expect(nextBackoffMs(0, true)).toBe(60_000);
    expect(nextBackoffMs(60_000, true)).toBe(120_000);
    expect(nextBackoffMs(16 * 60_000, true)).toBe(16 * 60_000);
    expect(nextBackoffMs(8 * 60_000, false)).toBe(0);
    expect(OPENHANDS_USAGE_HIDDEN_MS).toBe(15 * 60_000);
    expect(OPENHANDS_USAGE_VISIBLE_MS).toBe(60_000);
    expect(usageDelayMs(false, 0)).toBe(15 * 60_000);
    expect(usageDelayMs(true, 0)).toBe(60_000);
    expect(usageDelayMs(true, 4 * 60_000)).toBe(4 * 60_000);
    expect(usageDelayMs(false, 60_000)).toBe(15 * 60_000);
  });

  it('quota reading: base origin account, resetsAt or the UTC date as period', () => {
    const now = Date.parse('2026-10-23T23:30:00-05:00'); // 2026-10-24 UTC
    expect(quotaReading({ percent: 85, resetsAt: null }, 'https://app.all-hands.dev/', now)).toEqual({
      metric: 'openhands-quota',
      account: 'https://app.all-hands.dev',
      percent: 85,
      periodKey: '2026-10-24',
    });
    expect(quotaReading({ percent: 30, resetsAt: '2026-10-24T00:00:00Z' }, 'http://127.0.0.1:9/x', now).periodKey).toBe(
      '2026-10-24T00:00:00Z',
    );
  });

  it('topByCost: costed sessions, highest first, capped', () => {
    const rows = [
      { id: 'a', title: 'A', cost: 0.42 },
      { id: 'b', title: 'B', cost: 1.5 },
      { id: 'c', title: 'C', cost: null },
    ];
    expect(topByCost(rows)).toEqual([
      { id: 'b', title: 'B', cost: 1.5 },
      { id: 'a', title: 'A', cost: 0.42 },
    ]);
    expect(topByCost(rows, 1)).toHaveLength(1);
  });
});

type Responder = (path: string) => OpenHandsFetchResult | Promise<OpenHandsFetchResult>;
const answer = (status: number, body: unknown = null): OpenHandsFetchResult => ({ status, body, mode: 'api-key' });

function serviceHarness(respond: Responder, opts: { visible?: boolean } = {}) {
  let visible = opts.visible ?? false;
  let now = Date.parse(FETCHED);
  const paths: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const published: UsageReading[][] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  let changes = 0;
  const service = createOpenHandsUsageService({
    fetch: vi.fn(async (path: string) => {
      paths.push(path);
      return respond(path);
    }),
    baseUrl: () => 'https://oh.test/',
    now: () => now,
    visible: () => visible,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    log: (event, detail) => logs.push({ event, detail }),
    onChange: () => {
      changes += 1;
    },
    publish: (readings) => published.push(readings),
  });
  return {
    service,
    paths,
    timers,
    published,
    logs,
    changes: () => changes,
    live: () => timers.filter((t) => !t.cleared),
    setVisible: (v: boolean) => (visible = v),
    advance: (ms: number) => (now += ms),
  };
}

const happy: Responder = (path) => {
  if (path === '/api/billing/credits') return answer(200, { credits: '12.34' });
  if (path === '/api/quota/status') return answer(200, QUOTA_BODY);
  if (path === '/api/v1/users/me') return answer(200, { org_id: 'org-1' });
  if (path.startsWith('/api/organizations/org-1/conversations/my-usage')) return answer(200, MY_USAGE_BODY);
  return answer(404);
};

describe('openhands usage service', () => {
  it('fetches credits, quota, the org and its 30 d spend; publishes the quota reading', async () => {
    const h = serviceHarness(happy);
    await h.service.refresh();
    expect(h.paths).toEqual(
      expect.arrayContaining([
        '/api/billing/credits',
        '/api/quota/status',
        '/api/v1/users/me',
        '/api/organizations/org-1/conversations/my-usage?time_window=30d',
      ]),
    );
    const cards = h.service.cards();
    expect(cards.credits).toEqual({ state: 'ok', value: 12.34, fetchedAt: FETCHED });
    expect(cards.quota).toMatchObject({ state: 'ok', value: { percent: 30, resetsAt: '2026-10-24T00:00:00Z' } });
    expect(cards.spend30d).toMatchObject({ state: 'ok', value: 4.2 });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toEqual([
      expect.objectContaining({
        metric: 'openhands-quota',
        account: 'https://oh.test',
        percent: 30,
        periodKey: '2026-10-24T00:00:00Z',
        stale: false,
      }),
    ]);
    expect(h.service.summary()).toEqual([
      { metric: 'openhands-quota', accountKey: 'https://oh.test', label: 'OpenHands daily quota', percent: 30 },
    ]);
    // Logs carry the endpoint name, ok and status only.
    for (const entry of h.logs) {
      expect(entry.event).toBe('openhands-usage-fetch');
      expect(Object.keys(entry.detail).sort()).toEqual(['endpoint', 'ok', 'status']);
    }
    expect(h.logs.map((l) => l.detail.endpoint).sort()).toEqual(['credits', 'me', 'quota', 'usage']);
  });

  it('a 503 credits answer is unavailable with no backoff', async () => {
    const h = serviceHarness((p) => (p === '/api/billing/credits' ? answer(503) : happy(p)));
    h.service.start();
    await h.service.refresh();
    expect(h.service.cards().credits).toEqual({ state: 'unavailable' });
    expect(h.service.backoffMs()).toBe(0);
  });

  it('no org id -> spend unavailable, my-usage never requested', async () => {
    const h = serviceHarness((p) => (p === '/api/v1/users/me' ? answer(200, { org_id: null }) : happy(p)));
    await h.service.refresh();
    expect(h.service.cards().spend30d).toEqual({ state: 'unavailable' });
    expect(h.paths.some((p) => p.includes('my-usage'))).toBe(false);
  });

  it('429 keeps the last good quota as stale, backs off and publishes nothing new', async () => {
    let quotaStatus = 200;
    const h = serviceHarness((p) => (p === '/api/quota/status' ? answer(quotaStatus, QUOTA_BODY) : happy(p)));
    await h.service.refresh();
    quotaStatus = 429;
    await h.service.refresh();
    expect(h.service.cards().quota).toEqual({ state: 'error', stale: { percent: 30, resetsAt: '2026-10-24T00:00:00Z' } });
    expect(h.service.backoffMs()).toBe(60_000);
    expect(h.published).toHaveLength(1);
    // The summary keeps the stale percent (rail badge does not flicker).
    expect(h.service.summary()[0]?.percent).toBe(30);
  });

  it('a 200 with an unparseable body keeps the known credits / quota / spend as stale, no backoff', async () => {
    let broken = false;
    const h = serviceHarness((p) => {
      if (!broken) return happy(p);
      if (p === '/api/billing/credits') return answer(200, { credits: 'n/a' });
      if (p === '/api/quota/status') return answer(200, { nope: true });
      if (p.includes('my-usage')) return answer(200, { total_spend: 'x' });
      return happy(p);
    });
    await h.service.refresh();
    broken = true;
    await h.service.refresh();
    expect(h.service.cards()).toEqual({
      credits: { state: 'error', stale: 12.34 },
      quota: { state: 'error', stale: { percent: 30, resetsAt: '2026-10-24T00:00:00Z' } },
      spend30d: { state: 'error', stale: 4.2 },
    });
    expect(h.service.backoffMs()).toBe(0);
    // The kept quota is not re-published as a fresh reading.
    expect(h.published).toHaveLength(1);
  });

  it('a thrown fetch is no response: error keeping the last good value, logged as status 0, backs off', async () => {
    let down = false;
    const h = serviceHarness((p) => {
      if (down && p === '/api/billing/credits') throw new Error('ECONNRESET');
      return happy(p);
    });
    await h.service.refresh();
    down = true;
    await h.service.refresh();
    expect(h.service.cards().credits).toEqual({ state: 'error', stale: 12.34 });
    expect(h.service.cards().quota.state).toBe('ok');
    expect(h.service.backoffMs()).toBe(60_000);
    expect(h.logs.filter((l) => l.detail.endpoint === 'credits').at(-1)?.detail).toEqual({
      endpoint: 'credits',
      ok: false,
      status: 0,
    });
  });

  it('signed out: every card carries the auth reason and the pass backs off (no per-minute polling)', async () => {
    const h = serviceHarness(
      () => ({ status: 401, body: null, mode: 'web-session', error: 'login-required' }) as OpenHandsFetchResult,
      { visible: true },
    );
    h.service.start();
    await vi.waitFor(() => expect(h.service.cards().credits.state).toBe('error'));
    expect(h.service.cards()).toEqual({
      credits: { state: 'error', reason: 'login-required' },
      quota: { state: 'error', reason: 'login-required' },
      spend30d: { state: 'error', reason: 'login-required' },
    });
    expect(h.service.backoffMs()).toBe(60_000);
    await h.service.refresh();
    expect(h.service.backoffMs()).toBe(120_000);
    // Visible, but the next pass waits for the backoff, not the 60 s cadence.
    await vi.waitFor(() => expect(h.live().at(-1)?.ms).toBe(60_000));
    h.service.visibilityChanged();
    expect(h.live().at(-1)?.ms).toBe(120_000);
    expect(h.published).toHaveLength(0);
    h.service.stop();
  });

  it('recover(): drops the 401/403 backoff and fetches at once, cards reach ok', async () => {
    let signedIn = false;
    const h = serviceHarness(
      (p) =>
        signedIn
          ? happy(p)
          : ({ status: 401, body: null, mode: 'web-session', error: 'login-required' } as OpenHandsFetchResult),
      { visible: true },
    );
    h.service.start();
    await vi.waitFor(() => expect(h.service.cards().credits.state).toBe('error'));
    await h.service.refresh();
    await h.service.refresh();
    expect(h.service.backoffMs()).toBe(240_000);
    const before = h.paths.length;
    signedIn = true;
    h.service.recover();
    await vi.waitFor(() => expect(h.service.cards().credits.state).toBe('ok'));
    expect(h.paths.length).toBeGreaterThan(before);
    expect(h.service.backoffMs()).toBe(0);
    expect(h.service.cards().quota.state).toBe('ok');
    // Back on the visible 60 s cadence.
    await vi.waitFor(() => expect(h.live().at(-1)?.ms).toBe(60_000));
    expect(h.live()).toHaveLength(1);
    h.service.stop();
  });

  it('recover() during a pass with the old credentials runs one more pass after it', async () => {
    let release: (() => void) | null = null;
    let phase: 'old' | 'held' | 'new' = 'old';
    const refused = { status: 401, body: null, mode: 'api-key', error: 'api-key-rejected' } as OpenHandsFetchResult;
    const h = serviceHarness((p) => {
      if (phase === 'new') return happy(p);
      if (phase === 'held' && p === '/api/quota/status') {
        return new Promise<OpenHandsFetchResult>((resolve) => {
          release = () => resolve(refused);
        });
      }
      return refused;
    });
    h.service.start();
    await h.service.refresh();
    phase = 'held';
    const stale = h.service.refresh();
    await vi.waitFor(() => expect(release).not.toBeNull());
    phase = 'new';
    h.service.recover();
    (release as unknown as () => void)();
    await stale;
    await vi.waitFor(() => expect(h.service.cards().quota.state).toBe('ok'));
    expect(h.service.cards().credits.state).toBe('ok');
    expect(h.service.backoffMs()).toBe(0);
    h.service.stop();
  });

  it('recover() during an in-flight pass, then stop(): no further fetch once it resolves', async () => {
    let release: (() => void) | null = null;
    let hold = false;
    const h = serviceHarness((p) => {
      if (hold && p === '/api/quota/status') {
        return new Promise<OpenHandsFetchResult>((resolve) => {
          release = () => resolve(answer(200, QUOTA_BODY));
        });
      }
      return happy(p);
    });
    h.service.start();
    await h.service.refresh();
    hold = true;
    const pass = h.service.refresh();
    await vi.waitFor(() => expect(release).not.toBeNull());
    h.service.recover();
    h.service.stop();
    const fetched = h.paths.length;
    (release as unknown as () => void)();
    await pass;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.paths.length).toBe(fetched);
    expect(h.live()).toHaveLength(0);
  });

  it('refresh() after stop() asks nothing', async () => {
    const h = serviceHarness(happy);
    h.service.start();
    h.service.stop();
    await h.service.refresh();
    expect(h.paths).toHaveLength(0);
    expect(h.service.cards().credits).toEqual({ state: 'pending' });
  });

  it('recover() is a no-op before start / after stop', async () => {
    const h = serviceHarness(happy);
    h.service.recover();
    expect(h.paths).toHaveLength(0);
    h.service.start();
    h.service.stop();
    h.service.recover();
    expect(h.paths).toHaveLength(0);
    expect(h.live()).toHaveLength(0);
  });

  it('a rejected API key is carried as api-key-rejected', async () => {
    const h = serviceHarness(
      (p) =>
        p === '/api/billing/credits'
          ? ({ status: 401, body: null, mode: 'api-key', error: 'api-key-rejected' } as OpenHandsFetchResult)
          : happy(p),
    );
    await h.service.refresh();
    expect(h.service.cards().credits).toEqual({ state: 'error', reason: 'api-key-rejected' });
    expect(h.service.cards().quota.state).toBe('ok');
  });

  it('stop() while a pass is in flight: no card change, no publish, no timer afterwards', async () => {
    let release: (() => void) | null = null;
    let hold = false;
    const h = serviceHarness((p) => {
      if (hold && p === '/api/quota/status') {
        return new Promise<OpenHandsFetchResult>((resolve) => {
          release = () => resolve(answer(200, { daily_limit: 10, used_today: 9, reset_at: null }));
        });
      }
      return happy(p);
    });
    h.service.start();
    await h.service.refresh();
    const before = h.service.cards();
    const changes = h.changes();
    hold = true;
    const pass = h.service.refresh();
    await vi.waitFor(() => expect(release).not.toBeNull());
    h.service.stop();
    (release as unknown as () => void)();
    await pass;
    expect(h.service.cards()).toBe(before);
    expect(h.changes()).toBe(changes);
    expect(h.published).toHaveLength(1);
    expect(h.live()).toHaveLength(0);
    // A stopped service never re-arms.
    h.service.start();
    h.service.visibilityChanged();
    expect(h.live()).toHaveLength(0);
  });

  it('a 404 on my-usage drops the cached org id: the next pass asks /users/me again', async () => {
    let usageStatus = 200;
    const h = serviceHarness((p) => (p.includes('my-usage') ? answer(usageStatus, MY_USAGE_BODY) : happy(p)));
    const meCalls = () => h.paths.filter((p) => p === '/api/v1/users/me').length;
    await h.service.refresh();
    await h.service.refresh();
    expect(meCalls()).toBe(1); // cached across passes
    usageStatus = 404;
    await h.service.refresh();
    expect(h.service.cards().spend30d).toEqual({ state: 'unavailable' });
    expect(h.service.backoffMs()).toBe(0);
    usageStatus = 200;
    await h.service.refresh();
    expect(meCalls()).toBe(2);
    expect(h.service.cards().spend30d).toMatchObject({ state: 'ok', value: 4.2 });
  });

  it('repeated 5xx: backoff climbs 1 -> 2 -> 4 -> 8 -> 16 min, caps, slows the schedule and resets on success', async () => {
    let quotaStatus = 500;
    const h = serviceHarness((p) => (p === '/api/quota/status' ? answer(quotaStatus, QUOTA_BODY) : happy(p)));
    h.service.start();
    const seen: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await h.service.refresh();
      seen.push(h.service.backoffMs());
    }
    expect(seen).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 960_000]);
    // Both cadences (15 min hidden, 60 s visible) are below the 16 min backoff.
    h.service.visibilityChanged();
    expect(h.live().at(-1)?.ms).toBe(960_000);
    h.setVisible(true);
    h.service.visibilityChanged();
    await vi.waitFor(() => expect(h.live().at(-1)?.ms).toBe(960_000));
    quotaStatus = 200;
    await h.service.refresh();
    expect(h.service.backoffMs()).toBe(0);
    h.service.stop();
  });

  it('cadence: 15 min hidden, 60 s visible; becoming visible fetches at once', async () => {
    const h = serviceHarness(happy);
    h.service.start();
    await h.service.refresh();
    h.service.visibilityChanged();
    expect(h.live().at(-1)?.ms).toBe(15 * 60_000);
    const before = h.paths.length;
    h.setVisible(true);
    h.advance(61_000);
    h.service.visibilityChanged();
    await vi.waitFor(() => expect(h.paths.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(h.live().at(-1)?.ms).toBe(60_000));
    h.service.stop();
    expect(h.live()).toHaveLength(0);
  });
});

describe('openhands runtime core + usage', () => {
  function coreHarness(opts: { hasKey?: boolean } = {}) {
    const usage: (CoreUsage & { started: number; stopped: number; recovered: number })[] = [];
    let connection: OpenHandsConnection = 'idle';
    const timers: { fn: () => void; cleared: boolean }[] = [];
    const core = createOpenHandsRuntimeCore({
      currentBase: () => 'https://a.test',
      baseOf: (s) => s.openhands.baseUrl,
      pollSeconds: () => 30,
      pollMs: (s) => s * 1000,
      build: () => {
        const u = {
          started: 0,
          stopped: 0,
          recovered: 0,
          start() {
            this.started++;
          },
          stop() {
            this.stopped++;
          },
          recover() {
            this.recovered++;
          },
        };
        usage.push(u);
        const controller = {
          start: async () => {},
          stop: () => {},
          refresh: async () => {},
          snapshot: () => ({}) as never,
          drain: async () => {},
          mutate: async () => true,
        } satisfies CoreController;
        return {
          source: { requestFull: () => {}, isListing: () => false, connection: () => connection },
          controller,
          usage: u,
        };
      },
      hasKey: async () => opts.hasKey ?? false,
      cacheMatches: async () => false,
      dropCache: async () => {},
      setTimer: (fn) => {
        const t = { fn, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
      focused: () => true,
      onChange: () => {},
      log: () => {},
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    // Fire the pending sessions poll (the core's list cadence).
    const poll = async () => {
      const t = timers.filter((x) => !x.cleared).at(-1);
      t!.cleared = true;
      t!.fn();
      await flush();
    };
    return {
      core,
      usage,
      flush,
      poll,
      setConnection: (c: OpenHandsConnection) => (connection = c),
    };
  }

  it('a list that moves the connection from refused to authenticated recovers usage at once', async () => {
    const h = coreHarness();
    await h.core.start();
    h.core.onSurfaceEnter();
    await h.flush();
    const u = h.usage[0]!;
    // First answer after the gate opens (idle -> …) is no recovery.
    h.setConnection('login-required');
    await h.poll();
    expect(u.recovered).toBe(0);
    // Still refused: nothing.
    await h.poll();
    expect(u.recovered).toBe(0);
    // Signed in on the web page: the next list sees web-session.
    h.setConnection('web-session');
    await h.poll();
    expect(u.recovered).toBe(1);
    // Staying authenticated does not keep recovering.
    await h.poll();
    expect(u.recovered).toBe(1);
    // Key rejected, then fixed (api-key): another recovery; focus lists count too.
    h.setConnection('api-key-rejected');
    await h.poll();
    h.setConnection('api-key');
    h.core.onFocus();
    await h.flush();
    expect(u.recovered).toBe(2);
    await h.core.dispose();
  });

  it('idle -> authenticated on the first list does not recover (usage is just starting)', async () => {
    const h = coreHarness();
    await h.core.start();
    h.setConnection('web-session');
    h.core.onSurfaceEnter();
    await h.flush();
    await h.poll();
    expect(h.usage[0]!.recovered).toBe(0);
    await h.core.dispose();
  });

  it('a credentials change recovers usage once (not again for the same transition)', async () => {
    const h = coreHarness();
    await h.core.start();
    h.core.onSurfaceEnter();
    await h.flush();
    h.setConnection('api-key-rejected');
    await h.poll();
    const u = h.usage[0]!;
    expect(u.recovered).toBe(0);
    h.setConnection('api-key');
    await h.core.onCredentialsChanged(true);
    expect(u.recovered).toBe(1);
    await h.poll();
    expect(u.recovered).toBe(1);
    await h.core.dispose();
  });

  it('a credentials change with the gate closed opens it (key set) without a recover on a fresh service', async () => {
    const h = coreHarness();
    await h.core.start();
    await h.core.onCredentialsChanged(false);
    expect(h.usage).toHaveLength(0);
    await h.core.onCredentialsChanged(true);
    expect(h.usage).toHaveLength(1);
    // recover() on a just-started service is harmless; it is asked once.
    expect(h.usage[0]!.recovered).toBe(1);
    await h.core.dispose();
  });

  it('no usage service exists while the gate is closed; it starts with the gate and is replaced on a base change', async () => {
    const h = coreHarness();
    await h.core.start();
    expect(h.core.usage()).toBeNull();
    expect(h.usage).toHaveLength(0);
    h.core.onSurfaceEnter();
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]!.started).toBe(1);
    expect(h.core.usage()).toBe(h.usage[0]);
    await h.core.onSettingsChanged(
      { openhands: { baseUrl: 'https://a.test', pollSeconds: 30 } },
      { openhands: { baseUrl: 'https://b.test', pollSeconds: 30 } },
    );
    expect(h.usage[0]!.stopped).toBe(1);
    expect(h.usage).toHaveLength(2);
    expect(h.usage[1]!.started).toBe(1);
    await h.core.dispose();
    expect(h.usage[1]!.stopped).toBe(1);
  });
});
