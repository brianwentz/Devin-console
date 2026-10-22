// Pure helpers for the Claude analytics tab (plan D1–D3): the /usage response
// parser, the transcript usage aggregator, and the small gauge/format math the
// panel needs. No I/O — the main-process service feeds lines/JSON in.

import type {
  HostId,
  ClaudeTokenTotals,
  ClaudeUsageAccount,
  ClaudeUsageLimit,
  ClaudeUsageState,
} from '../shared/ipc';

// --- parsing: GET /api/oauth/usage -------------------------------------------

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);

const SEVERITIES = new Set(['normal', 'warning', 'critical']);
export function severityFor(percent: number): ClaudeUsageLimit['severity'] {
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'normal';
}

const clamp = (p: unknown): number => Math.max(0, Math.min(100, Number(p) || 0));

function labelFor(kind: string, limit: Raw): string {
  if (kind === 'session') return 'Current session';
  if (kind === 'weekly_all') return 'Current week (all models)';
  if (kind === 'weekly_scoped') {
    const scope = isObj(limit.scope) ? limit.scope : {};
    const model = isObj(scope.model) ? scope.model : {};
    const name = typeof model.display_name === 'string' ? model.display_name : null;
    return name ? `Current week (${name})` : 'Current week (scoped)';
  }
  return kind;
}

function limitFrom(
  kind: ClaudeUsageLimit['kind'],
  rawKind: string,
  limit: Raw,
): ClaudeUsageLimit {
  const percent = clamp(limit.percent);
  const severity = typeof limit.severity === 'string' && SEVERITIES.has(limit.severity)
    ? (limit.severity as ClaudeUsageLimit['severity'])
    : severityFor(percent);
  return {
    kind,
    label: labelFor(rawKind, limit),
    percent,
    severity,
    resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
    active: typeof limit.is_active === 'boolean' ? limit.is_active : true,
  };
}

// A `five_hour`/`seven_day` body key (no `limits[]` on older/shorter responses).
function synthLimit(kind: ClaudeUsageLimit['kind'], raw: unknown): ClaudeUsageLimit | null {
  if (!isObj(raw)) return null;
  const percent = clamp(raw.utilization);
  return {
    kind,
    label: labelFor(kind, {}),
    percent,
    severity: severityFor(percent),
    resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
    active: true,
  };
}

function parseCredits(body: Raw): ClaudeUsageAccount['credits'] {
  const spend = isObj(body.spend) ? body.spend : null;
  if (spend) {
    const used = isObj(spend.used) ? spend.used : {};
    const limit = isObj(spend.limit) ? spend.limit : null;
    return {
      enabled: spend.enabled !== false,
      usedMinor: Number(used.amount_minor) || 0,
      limitMinor: limit && typeof limit.amount_minor === 'number' ? limit.amount_minor : null,
      currency: String(used.currency ?? 'USD'),
      percent: typeof spend.percent === 'number' ? clamp(spend.percent) : null,
    };
  }
  const extra = isObj(body.extra_usage) ? body.extra_usage : null;
  if (extra) {
    // used_credits is in major units with `decimal_places` decimals → minor.
    const places = Number(extra.decimal_places) || 0;
    const usedMajor = Number(extra.used_credits) || 0;
    const limitMajor = Number(extra.monthly_limit);
    return {
      enabled: extra.is_enabled === true,
      usedMinor: Math.round(usedMajor * 10 ** places),
      limitMinor: Number.isFinite(limitMajor) ? Math.round(limitMajor * 10 ** places) : null,
      currency: String(extra.currency ?? 'USD'),
      percent: typeof extra.utilization === 'number' ? clamp(extra.utilization) : null,
    };
  }
  return null;
}

