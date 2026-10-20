import { useEffect, useSyncExternalStore } from 'react';
import { parseUsageResponse } from '../../../core/claudeUsage';
import type { ClaudeTokenTotals, ClaudeUsageState } from '../../../shared/ipc';

// The main-process usage service (plan A2) adds these to the preload; until it
// lands this hook falls back to a fixed sample state so the panel renders
// standalone. A4 swaps this hook for the real `useClaudeUsage()` store.
type UsageApi = {
  onClaudeUsage?: (callback: (state: ClaudeUsageState) => void) => () => void;
  claudeUsageState?: () => Promise<ClaudeUsageState>;
  claudeUsageVisible?: (visible: boolean) => void;
};

function usageApi(): UsageApi {
  return window.devinworkspaces as unknown as UsageApi;
}

// --- sample state (mirrors tests/fixtures/claude-usage.json) -----------------

const SAMPLE_USAGE_BODY = {
  five_hour: { utilization: 0, resets_at: '2026-10-20T18:00:00.000Z' },
  seven_day: { utilization: 10, resets_at: '2026-10-26T03:00:00.000Z' },
  limits: [
    {
      kind: 'session',
      group: 'rate',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-10-20T18:00:00.000Z',
      scope: {},
      is_active: true,
    },
    {
      kind: 'weekly_all',
      group: 'rate',
      percent: 10,
      severity: 'normal',
      resets_at: '2026-10-26T03:00:00.000Z',
      scope: {},
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'rate',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-10-26T03:00:00.000Z',
      scope: { model: { id: 'fable-5-1', display_name: 'Fable' } },
      is_active: true,
    },
  ],
  extra_usage: null,
  spend: {
    used: { amount_minor: 0, currency: 'USD', exponent: 2 },
    limit: null,
    percent: 0,
    severity: 'normal',
    enabled: false,
  },
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 20 }],
  member_dashboard_available: false,
};

const t = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  messages: number,
): ClaudeTokenTotals => ({ input, output, cacheRead, cacheWrite, messages });

function sum(list: ClaudeTokenTotals[]): ClaudeTokenTotals {
  return list.reduce(
    (acc, x) => t(
      acc.input + x.input,
      acc.output + x.output,
      acc.cacheRead + x.cacheRead,
      acc.cacheWrite + x.cacheWrite,
      acc.messages + x.messages,
    ),
    t(0, 0, 0, 0, 0),
  );
}

function buildSample(): ClaudeUsageState {
  const parsed = parseUsageResponse(SAMPLE_USAGE_BODY);
  // Plausible month buckets in the plan's §1.3 proportions (WSL + Windows).
  const byModel: Record<string, ClaudeTokenTotals> = {
    'claude-opus-5-5': t(412_000, 921_000, 157_800_000, 6_120_000, 3_180),
    'claude-fable-5-1': t(61_000, 86_000, 15_700_000, 820_000, 410),
    'claude-sonnet-5': t(58_000, 85_000, 15_400_000, 760_000, 395),
    'claude-sonnet-4-6': t(9_000, 13_000, 900_000, 60_000, 48),
  };
  const byHost: Record<string, ClaudeTokenTotals> = {
    'wsl:Ubuntu': t(470_000, 1_065_000, 164_900_000, 7_000_000, 3_650),
    local: t(70_000, 40_000, 5_700_000, 760_000, 383),
  };
  const month = '2026-10';
  const byDay: ClaudeUsageState['tokens']['byDay'] = [];
  const models = Object.keys(byModel);
  for (let day = 1; day <= 20; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    if (day === 4 || day === 11 || day === 12) continue; // weekend-ish gaps
    const weight = 0.5 + Math.abs(Math.sin(day * 1.7)) * 1.2;
    const perModel: Record<string, number> = {};
    models.forEach((model, i) => {
      const base = [9_000_000, 950_000, 900_000, 60_000][i] ?? 0;
      const v = Math.round(base * weight * (0.6 + ((day * (i + 3)) % 7) / 10));
      if (v > 0) perModel[model] = v;
    });
    byDay.push({ date, byModel: perModel });
  }
  return {
    status: 'ready',
    perToken: false,
    month,
    accounts: [
      {
        email: 'you@example.com',
        organization: 'Example Engineering',
        plan: 'team',
        hosts: ['local', 'wsl:Ubuntu'],
        limits: parsed.limits,
        credits: parsed.credits,
        fetchedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        stale: false,
        error: null,
      },
    ],
    tokens: {
      total: sum(Object.values(byModel)),
      byModel,
      byHost,
      byDay,
      previousMonthTotal: t(390_000, 820_000, 121_000_000, 5_100_000, 2_900),
      scannedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      scanning: null,
    },
  };
}

export const SAMPLE_STATE: ClaudeUsageState = buildSample();

// --- pushed store (when the preload exposes it) ------------------------------

let pushed: ClaudeUsageState | null = null;
const listeners = new Set<() => void>();
let subscribed = false;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const api = usageApi();
  if (!subscribed && api.onClaudeUsage) {
    subscribed = true;
    api.onClaudeUsage((next) => {
      pushed = next;
      listeners.forEach((listener) => listener());
    });
    void api.claudeUsageState?.().then((next) => {
      pushed = next;
      listeners.forEach((listener) => listener());
    });
  }
  return () => listeners.delete(callback);
}

const LOADING: ClaudeUsageState = {
  ...SAMPLE_STATE,
  status: 'loading',
  accounts: [],
  tokens: { ...SAMPLE_STATE.tokens, total: t(0, 0, 0, 0, 0), byModel: {}, byHost: {}, byDay: [], previousMonthTotal: null, scannedAt: null },
};

function snapshot(): ClaudeUsageState {
  if (!usageApi().onClaudeUsage) return SAMPLE_STATE;
  return pushed ?? LOADING;
}

export function useUsageSource(): ClaudeUsageState {
  const state = useSyncExternalStore(subscribe, snapshot);
  // Visibility signal drives the service's fetch/scan cadence (plan D3).
  useEffect(() => {
    const api = usageApi();
    api.claudeUsageVisible?.(true);
    return () => api.claudeUsageVisible?.(false);
  }, []);
  return state;
}
