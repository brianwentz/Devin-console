// Usage alerts — threshold ledger + level/label helpers.
import { describe, expect, it } from 'vitest';
import { PROVIDER_USAGE_METRICS, UsageMetricSchema } from '../../src/core/providers';
import {
  USAGE_METRIC_LABEL,
  deriveUsageAlerts,
  emptyUsageLedger,
  ledgerKey,
  usageAlertTitle,
  usageLevel,
  type UsageAlert,
  type UsageLedger,
  type UsageReading,
} from '../../src/core/usageAlerts';
import {
  UsageFeed,
  alertInputs,
  subscribeUsage,
  type UsageAlertInput,
  usageSource,
  usageSummaryItems,
  type UsageReading as SourceReading,
  type UsageSummaryItem,
} from '../../src/main/cloudKit/usage';

const reading = (percent: number, periodKey = 'p1'): UsageReading => ({
  metric: 'devin-monthly',
  accountKey: '',
  percent,
  periodKey,
});

describe('deriveUsageAlerts', () => {
  it('fires 50 on first crossing, then stays silent', () => {
    const first = deriveUsageAlerts(emptyUsageLedger(), [reading(55)]);
    expect(first.alerts).toEqual([
      {
        metric: 'devin-monthly',
        accountKey: '',
        threshold: 50,
        percent: 55,
        periodKey: 'p1',
      },
    ]);
    const again = deriveUsageAlerts(first.ledger, [reading(55)]);
    expect(again.alerts).toEqual([]);
  });

  it('55→85 fires only 80', () => {
    const first = deriveUsageAlerts(emptyUsageLedger(), [reading(55)]);
    const second = deriveUsageAlerts(first.ledger, [reading(85)]);
    expect(second.alerts).toHaveLength(1);
    expect(second.alerts[0]!.threshold).toBe(80);
  });

  it('40→85 from empty fires only 80 but marks fired [50,80]', () => {
    const { ledger, alerts } = deriveUsageAlerts(emptyUsageLedger(), [reading(85)]);
    expect(alerts.map((a) => a.threshold)).toEqual([80]);
    expect(ledger.entries[ledgerKey('devin-monthly', '')]!.fired).toEqual([50, 80]);
    // subsequent 60 fires nothing — 50 was recorded as crossed
    const next = deriveUsageAlerts(ledger, [reading(60)]);
    expect(next.alerts).toEqual([]);
  });

  it('new periodKey re-arms', () => {
    const first = deriveUsageAlerts(emptyUsageLedger(), [reading(55, 'p1')]);
    const second = deriveUsageAlerts(first.ledger, [reading(52, 'p2')]);
    expect(second.alerts.map((a) => a.threshold)).toEqual([50]);
    expect(second.ledger.entries[ledgerKey('devin-monthly', '')]).toEqual({
      periodKey: 'p2',
      fired: [50],
    });
  });

  it('drop 85→60 within a period fires nothing', () => {
    const first = deriveUsageAlerts(emptyUsageLedger(), [reading(85)]);
    const second = deriveUsageAlerts(first.ledger, [reading(60)]);
    expect(second.alerts).toEqual([]);
  });

  it('Claude accounts alert independently', () => {
    const r = (accountKey: string, percent: number): UsageReading => ({
      metric: 'claude-weekly',
      accountKey,
      percent,
      periodKey: 'w1',
    });
    const { alerts, ledger } = deriveUsageAlerts(emptyUsageLedger(), [
      r('a@x.com', 55),
      r('b@x.com', 85),
    ]);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ accountKey: 'a@x.com', threshold: 50 });
    expect(alerts[1]).toMatchObject({ accountKey: 'b@x.com', threshold: 80 });
    const again = deriveUsageAlerts(ledger, [r('a@x.com', 90), r('b@x.com', 60)]);
    expect(again.alerts).toHaveLength(1);
    expect(again.alerts[0]!).toMatchObject({ accountKey: 'a@x.com', threshold: 80 });
  });

  it('NaN percent is skipped and the entry preserved', () => {
    const first = deriveUsageAlerts(emptyUsageLedger(), [reading(55)]);
    const second = deriveUsageAlerts(first.ledger, [reading(NaN)]);
    expect(second.alerts).toEqual([]);
    expect(second.ledger).toEqual(first.ledger);
  });

  it('untouched keys carry over', () => {
    const seeded: UsageLedger = {
      version: 1,
      entries: { 'claude-session:me@x.com': { periodKey: 's1', fired: [50] } },
    };
    const { ledger, alerts } = deriveUsageAlerts(seeded, [reading(55)]);
    expect(alerts).toHaveLength(1);
    expect(ledger.entries['claude-session:me@x.com']).toEqual({
      periodKey: 's1',
      fired: [50],
    });
  });

  it('does not mutate the input ledger', () => {
    const ledger = emptyUsageLedger();
    deriveUsageAlerts(ledger, [reading(85)]);
    expect(ledger.entries).toEqual({});
  });
});

describe('usageLevel', () => {
  it('boundaries', () => {
    expect(usageLevel([49.9])).toBe('none');
    expect(usageLevel([50])).toBe('warn');
    expect(usageLevel([79.9])).toBe('warn');
    expect(usageLevel([80])).toBe('critical');
    expect(usageLevel([])).toBe('none');
    expect(usageLevel([NaN, 20])).toBe('none');
    expect(usageLevel([NaN, Infinity, 90])).toBe('critical');
  });
});

