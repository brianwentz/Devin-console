// UsageAlertStore: threshold ledger for usage alerts (Devin Cloud monthly
// ACUs + Claude limits). The ledger file is a cache-class store — no preserve
// spec; an unreadable file starts empty.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  deriveUsageAlerts,
  emptyUsageLedger,
  usageAlertTitle,
  USAGE_METRIC_LABEL,
  type UsageLedger,
  type UsageReading,
} from '../core/usageAlerts';
import { log } from './log';
import { notificationStore } from './notifications';
import { state } from './state';

export interface UsageAlertInput extends UsageReading {
  body: string;
  source: 'devin' | 'claude';
}

export class UsageAlertStore {
  private ledger: UsageLedger;
  private readonly file: string;

  constructor(userData: string) {
    this.file = join(userData, 'usage-alerts.json');
    this.ledger = emptyUsageLedger();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as UsageLedger;
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.ledger = parsed;
      }
    } catch {
      /* missing/corrupt ledger — start empty */
    }
  }

  evaluate(readings: UsageAlertInput[]): void {
    if (readings.length === 0) return;
    const { ledger, alerts } = deriveUsageAlerts(this.ledger, readings);
    // The ledger advances even when the kind is muted — re-enabling must not
    // backfire old crossings.
    if (JSON.stringify(ledger) !== JSON.stringify(this.ledger)) {
      this.ledger = ledger;
      this.persist();
    }
    const notifications = state.settings?.current.notifications;
    const enabled = (notifications?.collect ?? true) && (notifications?.kinds.usage ?? true);
    const byKey = new Map(readings.map((r) => [`${r.metric}:${r.accountKey}`, r]));
    for (const alert of alerts) {
      log('shell', 'usage-alert', {
        detail: { metric: alert.metric, threshold: alert.threshold, percent: Math.round(alert.percent) },
      });
      if (!enabled) continue;
      const input = byKey.get(`${alert.metric}:${alert.accountKey}`)!;
      notificationStore().add({
        kind: 'usage',
        sessionId: null,
        ownerUserId: null,
        source: input.source,
        metric: alert.metric,
        accountKey: alert.accountKey,
        sessionTitle: USAGE_METRIC_LABEL[alert.metric],
        title: usageAlertTitle(alert),
        body: input.body,
        createdAt: Date.now(),
      });
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.ledger));
    } catch (error) {
      log('shell', 'usage-alerts-save-error', { detail: { message: String(error) } });
    }
  }
}

let store: UsageAlertStore | null = null;

export function usageAlertStore(userData?: string): UsageAlertStore {
  if (!store) {
    if (!userData) throw new Error('usageAlertStore not initialised');
    store = new UsageAlertStore(userData);
  }
  return store;
}
