// ClaudeUsageService (plan D1–D4, D7): one service owns both Claude-analytics
// data sources — plan limits fetched from the OAuth /usage endpoint, and token
// totals from an incremental transcript aggregator over every fs-ready host's
// store. WSL hosts are read inside the distro over the helper channel
// (`usage.accounts` / `usage.scan`) — never over \\wsl.localhost. Publishes
// one pushed state on IpcChannels.claudeUsage; started once the shell has
// loaded (WSL work waits for a ready channel) and lazily on first use.

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open as openFile, readdir, readFile, stat as statFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { app } from 'electron';
import { dirname, join } from 'node:path';
import {
  aggregateUsageLines,
  emptyClaudeUsageState,
  fileMayContainMonths,
  fileScanPlan,
  groupAccounts,
  emptyTotals,
  mergeBuckets,
  monthKey,
  parseUsageResponse,
  previousMonthKey,
  pruneFileCache,
  resetsIn,
  sumTotals,
  type UsageBuckets,
} from '../../core/claudeUsage';
import { USAGE_METRIC_LABEL, type UsageMetric } from '../../core/usageAlerts';
import { UsageFeed, type UsageReading, type UsageSummaryItem } from '../cloudKit/usage';
import type {
  ClaudeUsageAccount,
  ClaudeUsageLimit,
  ClaudeUsageState,
  ClaudeTokenTotals,
  HostId,
} from '../../shared/ipc';
import { ClaudeUsageStateSchema, IpcChannels } from '../../shared/ipc';
import { hosts } from '../hosts';
import { isRemoteHost, type ExecHost } from '../../core/execHost';
import { log } from '../log';
import { notifyShell } from '../window';
import { createPushedStore } from '../pushedStore';
import { HostRpcError } from '../hostChannel';
import { testMode } from '../state';

const FETCH_TIMEOUT_MS = 10_000;
const HOST_FS_BUDGET_MS = 10_000;
const VISIBLE_MS = 60_000;
const IDLE_FETCH_MS = 10 * 60_000;
const POKE_DEBOUNCE_MS = 5_000;
const CHUNK_FILES = 50;
const PROGRESS_MS = 250;
const SCAN_WORKERS = 6;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// --- on-disk cache (userData, never inside the CLI's configDir) ---------------

interface FileCacheEntry {
  size: number;
  mtime: number;
  offset: number;
  buckets: UsageBuckets;
}
interface UsageCacheFile {
  version: 1;
  files: Record<string, FileCacheEntry>;
  // email → last good /usage body (for stale fallback), never the token.
  accounts: Record<string, { lastBody: unknown; at: number }>;
  /** IANA zone the file buckets are keyed in (absent in older caches). */
  timeZone?: string | undefined;
}
const emptyCache = (): UsageCacheFile => ({ version: 1, files: {}, accounts: {} });

interface HostCreds {
  host: ExecHost;
  // Held in memory for the fetch only — never logged, never in state.
  accessToken: string;
  expiresAt: number;
  plan: string | null;
  email: string | null;
  organization: string | null;
  /** WSL hosts: the CLI's `.usage-cache` as read by the helper (undefined = local, read from disk). */
  usageCache?: { body: string; mtimeMs: number } | null;
}