describe('usageAlertTitle', () => {
  it('renders label + threshold', () => {
    const alert: UsageAlert = {
      metric: 'claude-session',
      accountKey: 'me@x.com',
      threshold: 80,
      percent: 83,
      periodKey: 's1',
    };
    expect(usageAlertTitle(alert)).toBe('Claude session limit: 80% used');
  });
});

describe('provider-derived metric enum', () => {
  it('UsageMetricSchema options equal PROVIDER_USAGE_METRICS', () => {
    expect([...UsageMetricSchema.options]).toEqual([...PROVIDER_USAGE_METRICS]);
  });
  it('metric labels keep their text', () => {
    expect(USAGE_METRIC_LABEL['devin-monthly']).toBe('Devin Cloud monthly ACUs');
  });
});
// UsageSource seam (src/main/cloudKit/usage.ts): every provider runtime's
// usage feeds the same pure deriveUsageAlerts.
describe('UsageSource → deriveUsageAlerts (multi-source)', () => {
  const fakeSource = (
    providerId: 'devin-cloud' | 'claude',
    source: 'devin' | 'claude',
    summary: UsageSummaryItem[] = [],
  ) => {
    const feed = new UsageFeed();
    return { feed, usage: usageSource({ providerId, source, feed: () => feed, summary: () => summary }) };
  };
  const sr = (over: Partial<SourceReading> & Pick<SourceReading, 'metric' | 'percent'>): SourceReading => ({
    account: '',
    periodKey: 'p1',
    stale: false,
    body: 'b',
    ...over,
  });

  it('fires per metric independently across two sources', () => {
    const devin = fakeSource('devin-cloud', 'devin');
    const other = fakeSource('claude', 'claude');
    devin.feed.publish([sr({ metric: 'devin-monthly', percent: 85 })]);
    other.feed.publish([sr({ metric: 'claude-session', account: 'me@x.com', percent: 55, periodKey: 's1' })]);
    const inputs = [...alertInputs(devin.usage), ...alertInputs(other.usage)];
    expect(inputs.map((i) => [i.metric, i.accountKey, i.source])).toEqual([
      ['devin-monthly', '', 'devin'],
      ['claude-session', 'me@x.com', 'claude'],
    ]);
    const { alerts, ledger } = deriveUsageAlerts(emptyUsageLedger(), inputs);
    expect(alerts.map((a) => [a.metric, a.accountKey, a.threshold])).toEqual([
      ['devin-monthly', '', 80],
      ['claude-session', 'me@x.com', 50],
    ]);
    expect(ledger.entries[ledgerKey('devin-monthly', '')]).toEqual({ periodKey: 'p1', fired: [50, 80] });
    expect(ledger.entries[ledgerKey('claude-session', 'me@x.com')]).toEqual({ periodKey: 's1', fired: [50] });
  });

  it('drops stale readings before alerting', () => {
    const src = fakeSource('claude', 'claude');
    src.feed.publish([
      sr({ metric: 'claude-session', account: 'a', percent: 90, stale: true }),
      sr({ metric: 'claude-weekly', account: 'b', percent: 60 }),
    ]);
    expect(alertInputs(src.usage).map((i) => [i.metric, i.accountKey])).toEqual([['claude-weekly', 'b']]);
  });

  it('onChange fires on publish and unsubscribes', () => {
    const src = fakeSource('devin-cloud', 'devin');
    let calls = 0;
    const off = src.usage.onChange(() => calls++);
    src.feed.publish([sr({ metric: 'devin-monthly', percent: 10 })]);
    expect(calls).toBe(1);
    expect(src.usage.readings()).toHaveLength(1);
    off();
    src.feed.publish([]);
    expect(calls).toBe(1);
  });

  it('subscribeUsage evaluates non-stale inputs per publish, once per source', () => {
    const devin = fakeSource('devin-cloud', 'devin');
    const claude = fakeSource('claude', 'claude');
    const calls: UsageAlertInput[][] = [];
    const seen = new Set<ReturnType<typeof usageSource>>();
    subscribeUsage([devin.usage, undefined, claude.usage], (inputs) => calls.push(inputs), seen);
    subscribeUsage([devin.usage, claude.usage], (inputs) => calls.push(inputs), seen); // repeat: no-op
    devin.feed.publish([sr({ metric: 'devin-monthly', percent: 85, body: 'acu' })]);
    claude.feed.publish([
      sr({ metric: 'claude-session', account: 'a', percent: 90, stale: true }),
      sr({ metric: 'claude-weekly', account: 'b', percent: 55 }),
    ]);
    expect(calls).toEqual([
      [{ metric: 'devin-monthly', accountKey: '', percent: 85, periodKey: 'p1', body: 'acu', source: 'devin' }],
      [{ metric: 'claude-weekly', accountKey: 'b', percent: 55, periodKey: 'p1', body: 'b', source: 'claude' }],
    ]);
  });

  it('summary items flatten in source order, skipping runtimes without usage', () => {
    const item = (metric: UsageSummaryItem['metric'], percent: number): UsageSummaryItem => ({
      metric,
      accountKey: '',
      label: metric,
      percent,
    });
    const devin = fakeSource('devin-cloud', 'devin', [item('devin-monthly', 40)]);
    const claude = fakeSource('claude', 'claude', [item('claude-session', 10), item('claude-weekly', 20)]);
    expect(usageSummaryItems([devin.usage, undefined, claude.usage]).map((i) => i.metric)).toEqual([
      'devin-monthly',
      'claude-session',
      'claude-weekly',
    ]);
  });
});
