// DevinUsageService: polls the tenant's /api/personal-analytics/usage-limit
// with the hosted page's bearer token (same identity path as cloudSessions)
// and publishes a usage reading (devinUsageFeed → the devin-cloud runtime's
// UsageSource → UsageAlertStore) on every fresh parse. State is plain in-memory —
// the shell reads it via ShellState.usage.devin; changes call notifyShell().
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, net } from 'electron';
import { fmt, parseUsageLimit, shortDate } from '../core/devinUsage';
import { monthKey } from '../core/claudeUsage';
import { USAGE_METRIC_LABEL } from '../core/usageAlerts';
import type { DevinUsageState, Settings } from '../shared/ipc';
import { cloudSessions, type TokenFailReason } from './cloudSessions';
import { log } from './log';
import { state, testMode } from './state';
import { UsageFeed, type UsageSummaryItem } from './cloudKit/usage';
import { notifyShell } from './window';

const FETCH_TIMEOUT_MS = 10_000;
const FIRST_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 16 * 60_000;
const TRANSIENT_RETRY_MS = 30_000;
const MAX_TRANSIENT_RETRIES = 6;

// Published after every fresh parse with a percent (the devin-cloud runtime's
// UsageSource reads it).
export const devinUsageFeed = new UsageFeed();

// Rail badge / summary item: the monthly percent whenever one is known (a
// stale cached body included).
export function devinUsageSummary(): UsageSummaryItem[] {
  const percent = devinUsage().state.percent;
  if (percent === null) return [];
  return [{ metric: 'devin-monthly', accountKey: '', label: USAGE_METRIC_LABEL['devin-monthly'], percent }];
}

interface DevinUsageCache {
  version: 1;
  tenantUrl: string;
  savedAt: string;
  body: unknown;
}

const EMPTY_STATE: DevinUsageState = {
  status: 'idle',
  tierName: null,
  cycleUsage: null,
  cycleLimit: null,
  estimatedCycleUsage: null,
  cycleStart: null,
  cycleEnd: null,
  percent: null,
  fetchedAt: null,
  stale: false,
  error: null,
  nextPollAt: null,
};

export class DevinUsageService {
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private fetchTask: Promise<void> | null = null;
  private backoffMs = 0;
  private transientRetries = 0;
  private nextDelayMs: number | null = null;
  private current: DevinUsageState = EMPTY_STATE;

  get state(): DevinUsageState {
    return this.current;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadCache();
    this.schedule(FIRST_POLL_MS);
  }

  refresh(): Promise<void> {
    return (this.fetchTask ??= this.runFetch().finally(() => {
      this.fetchTask = null;
    }));
  }

  // Reschedule when the poll cadence setting changes (applySettingsPatch path).
  onSettingsChanged(previous: Settings, next: Settings): void {
    if (previous.usage.devinPollMinutes === next.usage.devinPollMinutes) return;
    if (!this.started) return;
    this.schedule(this.intervalMs());
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }

  // --- cadence ---------------------------------------------------------------

