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
