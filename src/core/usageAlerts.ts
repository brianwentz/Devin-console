// Pure helpers for usage alerts: threshold bookkeeping across metrics and
// accounts. No I/O — the caller supplies readings and persists the ledger.

export type UsageMetric = 'devin-monthly' | 'claude-session' | 'claude-weekly';
export const USAGE_THRESHOLDS = [50, 80] as const;
export type UsageThreshold = (typeof USAGE_THRESHOLDS)[number];

export interface UsageReading {
  metric: UsageMetric;
  accountKey: string;
  percent: number;
  periodKey: string;
}
// accountKey: '' for Devin; the Claude account key (email) for Claude metrics —
// several Claude accounts alert independently.

export interface UsageLedgerEntry {
  periodKey: string;
  fired: UsageThreshold[];
}
export interface UsageLedger {
  version: 1;
  entries: Record<string, UsageLedgerEntry>; // key = `${metric}:${accountKey}`
}

export interface UsageAlert {
  metric: UsageMetric;
  accountKey: string;
  threshold: UsageThreshold;
  percent: number;
  periodKey: string;
}

export function emptyUsageLedger(): UsageLedger {
  return { version: 1, entries: {} };
}

export function ledgerKey(metric: UsageMetric, accountKey: string): string {
  return `${metric}:${accountKey}`;
}

export function deriveUsageAlerts(
  ledger: UsageLedger,
  readings: readonly UsageReading[],
): { ledger: UsageLedger; alerts: UsageAlert[] } {
  const entries: Record<string, UsageLedgerEntry> = { ...ledger.entries };
  const alerts: UsageAlert[] = [];
  for (const reading of readings) {
    if (!Number.isFinite(reading.percent)) continue;
    const key = ledgerKey(reading.metric, reading.accountKey);
    const existing = entries[key];
    const entry =
      !existing || existing.periodKey !== reading.periodKey
        ? { periodKey: reading.periodKey, fired: [] as UsageThreshold[] }
        : existing;
    const crossed = USAGE_THRESHOLDS.filter((t) => t <= reading.percent);
    const newly = crossed.filter((t) => !entry.fired.includes(t));
    if (newly.length > 0) {
      alerts.push({
        metric: reading.metric,
        accountKey: reading.accountKey,
        threshold: Math.max(...newly) as UsageThreshold,
        percent: reading.percent,
        periodKey: reading.periodKey,
      });
    }
    const fired = [...new Set<UsageThreshold>([...entry.fired, ...crossed])].sort(
      (a, b) => a - b,
    );
    entries[key] = { periodKey: reading.periodKey, fired };
  }
  return { ledger: { version: 1, entries }, alerts };
}

export type UsageLevel = 'none' | 'warn' | 'critical';
export function usageLevel(percents: readonly number[]): UsageLevel {
  let max = -Infinity;
  for (const p of percents) if (Number.isFinite(p) && p > max) max = p;
  if (max >= 80) return 'critical';
  if (max >= 50) return 'warn';
  return 'none';
}

export const USAGE_METRIC_LABEL: Record<UsageMetric, string> = {
  'devin-monthly': 'Devin Cloud monthly ACUs',
  'claude-session': 'Claude session limit',
  'claude-weekly': 'Claude weekly limit',
};

export function usageAlertTitle(alert: UsageAlert): string {
  return `${USAGE_METRIC_LABEL[alert.metric]}: ${alert.threshold}% used`;
}
