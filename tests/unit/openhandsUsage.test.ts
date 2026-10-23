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
  usageDelayMs,
  type Card,
} from '../../src/core/openhandsUsage';
import { createOpenHandsUsageService } from '../../src/main/openhands/usage';
import type { OpenHandsFetchResult } from '../../src/main/openhands/fetch';
import type { UsageReading } from '../../src/main/cloudKit/usage';
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

  it('401/403 -> error with stale, no backoff', () => {
    expect(nextCard<number>(ok, 401, null, FETCHED)).toEqual({ card: { state: 'error', stale: 5 }, retry: false });
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
  function coreHarness() {
    const usage: (CoreUsage & { started: number; stopped: number })[] = [];
    const core = createOpenHandsRuntimeCore({
      currentBase: () => 'https://a.test',
      baseOf: (s) => s.openhands.baseUrl,
      pollSeconds: () => 30,
      pollMs: (s) => s * 1000,
      build: () => {
        const u = {
          started: 0,
          stopped: 0,
          start() {
            this.started++;
          },
          stop() {
            this.stopped++;
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
          source: { requestFull: () => {}, isListing: () => false, connection: () => 'idle' as const },
          controller,
          usage: u,
        };
      },
      hasKey: async () => false,
      cacheMatches: async () => false,
      dropCache: async () => {},
      setTimer: () => ({}),
      clearTimer: () => {},
      focused: () => true,
      onChange: () => {},
      log: () => {},
    });
    return { core, usage };
  }

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
