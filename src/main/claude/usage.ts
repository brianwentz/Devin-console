// ClaudeUsageService (plan D1–D4, D7): one service owns both Claude-analytics
// data sources — plan limits fetched from the OAuth /usage endpoint, and token
// totals from an incremental transcript aggregator over every enabled host's
// store. Publishes one pushed state on IpcChannels.claudeUsage; started lazily
// on first usage (state invoke / visible / refresh), never at app start.

import { closeSync, createReadStream, existsSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { app } from 'electron';
import { dirname, join } from 'node:path';
import {
  aggregateUsageLines,
  emptyClaudeUsageState,
  fileScanPlan,
  groupAccounts,
  emptyTotals,
  mergeBuckets,
  monthKey,
  parseUsageResponse,
  previousMonthKey,
  sumTotals,
  type UsageBuckets,
} from '../../core/claudeUsage';
import type {
  ClaudeUsageAccount,
  ClaudeUsageState,
  ClaudeTokenTotals,
  HostId,
} from '../../shared/ipc';
import { ClaudeUsageStateSchema, IpcChannels } from '../../shared/ipc';
import { hosts } from '../hosts';
import type { ExecHost } from '../../core/execHost';
import { log } from '../log';
import { createPushedStore } from '../pushedStore';
import { testMode } from '../state';

const FETCH_TIMEOUT_MS = 10_000;
const VISIBLE_MS = 60_000;
const IDLE_FETCH_MS = 10 * 60_000;
const POKE_DEBOUNCE_MS = 5_000;
const CHUNK_FILES = 50;
const PROGRESS_MS = 250;
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
}
const EMPTY_CACHE: UsageCacheFile = { version: 1, files: {}, accounts: {} };

interface HostCreds {
  host: ExecHost;
  accessToken: string;
  expiresAt: number;
  plan: string | null;
  email: string | null;
  organization: string | null;
}