/** `usage.accounts` reply (src/helper/usage.ts). */
interface HelperAccounts {
  accessToken?: unknown;
  expiresAt?: unknown;
  plan?: unknown;
  email?: unknown;
  org?: unknown;
  usageCache?: unknown;
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function helperUsageCache(v: unknown): { body: string; mtimeMs: number } | null {
  if (!v || typeof v !== 'object') return null;
  const { body, mtimeMs } = v as { body?: unknown; mtimeMs?: unknown };
  return typeof body === 'string' && typeof mtimeMs === 'number' ? { body, mtimeMs } : null;
}

/** The app's IANA zone: day/month buckets are keyed in it on every host (the
 * WSL helper runs in the distro's zone, which can differ). */
function appTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// Usage alerts: published at the end of every runFetch (the claude runtime's
// UsageSource reads it); one reading per account per plan limit (session +
// weekly-all), stale accounts flagged `stale` so they never alert.
export const claudeUsageFeed = new UsageFeed();

function limitMetric(kind: ClaudeUsageLimit['kind']): UsageMetric | null {
  return kind === 'session' ? 'claude-session' : kind === 'weekly_all' ? 'claude-weekly' : null;
}

function accountKeyOf(account: ClaudeUsageAccount): string {
  return account.email ?? `host:${account.hosts[0] ?? ''}`;
}

// Rail badge / summary items: each non-stale account's session/weekly limits.
// Reading claudeUsage().state is safe before start — the getter returns the
// initial state without starting the service.
export function claudeUsageSummary(): UsageSummaryItem[] {
  const items: UsageSummaryItem[] = [];
  for (const account of claudeUsage().state.accounts) {
    if (account.stale) continue;
    const accountKey = accountKeyOf(account);
    for (const limit of account.limits) {
      const metric = limitMetric(limit.kind);
      if (!metric) continue;
      items.push({
        metric,
        accountKey,
        label: `${USAGE_METRIC_LABEL[metric]}${account.email ? ` (${account.email})` : ''}`,
        percent: limit.percent,
      });
    }
  }
  return items;
}

/** Plain-object check for a `usage.scan` bucket map (shape is trusted below that). */
const isBuckets = (v: unknown): v is UsageBuckets => !!v && typeof v === 'object' && !Array.isArray(v);

export class ClaudeUsageService {
  private started = false;
  private visible = false;
  private fetchTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private pokeTimer: NodeJS.Timeout | null = null;
  private fetchTask: Promise<void> | null = null;
  private scanTask: Promise<void> | null = null;
  private backoffMs = 60_000;
  private cache: UsageCacheFile = emptyCache();
  private cacheLoaded = false;
  private store = createPushedStore<ClaudeUsageState>({
    schema: ClaudeUsageStateSchema,
    channel: IpcChannels.claudeUsage,
    initial: emptyClaudeUsageState(monthKey(new Date(this.now()))),
    empty: () => emptyClaudeUsageState(monthKey(new Date(this.now()))),
    logTag: 'claude',
    logEvent: 'claude-usage-state-invalid',
  });

  private now(): number {
    const raw = testMode ? process.env.AGENT_WORKSPACE_TEST_NOW : undefined;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  }

  get state(): ClaudeUsageState {
    return this.store.get();
  }

  private hostChangePrev: (() => void) | null = null;
  private hostChangeFn: (() => void) | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadCache();
    // Wait for the first distro enumeration so wsl hosts are in list() for
    // the first pass; later probe completions poke a re-fetch via the
    // host-change hook below.
    void hosts()
      .whenEnumerated()
      .then(() => {
        void this.fetchAll();
        void this.scanAll();
        this.schedule();
      });
    // Chain the single onStatusChange slot (claude sessions owns it): a host
    // that becomes ready after the first pass gets fetched + scanned.
    this.hostChangePrev = hosts().onStatusChange;
    this.hostChangeFn = () => {
      this.hostChangePrev?.();
      this.poke('hosts');
    };
    hosts().onStatusChange = this.hostChangeFn;
  }

