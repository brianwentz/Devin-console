import { ANALYTICS_USAGE_ROW_HEIGHT } from '../../../core/layout';
import { fmt, shortDate } from '../../../core/devinUsage';
import type { DevinUsageState, ShellState } from '../../../shared/ipc';
import { useShellState } from '../../store';

// One-line usage summaries under the Analytics tab strip — the strip region
// reserves ANALYTICS_USAGE_ROW_HEIGHT for exactly one of them (core/layout).
// Each provider's row is its PROVIDER_UI `AnalyticsSummary` slot.

export const summaryRowClass = 'flex items-center truncate px-1 pb-1 text-xs text-[#7f8ca0]';

// Claude tab: one line per account — `Session N% · Week N%`, email-prefixed
// only when more than one account has limits.
function ClaudeUsageSummary({ items }: { items: ShellState['usage']['items'] }) {
  const groups = new Map<string, { email: string | null; session: number | null; week: number | null }>();
  for (const item of items) {
    if (!item.metric.startsWith('claude-')) continue;
    const group = groups.get(item.accountKey) ?? {
      email: item.accountKey.startsWith('host:') ? null : item.accountKey,
      session: null,
      week: null,
    };
    if (item.metric === 'claude-session') group.session = item.percent;
    else if (item.metric === 'claude-weekly') group.week = item.percent;
    groups.set(item.accountKey, group);
  }
  const parts = [...groups.values()].map((g) => {
    const metrics = [g.session !== null ? `Session ${Math.round(g.session)}%` : null, g.week !== null ? `Week ${Math.round(g.week ?? 0)}%` : null]
      .filter(Boolean)
      .join(' · ');
    return groups.size > 1 && g.email ? `${g.email} ${metrics}` : metrics;
  });
  return (
    <div
      id="claudeUsageSummary"
      className={summaryRowClass}
      style={{ height: ANALYTICS_USAGE_ROW_HEIGHT }}
    >
      {parts.join(' | ')}
    </div>
  );
}

// Devin tab only: the monthly ACU line.
function DevinUsageSummary({ devin }: { devin: DevinUsageState }) {
  let text: string;
  if (devin.cycleUsage !== null) {
    text =
      devin.cycleLimit !== null
        ? `${fmt(devin.cycleUsage)} / ${fmt(devin.cycleLimit)} ACUs (${Math.round(devin.percent ?? 0)}%)` +
          `${devin.estimatedCycleUsage !== null ? ` · projected ${fmt(devin.estimatedCycleUsage)}` : ''}` +
          `${devin.cycleEnd ? ` · resets ${shortDate(devin.cycleEnd)}` : ''}` +
          `${devin.stale ? ' · cached' : ''}`
        : `${fmt(devin.cycleUsage)} ACUs used this cycle`;
  } else if (devin.status === 'login-required') {
    text = 'Sign in to Devin Cloud to see usage';
  } else {
    text = 'Usage unavailable';
  }
  return (
    <div
      id="devinUsageSummary"
      data-usage-status={devin.status}
      className={summaryRowClass}
      style={{ height: ANALYTICS_USAGE_ROW_HEIGHT }}
    >
      {text}
    </div>
  );
}

export function DevinAnalyticsSummary() {
  const devin = useShellState()?.usage.devin;
  return devin ? <DevinUsageSummary devin={devin} /> : null;
}

export function ClaudeAnalyticsSummary() {
  const state = useShellState();
  return <ClaudeUsageSummary items={state?.usage.items ?? []} />;
}