export class ClaudeUsageService {
  private started = false;
  private visible = false;
  private fetchTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private pokeTimer: NodeJS.Timeout | null = null;
  private fetchTask: Promise<void> | null = null;
  private scanTask: Promise<void> | null = null;
  private backoffMs = 60_000;
  private cache: UsageCacheFile = EMPTY_CACHE;
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
    const raw = testMode ? process.env.DEVIN_WORKSPACES_TEST_NOW : undefined;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  }

  get state(): ClaudeUsageState {
    return this.store.get();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadCache();
    void this.fetchAll();
    void this.scanAll();
    this.schedule();
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

  /** Debounced fetch trigger: app-driven turn end or a Stop hook event. */
  poke(_reason: 'turn' | 'hook'): void {
    if (!this.started) return;
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.fetchAll();
    }, POKE_DEBOUNCE_MS);
  }

  dispose(): void {
    for (const t of [this.fetchTimer, this.scanTimer, this.pokeTimer]) {
      if (t) clearTimeout(t);
    }
    this.fetchTimer = this.scanTimer = this.pokeTimer = null;
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

  private credsForHost(host: ExecHost): Omit<HostCreds, 'email' | 'organization'> | null {
    const configDir = hosts().configDir(host);
    const file = join(configDir, '.credentials.json');
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
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

  private accountForHost(host: ExecHost): { email: string | null; organization: string | null } {
    const configDir = hosts().configDir(host);
    const file = testMode
      ? (process.env.DEVIN_WORKSPACES_TEST_CLAUDE_ACCOUNT_FILE ?? null)
      : join(dirname(configDir), '.claude.json');
    if (!file || !existsSync(file)) return { email: null, organization: null };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
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

  // Group hosts by account email (no email → one group per host).
  private readAccounts(): { key: string; email: string | null; organization: string | null; plan: string | null; hosts: HostCreds[] }[] {
    const byHost = new Map<string, HostCreds>();
    const summaries: { hostId: HostId; email: string | null; organization: string | null; plan: string | null }[] = [];
    for (const host of hosts().list()) {
      const creds = this.credsForHost(host);
      if (!creds) continue;
      const account = this.accountForHost(host);
      const member: HostCreds = { ...creds, email: account.email, organization: account.organization };
      byHost.set(host.id, member);
      summaries.push({ hostId: host.id, ...account, plan: creds.plan });
    }
    return groupAccounts(summaries).map((group) => ({
      ...group,
      hosts: group.hostIds.map((id) => byHost.get(id)!),
    }));
  }

  // --- fetch (limits) ----------------------------------------------------------

  private staleBody(accountKey: string, members: HostCreds[]): unknown | null {
    const cached = this.cache.accounts[accountKey];
    if (cached) return cached.lastBody;
    // Fall back to the newest .usage-cache the CLI left on the account's hosts.
    let best: { at: number; body: unknown } | null = null;
    for (const member of members) {
      const file = join(hosts().configDir(member.host), '.usage-cache');
      if (!existsSync(file)) continue;
      try {
        const stat = statSync(file);
        if (!best || stat.mtimeMs > best.at) {
          best = { at: stat.mtimeMs, body: JSON.parse(readFileSync(file, 'utf8')) };
        }
      } catch {
        /* unreadable cache — skip */
      }
    }
    return best?.body ?? null;
  }

  private fetchAll(): Promise<void> {
    return (this.fetchTask ??= this.runFetch().finally(() => {
      this.fetchTask = null;
    }));
  }

  private async runFetch(): Promise<void> {
    try {
      const groups = this.readAccounts();
      const url = testMode
        ? (process.env.DEVIN_WORKSPACES_TEST_CLAUDE_USAGE_URL ?? USAGE_URL)
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
        if (expired) {
          stale = true;
          error = 'Sign-in expired — run claude to refresh';
          body = this.staleBody(group.key, group.hosts);
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
              body = this.staleBody(group.key, group.hosts);
            } else {
              ok = false;
              error = `Fetch failed (HTTP ${status})`;
            }
          } catch {
            ok = false;
            error = 'Fetch failed (network)';
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
          fetchedAt: stale ? null : new Date(this.now()).toISOString(),
          stale,
          error,
        });
      }
      log('claude', 'usage-fetch', {
        detail: { ok, status: ok ? 200 : -1, ms: Date.now() - start, stale: accounts.some((a) => a.stale), accounts: accounts.length },
      });
      this.store.update((state) => ({
        ...state,
        status: 'ready',
        accounts,
        perToken: accounts.length === 0,
      }));
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
        this.cache = parsed.version === 1 ? parsed : EMPTY_CACHE;
      }
    } catch {
      this.cache = EMPTY_CACHE;
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

  private *walkJsonl(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.name.endsWith('.jsonl')) yield path;
      }
    }
  }

  private byteAt(path: string, pos: number): number {
    try {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(1);
        return readSync(fd, buf, 0, 1, pos) === 1 ? buf[0]! : -1;
      } finally {
        closeSync(fd);
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

  private scanAll(): Promise<void> {
    return (this.scanTask ??= this.runScan().finally(() => {
      this.scanTask = null;
    }));
  }

  private async runScan(): Promise<void> {
    this.loadCache();
    const start = Date.now();
    const now = new Date(this.now());
    const current = monthKey(now);
    const previous = previousMonthKey(current);
    const months = new Set([current, previous]);
    let changed = 0;
    let files = 0;
    try {
      const tasks: { host: ExecHost; path: string; key: string }[] = [];
      for (const host of hosts().list()) {
        const dir = join(hosts().configDir(host), 'projects');
        for (const path of this.walkJsonl(dir)) {
          tasks.push({ host, path, key: `${host.id}:${path.slice(dir.length)}` });
        }
      }
      files = tasks.length;
      const perHost: Record<string, ClaudeTokenTotals> = {};
      let globalBuckets: UsageBuckets = {};
      let done = 0;
      let lastPublish = 0;
      for (const task of tasks) {
        const cached = this.cache.files[task.key];
        const stat = statSync(task.path);
        const plan = fileScanPlan(cached, stat.size, stat.mtimeMs);
        let buckets: UsageBuckets = cached?.buckets ?? {};
        if (plan !== 'reuse') {
          changed += 1;
          let offset = plan === 'append' && cached ? cached.offset : 0;
          // Line-aligned append: if the byte before the offset isn't a line
          // break the cached offset is mid-line → re-read the whole file.
          if (offset > 0 && this.byteAt(task.path, offset - 1) !== 0x0a) offset = 0;
          const lines = await this.readLines(task.path, offset);
          const fresh = aggregateUsageLines(lines, { months });
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
      this.saveCache();
      log('claude', 'usage-scan', { detail: { files, changed, ms: Date.now() - start } });
    } catch {
      /* stat failures mid-scan are non-fatal */
    }
  }
}

let singleton: ClaudeUsageService | null = null;
export function claudeUsage(): ClaudeUsageService {
  return (singleton ??= new ClaudeUsageService());
}
