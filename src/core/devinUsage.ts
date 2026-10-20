// Pure helpers for the Devin Cloud usage metric: parsing of
// GET /api/personal-analytics/usage-limit. No I/O — the main-process
// service fetches the body and feeds it in.

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface DevinUsageSnapshot {
  tierName: string | null;
  cycleUsage: number; // ACUs used this billing cycle
  cycleLimit: number | null; // null when absent or <= 0
  estimatedCycleUsage: number | null;
  cycleStart: string | null; // ISO string as returned (period key)
  cycleEnd: string | null;
  percent: number | null; // cycleUsage / cycleLimit * 100, >= 0, NOT clamped at 100; null when cycleLimit is null
}

/** Parse the usage-limit body. Returns null unless `cycle_usage` is a finite number (unrecognised shape → never a guess). */
export function parseUsageLimit(json: unknown): DevinUsageSnapshot | null {
  if (!isObj(json)) return null;
  const cycleUsage = numOrNull(json.cycle_usage);
  if (cycleUsage === null) return null;
  const rawLimit = numOrNull(json.cycle_usage_limit);
  const cycleLimit = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
  return {
    tierName: strOrNull(json.tier_name),
    cycleUsage,
    cycleLimit,
    estimatedCycleUsage: numOrNull(json.estimated_cycle_usage),
    cycleStart: strOrNull(json.cycle_start),
    cycleEnd: strOrNull(json.cycle_end),
    percent: cycleLimit === null ? null : Math.max(0, (cycleUsage / cycleLimit) * 100),
  };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact ACU figure: 1,405 — locale-fixed so shells/tests agree. */
export function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** 'Nov 1'-style date from an ISO timestamp's local date part (tz-independent). */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTH_SHORT[Number(m[2]) - 1]} ${Number(m[3])}`;
}