  setVisible(visible: boolean): void {
    this.start();
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      void this.fetchAll();
      void this.scanAll();
    }
    this.schedule();
  }

  async refresh(): Promise<void> {
    this.start();
    await Promise.all([this.fetchAll(), this.scanAll()]);
    this.schedule();
  }

  /** Debounced fetch trigger: app-driven turn end, a Stop hook event, or a
   * host becoming ready ('hosts' also rescans — a new store appeared). */
  poke(reason: 'turn' | 'hook' | 'hosts'): void {
    if (!this.started) return;
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.fetchAll();
      if (reason === 'hosts') void this.scanAll();
    }, POKE_DEBOUNCE_MS);
  }

  dispose(): void {
    for (const t of [this.fetchTimer, this.scanTimer, this.pokeTimer]) {
      if (t) clearTimeout(t);
    }
    this.fetchTimer = this.scanTimer = this.pokeTimer = null;
    if (this.hostChangeFn && hosts().onStatusChange === this.hostChangeFn) {
      hosts().onStatusChange = this.hostChangePrev;
    }
    this.hostChangeFn = null;
  }

  // --- cadence ---------------------------------------------------------------

  private schedule(): void {
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.fetchTimer = setTimeout(() => {
      void this.fetchAll();
      this.schedule();
    }, this.backoffMs + (this.visible ? VISIBLE_MS : IDLE_FETCH_MS));
    if (this.visible) {
      this.scanTimer = setTimeout(() => {
        void this.scanAll();
        this.schedule();
      }, VISIBLE_MS);
    }
  }

  // --- credentials + accounts --------------------------------------------------

  /** Races local fs work against HOST_FS_BUDGET_MS — a stalled disk must
   * never hold a fetch/scan pass hostage (the loser keeps running detached).
   * WSL work goes over the helper channel, which has its own request timeouts. */
  private async fsRace<T>(work: Promise<T>): Promise<{ ok: boolean; timedOut: boolean; value?: T }> {
    let timer: NodeJS.Timeout | null = null;
    try {
      // The rejection branch keeps a loser that rejects after the timeout
      // from surfacing as an unhandledRejection.
      const result = await Promise.race([
        work.then(
          (value) => ({ kind: 'value' as const, value }),
          () => ({ kind: 'error' as const }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), HOST_FS_BUDGET_MS);
          timer.unref?.();
        }),
      ]);
      return result.kind === 'value'
        ? { ok: true, timedOut: false, value: result.value }
        : { ok: false, timedOut: result.kind === 'timeout' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Local host only — WSL credentials arrive over the helper (`wslAccount`). */
  private async credsForHost(host: ExecHost): Promise<Omit<HostCreds, 'email' | 'organization'> | null> {
    const file = join(hosts().localConfigDir(), '.credentials.json');
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
      };
      const oauth = parsed.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      return {
        host,
        accessToken: oauth.accessToken,
        expiresAt: Number(oauth.expiresAt) || 0,
        plan: oauth.subscriptionType ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Local account file; test-mode seam: a bare path is the default, a
   * `local=path` entry overrides it (WSL hosts read the distro's own file
   * through the helper). */
  private accountFileFor(host: ExecHost): string {
    const env = testMode ? (process.env.AGENT_WORKSPACE_TEST_CLAUDE_ACCOUNT_FILE?.trim() ?? '') : '';
    if (!testMode || !env) return join(dirname(hosts().localConfigDir()), '.claude.json');
    let fallback: string | null = null;
    for (const entry of env.split(';')) {
      const part = entry.trim();
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq > 0) {
        if (part.slice(0, eq).trim() === host.id) return part.slice(eq + 1).trim();
      } else {
        fallback = part;
      }
    }
    return fallback ?? join(dirname(hosts().localConfigDir()), '.claude.json');
  }

  private async accountForHost(host: ExecHost): Promise<{ email: string | null; organization: string | null }> {
    const file = this.accountFileFor(host);
    if (!file) return { email: null, organization: null };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as {
        oauthAccount?: { emailAddress?: string; organizationName?: string };
      };
      return {
        email: parsed.oauthAccount?.emailAddress ?? null,
        organization: parsed.oauthAccount?.organizationName ?? null,
      };
    } catch {
      return { email: null, organization: null };
    }
  }

  /** `usage.accounts` over the host's helper channel: null when signed out or
   * the request failed, 'timeout' when the helper did not answer in time. */
  private async wslAccount(host: ExecHost): Promise<HostCreds | null | 'timeout'> {
    const channel = hosts().channel(host);
    if (!channel) return null;
    let res: HelperAccounts | null;
    try {
      res = await channel.request<HelperAccounts | null>('usage.accounts');
    } catch (error) {
      return error instanceof HostRpcError && error.code === 'timeout' ? 'timeout' : null;
    }
    const accessToken = strOrNull(res?.accessToken);
    if (!res || !accessToken) return null;
    return {
      host,
      accessToken,
      expiresAt: Number(res.expiresAt) || 0,
      plan: strOrNull(res.plan),
      email: strOrNull(res.email),
      organization: strOrNull(res.org),
      usageCache: helperUsageCache(res.usageCache),
    };
  }

  // Group hosts by account email (no email → one group per host). Wsl hosts
  // without a ready channel are never touched, and one whose `usage.accounts`
  // times out is skipped; a local fs stalling past the budget is skipped too.
  private async readAccounts(): Promise<{
    groups: { key: string; email: string | null; organization: string | null; plan: string | null; hosts: HostCreds[] }[];
    skippedHosts: HostId[];
  }> {
    const skippedHosts = hosts()
      .list()
      .filter((h) => !hosts().fsReady(h))
      .map((h) => h.id);
    const members = await Promise.all(
      hosts().readyList().map(async (host) => {
        if (isRemoteHost(host)) {
          const remote = await this.wslAccount(host);
          if (remote === 'timeout') skippedHosts.push(host.id);
          if (!remote || remote === 'timeout') return null;
          return {
            member: remote,
            summary: { hostId: host.id, email: remote.email, organization: remote.organization, plan: remote.plan },
          };
        }
        const result = await this.fsRace(
          (async () => {
            const creds = await this.credsForHost(host);
            if (!creds) return null;
            const account = await this.accountForHost(host);
            return { creds, account };
          })(),
        );
        if (!result.ok) {
          if (result.timedOut) skippedHosts.push(host.id);
          return null;
        }
        if (!result.value) return null;
        const { creds, account } = result.value;
        return {
          member: { ...creds, email: account.email, organization: account.organization } as HostCreds,
          summary: { hostId: host.id, ...account, plan: creds.plan },
        };
      }),
    );
    const byHost = new Map<string, HostCreds>();
    const summaries: { hostId: HostId; email: string | null; organization: string | null; plan: string | null }[] = [];
    for (const entry of members) {
      if (!entry) continue;
      byHost.set(entry.member.host.id, entry.member);
      summaries.push(entry.summary);
    }
    return {
      groups: groupAccounts(summaries).map((group) => ({
        ...group,
        hosts: group.hostIds.map((id) => byHost.get(id)!),
      })),
      skippedHosts,
    };
  }

  // --- fetch (limits) ----------------------------------------------------------

  private async staleBody(
    accountKey: string,
    members: HostCreds[],
  ): Promise<{ body: unknown; at: number | null } | null> {
    const cached = this.cache.accounts[accountKey];
    if (cached) return { body: cached.lastBody, at: cached.at };
    // Fall back to the newest .usage-cache the CLI left on the account's hosts.
    let best: { at: number; body: unknown } | null = null;
    for (const member of members) {
      if (member.usageCache !== undefined) {
        const remote = member.usageCache;
        try {
          if (remote && (!best || remote.mtimeMs > best.at)) best = { at: remote.mtimeMs, body: JSON.parse(remote.body) };
        } catch {
          /* unparseable cache — skip */
        }
        continue;
      }
      // A remote member's cache only ever arrives over its helper (above).
      if (isRemoteHost(member.host)) continue;
      const file = join(hosts().localConfigDir(), '.usage-cache');
      try {
        const stat = await statFile(file);
        if (!best || stat.mtimeMs > best.at) {
          best = { at: stat.mtimeMs, body: JSON.parse(await readFile(file, 'utf8')) };
        }
      } catch {
        /* unreadable cache — skip */
      }
    }
    return best;
  }

  private fetchAll(): Promise<void> {
    return (this.fetchTask ??= this.runFetch().finally(() => {
      this.fetchTask = null;
    }));
  }

  private async runFetch(): Promise<void> {
    try {
      const { groups, skippedHosts } = await this.readAccounts();
      const url = testMode
        ? (process.env.AGENT_WORKSPACE_TEST_CLAUDE_USAGE_URL ?? USAGE_URL)
        : USAGE_URL;
      const start = Date.now();
      const accounts: ClaudeUsageAccount[] = [];
      let ok = true;
      for (const group of groups) {
        const pick = group.hosts.reduce((a, b) => (b.expiresAt > a.expiresAt ? b : a));
        const expired = pick.expiresAt <= this.now();
        let body: unknown = null;
        let status = 0;
        let stale = false;
        let error: string | null = null;
        let bodyAt: number | null = null;
        if (expired) {
          stale = true;
          error = 'Sign-in expired — run claude to refresh';
          const last = await this.staleBody(group.key, group.hosts);
          body = last?.body ?? null;
          bodyAt = last?.at ?? null;
        } else {
          try {
            const response = await fetch(url, {
              headers: {
                // Never logged — the token stays inside this function.
                authorization: `Bearer ${pick.accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
                accept: 'application/json',
              },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            status = response.status;
            if (response.ok) {
              body = await response.json();
              this.cache.accounts[group.key] = { lastBody: body, at: this.now() };
              this.saveCache();
            } else if (status === 401 || status === 403) {
              stale = true;
              error = 'Sign-in expired — run claude to refresh';
              const last = await this.staleBody(group.key, group.hosts);
              body = last?.body ?? null;
              bodyAt = last?.at ?? null;
            } else {
              // Non-auth failure — keep last good instead of dropping gauges.
              ok = false;
              error = `Fetch failed (HTTP ${status})`;
              const last = await this.staleBody(group.key, group.hosts);
              if (last) {
                stale = true;
                body = last.body;
                bodyAt = last.at;
              }
            }
          } catch {
            ok = false;
            error = 'Fetch failed (network)';
            const last = await this.staleBody(group.key, group.hosts);
            if (last) {
              stale = true;
              body = last.body;
              bodyAt = last.at;
            }
          }
        }
        if (!ok && !stale) {
          this.backoffMs = Math.min(this.backoffMs * 2, 16 * 60_000);
        } else {
          this.backoffMs = 60_000;
        }
        const parsed = body ? parseUsageResponse(body) : { limits: [], credits: null };
        accounts.push({
          email: group.email,
          organization: group.organization,
          plan: group.plan,
          hosts: group.hosts.map((member) => member.host.id),
          limits: parsed.limits,
          credits: parsed.credits,
          // Fresh → now; stale → the cached body's timestamp so the UI can
          // show "updated 3h ago".
          fetchedAt: stale
            ? (bodyAt !== null ? new Date(bodyAt).toISOString() : null)
            : new Date(this.now()).toISOString(),
          stale,
          error,
        });
      }
      log('claude', 'usage-fetch', {
        detail: { ok, status: ok ? 200 : -1, ms: Date.now() - start, stale: accounts.some((a) => a.stale), accounts: accounts.length, skippedHosts },
      });
      this.store.update((state) => ({
        ...state,
        status: 'ready',
        accounts,
        perToken: accounts.length === 0,
      }));
      // ShellState.usage mirrors these limits — push a full state update too.
      notifyShell();
      // Usage alerts: one reading per account per plan limit (session +
      // weekly-all); stale accounts are flagged and never alert.
      const readings: UsageReading[] = [];
      for (const account of accounts) {
        const accountKey = accountKeyOf(account);
        for (const limit of account.limits) {
          const metric = limitMetric(limit.kind);
          if (!metric) continue;
          readings.push({
            metric,
            account: accountKey,
            percent: limit.percent,
            periodKey: limit.resetsAt ?? '',
            stale: account.stale,
            body: `${account.email ?? 'Claude'} — ${Math.round(limit.percent)}% used${limit.resetsAt ? `, resets in ${resetsIn(this.now(), limit.resetsAt)}` : ''}`,
          });
        }
      }
      claudeUsageFeed.publish(readings);
    } catch {
      /* surfaced via the account error field / backoff */
    }
  }

  // --- scanner (tokens) --------------------------------------------------------

  private cachePath(): string {
    return join(app.getPath('userData'), 'claude-usage-cache.json');
  }

  private loadCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const file = this.cachePath();
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as UsageCacheFile;
        this.cache = parsed.version === 1 ? parsed : emptyCache();
      }
    } catch {
      this.cache = emptyCache();
    }
    log('claude', 'usage-cache-load', { detail: { files: Object.keys(this.cache.files).length } });
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.cachePath()), { recursive: true });
      writeFileSync(this.cachePath(), JSON.stringify(this.cache));
    } catch {
      /* cache write failure is non-fatal */
    }
  }

  private async *walkJsonl(dir: string): AsyncGenerator<string> {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.name.endsWith('.jsonl')) yield path;
      }
    }
  }

  private async byteAt(path: string, pos: number): Promise<number> {
    try {
      const handle = await openFile(path, 'r');
      try {
        const buf = Buffer.alloc(1);
        const { bytesRead } = await handle.read(buf, 0, 1, pos);
        return bytesRead === 1 ? buf[0]! : -1;
      } finally {
        await handle.close();
      }
    } catch {
      return -1;
    }
  }

  private async readLines(path: string, offset: number): Promise<string[]> {
    const lines: string[] = [];
    const stream = offset > 0 ? createReadStream(path, { start: offset }) : createReadStream(path);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) if (line) lines.push(line);
    rl.close();
    return lines;
  }

  /** `usage.scan` over the host's helper channel; null when it failed (the host lands in skippedHosts). */
  private async wslScan(
    host: ExecHost,
    months: string[],
    timeZone: string | undefined,
  ): Promise<{ buckets: UsageBuckets; files: number; changed: number; skipped: number; zoneFallback: boolean } | null> {
    const channel = hosts().channel(host);
    if (!channel) return null;
    const t0 = Date.now();
    try {
      const res = await channel.request<{ buckets?: unknown; files?: unknown; changed?: unknown; skipped?: unknown; zoneFallback?: unknown } | null>(
        'usage.scan',
        timeZone ? { months, timeZone } : { months },
      );
      if (!res || !isBuckets(res.buckets)) return null;
      const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      return { buckets: res.buckets, files: count(res.files), changed: count(res.changed), skipped: count(res.skipped), zoneFallback: res.zoneFallback === true };
    } catch (error) {
      if (error instanceof HostRpcError && error.code === 'timeout') {
        log('claude', 'usage-scan-host-timeout', { detail: { host: host.id, ms: Date.now() - t0 } });
      }
      return null;
    }
  }

  private readonly zoneFallbackLogged = new Set<string>();

  private scanAll(): Promise<void> {
    return (this.scanTask ??= this.runScan().finally(() => {
      this.scanTask = null;
    }));
  }

  private async runScan(): Promise<void> {
    this.loadCache();
    const start = Date.now();
    const now = new Date(this.now());
    const timeZone = appTimeZone();
    const current = monthKey(now, timeZone);
    const previous = previousMonthKey(current);
    // Buckets cached under another zone are keyed wrong — rescan in full.
    if (this.cache.timeZone !== undefined && this.cache.timeZone !== timeZone) this.cache.files = {};
    this.cache.timeZone = timeZone;
    const months = new Set([current, previous]);
    let changed = 0;
    let files = 0;
    let skipped = 0;
    try {
      // The local walk is raced against HOST_FS_BUDGET_MS and lands in skippedHosts on
      // timeout. WSL hosts are scanned inside the distro (`usage.scan` over
      // the helper channel, 60 s timeout); its per-file cache lives in the
      // helper, so nothing of theirs enters this.cache.files.
      const tasks: { host: ExecHost; path: string; key: string }[] = [];
      const skippedHosts = hosts()
        .list()
        .filter((h) => !hosts().fsReady(h))
        .map((h) => h.id);
      const readyHosts = hosts().readyList();
      const scannedHosts = readyHosts.filter((h) => !isRemoteHost(h));
      const remote = Promise.all(
        readyHosts.filter(isRemoteHost).map(async (host) => {
          const result = await this.wslScan(host, [current, previous], timeZone);
          if (!result) skippedHosts.push(host.id);
          return { host, result };
        }),
      );
      const collect = async (host: ExecHost): Promise<{ host: ExecHost; path: string; key: string }[]> => {
        const dir = join(hosts().localConfigDir(), 'projects');
        const found: { host: ExecHost; path: string; key: string }[] = [];
        for await (const path of this.walkJsonl(dir)) {
          found.push({ host, path, key: `${host.id}:${path.slice(dir.length)}` });
        }
        return found;
      };
      const collected = await Promise.all(
        scannedHosts.map(async (host) => {
          const t0 = Date.now();
          const result = await this.fsRace(collect(host));
          if (result.timedOut) {
            log('claude', 'usage-scan-host-timeout', {
              detail: { host: host.id, ms: Date.now() - t0 },
            });
            skippedHosts.push(host.id);
            return [];
          }
          return result.ok ? (result.value ?? []) : [];
        }),
      );
      for (const batch of collected) tasks.push(...batch);
      files = tasks.length;
      const perHost: Record<string, ClaudeTokenTotals> = {};
      let globalBuckets: UsageBuckets = {};
      let done = 0;
      let lastPublish = 0;
      // Worker pool: reads are IO-bound (UNC in particular), so N files are in
      // flight at once; merges are commutative (mergeBuckets) so completion
      // order doesn't affect the result.
      let index = 0;
      const worker = async (): Promise<void> => {
        while (index < tasks.length) {
          const task = tasks[index++]!;
          const cached = this.cache.files[task.key];
          const stat = await statFile(task.path);
          const plan = fileScanPlan(cached, stat.size, stat.mtimeMs);
          let buckets: UsageBuckets = cached?.buckets ?? {};
          if (plan !== 'reuse' && !fileMayContainMonths(stat.mtimeMs, months, timeZone)) {
            // Older than the previous month — can't contain relevant lines;
            // skip the read and pin it as fully consumed.
            skipped += 1;
            this.cache.files[task.key] = {
              size: stat.size,
              mtime: stat.mtimeMs,
              offset: stat.size,
              buckets: {},
            };
          } else if (plan !== 'reuse') {
            changed += 1;
            let offset = plan === 'append' && cached ? cached.offset : 0;
            // Line-aligned append: if the byte before the offset isn't a line
            // break the cached offset is mid-line → re-read the whole file.
            if (offset > 0 && (await this.byteAt(task.path, offset - 1)) !== 0x0a) offset = 0;
            const lines = await this.readLines(task.path, offset);
            const fresh = aggregateUsageLines(lines, { months, timeZone });
            buckets = offset > 0 ? mergeBuckets(cached!.buckets, fresh) : fresh;
            this.cache.files[task.key] = {
              size: stat.size,
              mtime: stat.mtimeMs,
              offset: stat.size,
              buckets,
            };
          }
          done += 1;
          for (const totals of Object.values(buckets[current]?.byModel ?? {})) {
            const into = (perHost[task.host.id] ??= emptyTotals());
            into.input += totals.input;
            into.output += totals.output;
            into.cacheRead += totals.cacheRead;
            into.cacheWrite += totals.cacheWrite;
            into.messages += totals.messages;
          }
          globalBuckets = mergeBuckets(globalBuckets, buckets);
          if (done % CHUNK_FILES === 0) {
            if (Date.now() - lastPublish > PROGRESS_MS) {
              lastPublish = Date.now();
              const progress = { files, done };
              this.store.update((state) => ({
                ...state,
                tokens: { ...state.tokens, scanning: progress },
              }));
            }
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SCAN_WORKERS, tasks.length) }, () => worker()),
      );
      let wslFiles = 0;
      let zoneFallback = false;
      for (const { host, result } of await remote) {
        if (!result) continue;
        wslFiles += result.files;
        // The distro's Node can't resolve the app's zone: reported once per host.
        if (result.zoneFallback && !this.zoneFallbackLogged.has(host.id)) {
          this.zoneFallbackLogged.add(host.id);
          zoneFallback = true;
        }
        changed += result.changed;
        skipped += result.skipped;
        const byModel = Object.values(result.buckets[current]?.byModel ?? {});
        if (byModel.length > 0) perHost[host.id] = sumTotals(byModel);
        globalBuckets = mergeBuckets(globalBuckets, result.buckets);
      }
      const month = globalBuckets[current] ?? { byModel: {}, byDay: {} };
      const tokens = {
        total: sumTotals(Object.values(month.byModel)),
        byModel: month.byModel,
        byHost: perHost,
        byDay: Object.entries(month.byDay)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, byModel]) => ({ date, byModel })),
        previousMonthTotal:
          globalBuckets[previous] != null
            ? sumTotals(Object.values(globalBuckets[previous]!.byModel))
            : null,
        scannedAt: new Date(this.now()).toISOString(),
        scanning: null,
      };
      this.store.update((state) => ({ ...state, month: current, tokens }));
      // Only `tasks` feed the totals, so stale keys never count — but prune
      // them from the file (e.g. local: keys left by a pre-fix scan that read
      // a WSL store as local) so the cache doesn't carry them forever.
      const pruned = pruneFileCache(
        this.cache.files,
        // Every ready host, wsl included: wsl keys left by pre-helper builds drop out.
        readyHosts.map((h) => h.id),
        tasks.map((t) => t.key),
      );
      if (pruned.pruned > 0) {
        this.cache.files = pruned.files;
        log('claude', 'usage-cache-pruned', { detail: { count: pruned.pruned } });
      }
      this.saveCache();
      log('claude', 'usage-scan', {
        detail: {
          files: files + wslFiles,
          wslFiles,
          changed,
          skipped,
          skippedHosts,
          ...(zoneFallback ? { zoneFallback } : {}),
          ms: Date.now() - start,
        },
      });
    } catch {
      /* stat failures mid-scan are non-fatal */
    }
  }
}

let singleton: ClaudeUsageService | null = null;
export function claudeUsage(): ClaudeUsageService {
  return (singleton ??= new ClaudeUsageService());
}
