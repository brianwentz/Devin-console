// UsageSource: a provider runtime's usage readings (alerts) and rail/summary
// items (ShellState.usage). UsageAlertStore subscribes to every runtime's
// `usage`; window.ts usageSummary() loops over them. Electron-free: the
// services publish into a UsageFeed at the moment they used to feed the alert
// store directly (Devin after a fresh parse, Claude at the end of runFetch).

import type { ProviderId, ProviderSource } from '../../core/providers';
import type { UsageMetric, UsageReading as AlertReading } from '../../core/usageAlerts';

export interface UsageReading {
  metric: UsageMetric;
  /** '' for Devin; the Claude account key (email, else `host:<id>`). */
  account: string;
  percent: number;
  periodKey: string;
  /** Stale readings never alert (a cached body is not a new crossing). */
  stale: boolean;
  /** Notification body for an alert on this reading. */
  body: string;
}

/** One row of ShellState.usage.items. */
export interface UsageSummaryItem {
  metric: UsageMetric;
  accountKey: string;
  label: string;
  percent: number;
}

export interface UsageSource {
  providerId: ProviderId;
  /** Notification source stamped on this provider's usage alert entries. */
  source: ProviderSource;
  /** The readings of the last publish. */
  readings(): UsageReading[];
  /** Current summary items (may be several: one per account × limit). */
  summary(): UsageSummaryItem[];
  /** Fires on every publish; returns the unsubscribe. */
  onChange(cb: () => void): () => void;
}

export class UsageFeed {
  private current: UsageReading[] = [];
  private readonly listeners = new Set<() => void>();

  publish(readings: UsageReading[]): void {
    this.current = readings;
    for (const listener of [...this.listeners]) listener();
  }

  readings(): UsageReading[] {
    return this.current;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

// `feed` is a getter: runtime modules only build objects at top level (they
// sit in import cycles), so the service module is resolved on first use.
export function usageSource(opts: {
  providerId: ProviderId;
  source: ProviderSource;
  feed: () => UsageFeed;
  summary: () => UsageSummaryItem[];
}): UsageSource {
  return {
    providerId: opts.providerId,
    source: opts.source,
    readings: () => opts.feed().readings(),
    summary: opts.summary,
    onChange: (cb) => opts.feed().onChange(cb),
  };
}

export interface UsageAlertInput extends AlertReading {
  body: string;
  source: ProviderSource;
}

/** A source's current readings as deriveUsageAlerts inputs — stale ones dropped. */
export function alertInputs(usage: UsageSource): UsageAlertInput[] {
  return usage
    .readings()
    .filter((r) => !r.stale)
    .map((r) => ({
      metric: r.metric,
      accountKey: r.account,
      percent: r.percent,
      periodKey: r.periodKey,
      body: r.body,
      source: usage.source,
    }));
}

/**
 * Evaluates each source's non-stale readings on every publish. Idempotent per
 * source through `seen` (createWindow can run again on macOS `activate`).
 */
export function subscribeUsage(
  sources: readonly (UsageSource | undefined)[],
  evaluate: (inputs: UsageAlertInput[]) => void,
  seen: Set<UsageSource>,
): void {
  for (const usage of sources) {
    if (!usage || seen.has(usage)) continue;
    seen.add(usage);
    usage.onChange(() => evaluate(alertInputs(usage)));
  }
}

/** Summary items of every source in order (runtimes without usage skipped). */
export function usageSummaryItems(sources: readonly (UsageSource | undefined)[]): UsageSummaryItem[] {
  return sources.flatMap((s) => s?.summary() ?? []);
}
