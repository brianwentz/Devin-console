import type { KeyboardEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Rect } from '../../core/layout';
import { ANALYTICS_USAGE_ROW_HEIGHT } from '../../core/layout';
import { PROVIDER_ANALYTICS_TABS } from '../../core/providers';
import { fmt, shortDate } from '../../core/devinUsage';
import type { DevinUsageState, LocalResult, Settings, ShellState } from '../../shared/ipc';
import { useShellState } from '../store';

export type AnalyticsTabId = Settings['analytics']['tab'];

const TAB_LABELS: Record<AnalyticsTabId, string> = { devin: 'Devin', claude: 'Claude' };
const TABS: { id: AnalyticsTabId; label: string }[] = PROVIDER_ANALYTICS_TABS.map((id) => ({
  id,
  label: TAB_LABELS[id],
}));

export const ANALYTICS_TAB_IDS = TABS.map((tab) => tab.id);

type RefreshApi = {
  analyticsRefresh: () => Promise<LocalResult<null> | null>;
  devinUsageRefresh: () => void;
  claudeUsageRefresh: () => Promise<LocalResult<null> | null>;
};

interface AnalyticsTabsProps {
  rect: Rect;
  active: AnalyticsTabId;
  onSelect: (id: AnalyticsTabId) => void;
}

const summaryRowClass =
  'flex items-center truncate px-1 pb-1 text-xs text-[#7f8ca0]';

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

// Devin tab only: one-line usage summary under the tab strip — the strip
// region already reserves ANALYTICS_USAGE_ROW_HEIGHT for it (core/layout).
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

// Shell-rendered tab strip at the top of the Analytics column (plan D5): Devin
// (hosted tenant analytics page below) / Claude (ClaudeAnalyticsPanel). Same
// look and arrow-key behaviour as SettingsTabs. The Refresh button on the
// right re-fetches the Claude usage data; on the Devin tab it reloads the
// hosted page and refreshes the usage metric.
export function AnalyticsTabs({ rect, active, onSelect }: AnalyticsTabsProps) {
  const state = useShellState();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = ANALYTICS_TAB_IDS.indexOf(active);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      ANALYTICS_TAB_IDS[(index + delta + ANALYTICS_TAB_IDS.length) % ANALYTICS_TAB_IDS.length];
    if (next && next !== active) onSelect(next);
  };

  const onRefresh = () => {
    const api = window.agentworkspace as unknown as RefreshApi;
    if (active === 'claude') {
      void api.claudeUsageRefresh();
    } else {
      void api.analyticsRefresh();
      api.devinUsageRefresh();
    }
  };

  const devin = state?.usage.devin;
  const tabsHeight = rect.height - ANALYTICS_USAGE_ROW_HEIGHT;

  return (
    <div
      id="analyticsTabs"
      className="shell-chrome absolute flex flex-col border-b border-[#39475a] bg-[#111827] px-6"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <div className="flex items-end justify-between" style={{ height: tabsHeight }}>
        <div role="tablist" className="flex gap-6" onKeyDown={onKeyDown}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`analyticsTab-${tab.id}`}
              role="tab"
              data-analytics-tab={tab.id}
              aria-selected={active === tab.id}
              tabIndex={active === tab.id ? 0 : -1}
              type="button"
              className="-mb-px border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-[#7f8ca0] hover:text-[#e8edf5] aria-selected:border-[#83b6ff] aria-selected:text-[#e8edf5]"
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          id="analyticsRefresh"
          type="button"
          aria-label="Refresh"
          title={active === 'claude' ? 'Refresh Claude usage' : 'Reload analytics'}
          disabled={false}
          className="mb-1 flex h-6 w-6 items-center justify-center rounded text-[#7f8ca0] hover:bg-[#1c2735] hover:text-[#e8edf5] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#7f8ca0]"
          onClick={onRefresh}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      </div>
      {active === 'devin' ? (
        devin && <DevinUsageSummary devin={devin} />
      ) : (
        <ClaudeUsageSummary items={state?.usage.items ?? []} />
      )}
    </div>
  );
}