export function parseUsageResponse(json: unknown): {
  limits: ClaudeUsageLimit[];
  credits: ClaudeUsageAccount['credits'];
} {
  const body = isObj(json) ? json : {};
  const rawLimits = Array.isArray(body.limits) ? body.limits : [];
  const limits: ClaudeUsageLimit[] = [];
  if (rawLimits.length > 0) {
    for (const raw of rawLimits) {
      if (!isObj(raw)) continue;
      const kind =
        raw.kind === 'session' || raw.kind === 'weekly_all' || raw.kind === 'weekly_scoped'
          ? raw.kind
          : 'other';
      limits.push(limitFrom(kind, String(raw.kind ?? 'other'), raw));
    }
  } else {
    const session = synthLimit('session', body.five_hour);
    const weekly = synthLimit('weekly_all', body.seven_day);
    if (session) limits.push(session);
    if (weekly) limits.push(weekly);
  }
  return { limits, credits: parseCredits(body) };
}

// --- transcript aggregation --------------------------------------------------

export type UsageBuckets = {
  [yyyyMm: string]: {
    byModel: Record<string, ClaudeTokenTotals>;
    // day → model → input+output+cacheRead+cacheWrite
    byDay: Record<string, Record<string, number>>;
  };
};

export function emptyTotals(): ClaudeTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
}

export function monthKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${m}`;
}

export function previousMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y!, m! - 2, 1);
  return monthKey(d);
}

function addTotals(into: ClaudeTokenTotals, usage: Raw): void {
  into.input += Number(usage.input_tokens) || 0;
  into.output += Number(usage.output_tokens) || 0;
  into.cacheRead += Number(usage.cache_read_input_tokens) || 0;
  into.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
  into.messages += 1;
}

/**
 * Fold `type:'assistant'` transcript lines into per-month buckets. Dedupes on
 * `requestId` (a streamed message lands as several lines with one id) with
 * `uuid` as the fallback; malformed lines and non-assistant types are skipped.
 */
export function aggregateUsageLines(
  lines: Iterable<string>,
  opts: { months?: Set<string> } = {},
): UsageBuckets {
  const out: UsageBuckets = {};
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(parsed) || parsed.type !== 'assistant' || !isObj(parsed.message)) continue;
    const usage = parsed.message.usage;
    if (!isObj(usage)) continue;
    const key =
      typeof parsed.requestId === 'string'
        ? parsed.requestId
        : typeof parsed.uuid === 'string'
          ? parsed.uuid
          : null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const date = new Date(String(parsed.timestamp ?? ''));
    if (Number.isNaN(date.getTime())) continue;
    const month = monthKey(date);
    if (opts.months && !opts.months.has(month)) continue;
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
    const model = typeof parsed.message.model === 'string' ? parsed.message.model : 'unknown';
    const perModel =
      (Number(usage.input_tokens) || 0) +
      (Number(usage.output_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0);
    // Zero-token lines (e.g. `<synthetic>`) contribute nothing — drop the
    // whole line rather than leaving an all-zero model row.
    if (perModel === 0) continue;
    const bucket = (out[month] ??= { byModel: {}, byDay: {} });
    addTotals((bucket.byModel[model] ??= emptyTotals()), usage);
    const perDay = (bucket.byDay[day] ??= {});
    perDay[model] = (perDay[model] ?? 0) + perModel;
  }
  return out;
}

export function mergeBuckets(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  const out: UsageBuckets = { ...a };
  for (const [month, mb] of Object.entries(b)) {
    const into = (out[month] ??= { byModel: {}, byDay: {} });
    for (const [model, totals] of Object.entries(mb.byModel)) {
      const cur = (into.byModel[model] ??= emptyTotals());
      cur.input += totals.input;
      cur.output += totals.output;
      cur.cacheRead += totals.cacheRead;
      cur.cacheWrite += totals.cacheWrite;
      cur.messages += totals.messages;
    }
    for (const [day, models] of Object.entries(mb.byDay)) {
      const cur = (into.byDay[day] ??= {});
      for (const [model, n] of Object.entries(models)) cur[model] = (cur[model] ?? 0) + n;
    }
  }
  return out;
}

export function sumTotals(list: Iterable<ClaudeTokenTotals>): ClaudeTokenTotals {
  const out = emptyTotals();
  for (const t of list) {
    out.input += t.input;
    out.output += t.output;
    out.cacheRead += t.cacheRead;
    out.cacheWrite += t.cacheWrite;
    out.messages += t.messages;
  }
  return out;
}

// --- gauge + label math ------------------------------------------------------

/**
 * SVG path of a 270° gauge arc: the sweep starts at bottom-left (135°) and
 * runs clockwise through the top; `percent` of the sweep is drawn.
 */
export function gaugeArc(percent: number, r: number, cx: number, cy: number): string {
  const start = 135;
  const end = start + (270 * Math.max(0, Math.min(100, percent))) / 100;
  const rad = (a: number) => (a * Math.PI) / 180;
  const x = (a: number) => cx + r * Math.cos(rad(a));
  const y = (a: number) => cy + r * Math.sin(rad(a));
  const large = end - start > 180 ? 1 : 0;
  return `M ${x(start).toFixed(2)} ${y(start).toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x(end).toFixed(2)} ${y(end).toFixed(2)}`;
}

/** Compact "until" label: "1d 3h", "3h 20m", "12m", "now". */
export function resetsIn(nowMs: number, resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - nowMs;
  if (ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Incremental-scan decision: cached file metadata → read plan. */
export function fileScanPlan(
  prev: { size: number; mtime: number; offset: number } | undefined,
  size: number,
  mtime: number,
): 'reuse' | 'append' | 'full' {
  if (!prev) return 'full';
  if (prev.size === size && prev.mtime === mtime) return 'reuse';
  if (size > prev.size) return 'append';
  return 'full'; // shrunk or rewritten
}

/**
 * Cold-scan gate: a file whose mtime is older than the start of the earliest
 * month of interest can't contain lines from any requested month (line
 * timestamps precede the file's last write) → skip reading it entirely.
 */
export function fileMayContainMonths(mtimeMs: number, months: Set<string>): boolean {
  if (months.size === 0) return true;
  let earliest: number | null = null;
  for (const key of months) {
    const [y, m] = key.split('-').map(Number);
    if (!y || !m) continue;
    const start = new Date(y, m - 1, 1).getTime(); // local midnight of the 1st
    if (earliest === null || start < earliest) earliest = start;
  }
  return earliest === null || mtimeMs >= earliest;
}

/** Group per-host credentials into usage accounts: same email → one account. */
export function groupAccounts(
  creds: { hostId: HostId; email: string | null; organization: string | null; plan: string | null }[],
): { key: string; email: string | null; organization: string | null; plan: string | null; hostIds: HostId[] }[] {
  const groups = new Map<
    string,
    { key: string; email: string | null; organization: string | null; plan: string | null; hostIds: HostId[] }
  >();
  for (const cred of creds) {
    const key = cred.email ?? `host:${cred.hostId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        email: cred.email,
        organization: cred.organization,
        plan: cred.plan,
        hostIds: [],
      };
      groups.set(key, group);
    }
    group.hostIds.push(cred.hostId);
  }
  return [...groups.values()];
}

