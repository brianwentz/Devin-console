import type { KeyboardEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Rect } from '../../core/layout';
import { ANALYTICS_USAGE_ROW_HEIGHT } from '../../core/layout';
import { PROVIDERS, PROVIDER_ANALYTICS_TABS } from '../../core/providers';
import type { Settings } from '../../shared/ipc';
import { PROVIDER_UI } from '../providers';

export type AnalyticsTabId = Settings['analytics']['tab'];

const TAB_LABELS: Record<AnalyticsTabId, string> = { devin: 'Devin', claude: 'Claude', openhands: 'OpenHands' };
const TABS: { id: AnalyticsTabId; label: string }[] = PROVIDER_ANALYTICS_TABS.map((id) => ({
  id,
  label: TAB_LABELS[id],
}));

export const ANALYTICS_TAB_IDS = TABS.map((tab) => tab.id);

// The provider that owns a tab contributes its summary row and Refresh action.
function analyticsUi(tab: AnalyticsTabId) {
  const owner = PROVIDERS.find((p) => p.analyticsTab === tab);
  const ui = owner ? PROVIDER_UI[owner.id] : undefined;
  return ui?.AnalyticsPanel ? ui : undefined;
}

interface AnalyticsTabsProps {
  rect: Rect;
  active: AnalyticsTabId;
  onSelect: (id: AnalyticsTabId) => void;
}

// Shell-rendered tab strip at the top of the Analytics column (plan D5): Devin
// (hosted tenant analytics page below) / Claude / OpenHands (shell panels).
// Same look and arrow-key behaviour as SettingsTabs. The Refresh button and
// the summary row come from the active tab's provider (PROVIDER_UI slots).
export function AnalyticsTabs({ rect, active, onSelect }: AnalyticsTabsProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = ANALYTICS_TAB_IDS.indexOf(active);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      ANALYTICS_TAB_IDS[(index + delta + ANALYTICS_TAB_IDS.length) % ANALYTICS_TAB_IDS.length];
    if (next && next !== active) onSelect(next);
  };

  const ui = analyticsUi(active);
  const Summary = ui?.AnalyticsSummary;
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
          title={ui?.analyticsRefreshTitle}
          disabled={false}
          className="mb-1 flex h-6 w-6 items-center justify-center rounded text-[#7f8ca0] hover:bg-[#1c2735] hover:text-[#e8edf5] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#7f8ca0]"
          onClick={() => ui?.analyticsRefresh()}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      </div>
      {Summary && <Summary />}
    </div>
  );
}