  private intervalMs(): number {
    if (testMode && process.env.AGENT_WORKSPACE_TEST_DEVIN_USAGE_POLL_MS) {
      return Math.max(50, Number(process.env.AGENT_WORKSPACE_TEST_DEVIN_USAGE_POLL_MS) || 0);
    }
    return (state.settings?.current.usage.devinPollMinutes ?? 15) * 60_000;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = ms + this.backoffMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => {
        if (this.started) {
          const delayMs = this.nextDelayMs ?? this.intervalMs();
          this.nextDelayMs = null;
          this.schedule(delayMs);
        }
      });
    }, delay);
    this.set({ nextPollAt: new Date(Date.now() + delay).toISOString() });
  }

  private set(patch: Partial<DevinUsageState>): void {
    this.current = { ...this.current, ...patch };
    notifyShell();
  }

  // --- identity + fetch --------------------------------------------------------

  private usageUrl(): string | null {
    if (testMode) return process.env.AGENT_WORKSPACE_TEST_DEVIN_USAGE_URL ?? null;
    return `${state.tenantUrl.replace(/\/+$/, '')}/api/personal-analytics/usage-limit`;
  }

  private async identity(): Promise<{
    identity: { token: string; orgId: string } | null;
    reason: TokenFailReason | null;
  }> {
    if (testMode) {
      return {
        identity: process.env.AGENT_WORKSPACE_TEST_DEVIN_USAGE_URL
          ? { token: 'test', orgId: 'test' }
          : null,
        reason: null,
      };
    }
    return cloudSessions().readIdentity();
  }

  private async fetchBody(
    url: string,
    id: { token: string; orgId: string },
  ): Promise<{ status: number; body: unknown }> {
    const response = await net.fetch(url, {
      headers: {
        authorization: `Bearer ${id.token}`,
        'x-cog-org-id': id.orgId,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  }

  private async runFetch(): Promise<void> {
    const start = Date.now();
    const url = this.usageUrl();
    const finish = (patch: Partial<DevinUsageState>, detail: Record<string, unknown>) => {
      this.set(patch);
      log('cloud', 'devin-usage-fetch', {
        detail: {
          ok: patch.status === 'ready',
          status: detail.status ?? 0,
          ms: Date.now() - start,
          stale: this.current.stale,
          ...(detail.reason ? { reason: detail.reason } : {}),
        },
      });
    };
    if (!url) {
      finish({ status: 'idle' }, { reason: 'disabled' });
      return;
    }
    const fail = (
      status: DevinUsageState['status'],
      error: string | null,
      reason: string,
      httpStatus = 0,
    ) => {
      this.transientRetries = 0;
      this.backoffMs = Math.min(Math.max(this.backoffMs * 2, 60_000), MAX_BACKOFF_MS);
      finish(
        { status, error, stale: this.current.cycleUsage !== null },
        { reason, status: httpStatus },
      );
    };
    // Transient identity failures (view still loading, token read timeout):
    // state untouched, no backoff growth — retry in 30 s, at most 6 times in a
    // row before falling back to the normal cadence.
    const TRANSIENT = new Set<TokenFailReason>(['view-not-ready', 'timeout', 'error']);
    const transient = (reason: TokenFailReason) => {
      this.transientRetries += 1;
      if (this.transientRetries <= MAX_TRANSIENT_RETRIES) this.nextDelayMs = TRANSIENT_RETRY_MS;
      finish({}, { reason });
    };
    const resolveIdentity = async () => {
      const { identity, reason } = await this.identity();
      if (identity) return identity;
      if (reason && TRANSIENT.has(reason)) transient(reason);
      else fail('login-required', null, reason ?? 'login-required');
      return null;
    };
    try {
      let id = await resolveIdentity();
      if (!id) return;
      let result = await this.fetchBody(url, id);
      if (result.status === 401 && !testMode) {
        // Re-read once — the page token may have rotated.
        id = await resolveIdentity();
        if (!id) return;
        result = await this.fetchBody(url, id);
      }
      if (result.status !== 200) {
        fail('error', `HTTP ${result.status}`, 'http', result.status);
        return;
      }
      const snap = parseUsageLimit(result.body);
      if (!snap) {
        fail('error', 'Unexpected response', 'parse');
        return;
      }
      this.transientRetries = 0;
      this.backoffMs = 0;
      const fetchedAt = new Date().toISOString();
      this.saveCache(result.body);
      this.set({
        status: 'ready',
        tierName: snap.tierName,
        cycleUsage: snap.cycleUsage,
        cycleLimit: snap.cycleLimit,
        estimatedCycleUsage: snap.estimatedCycleUsage,
        cycleStart: snap.cycleStart,
        cycleEnd: snap.cycleEnd,
        percent: snap.percent,
        fetchedAt,
        stale: false,
        error: null,
      });
      log('cloud', 'devin-usage-fetch', {
        detail: { ok: true, status: 200, ms: Date.now() - start, stale: false },
      });
      if (snap.percent !== null) {
        const cycleLimit = snap.cycleLimit!;
        devinUsageFeed.publish([
          {
            metric: 'devin-monthly',
            account: '',
            percent: snap.percent,
            periodKey: snap.cycleStart ?? monthKey(new Date()),
            stale: false,
            body: `${fmt(snap.cycleUsage)} / ${fmt(cycleLimit)} ACUs used${snap.cycleEnd ? ` — resets ${shortDate(snap.cycleEnd)}` : ''}`,
          },
        ]);
      }
    } catch {
      fail('error', 'network', 'network');
    }
  }

  // --- cache -------------------------------------------------------------------

  private cachePath(): string {
    return join(app.getPath('userData'), 'devin-usage-cache.json');
  }

  private loadCache(): void {
    try {
      const file = this.cachePath();
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as DevinUsageCache;
      if (parsed?.version !== 1 || parsed.tenantUrl !== state.tenantUrl) return;
      const snap = parseUsageLimit(parsed.body);
      if (!snap) return;
      this.current = {
        ...EMPTY_STATE,
        status: 'ready',
        tierName: snap.tierName,
        cycleUsage: snap.cycleUsage,
        cycleLimit: snap.cycleLimit,
        estimatedCycleUsage: snap.estimatedCycleUsage,
        cycleStart: snap.cycleStart,
        cycleEnd: snap.cycleEnd,
        percent: snap.percent,
        fetchedAt: parsed.savedAt,
        stale: true,
      };
      log('cloud', 'devin-usage-cache', { detail: { loaded: true } });
    } catch {
      /* corrupt cache — start empty */
    }
  }

  private saveCache(body: unknown): void {
    try {
      mkdirSync(dirname(this.cachePath()), { recursive: true });
      writeFileSync(
        this.cachePath(),
        JSON.stringify({ version: 1, tenantUrl: state.tenantUrl, savedAt: new Date().toISOString(), body } satisfies DevinUsageCache),
      );
    } catch {
      /* cache write failure is non-fatal */
    }
  }
}

let service: DevinUsageService | null = null;

export function devinUsage(): DevinUsageService {
  if (!service) service = new DevinUsageService();
  return service;
}