/** Drop per-file cache entries that belong to a host scanned this pass but no
 * longer map to a file under that host's store (`<hostId>:<relative path>`
 * keys). Entries for hosts that were *not* scanned (a stopped/disabled distro)
 * are kept so their incremental state survives. Returns the pruned map and
 * the count removed; the input is not mutated. */
export function pruneFileCache<T>(
  files: Record<string, T>,
  scannedHosts: Iterable<string>,
  liveKeys: Iterable<string>,
): { files: Record<string, T>; pruned: number } {
  const prefixes = [...new Set(scannedHosts)].map((id) => `${id}:`);
  const live = new Set(liveKeys);
  const out: Record<string, T> = {};
  let pruned = 0;
  for (const [key, entry] of Object.entries(files)) {
    if (!live.has(key) && prefixes.some((p) => key.startsWith(p))) {
      pruned += 1;
      continue;
    }
    out[key] = entry;
  }
  return { files: out, pruned };
}

/** Idle pushed-state seed for the service to emit before the first scan. */
export function emptyClaudeUsageState(month: string): ClaudeUsageState {
  return {
    status: 'idle',
    accounts: [],
    perToken: false,
    month,
    tokens: {
      total: emptyTotals(),
      byModel: {},
      byHost: {},
      byDay: [],
      previousMonthTotal: null,
      scannedAt: null,
      scanning: null,
    },
  };
}
