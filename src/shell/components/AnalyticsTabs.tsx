import type { KeyboardEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Rect } from '../../core/layout';
import type { Settings } from '../../shared/ipc';

export type AnalyticsTabId = Settings['analytics']['tab'];

const TABS: { id: AnalyticsTabId; label: string }[] = [
  { id: 'devin', label: 'Devin' },
  { id: 'claude', label: 'Claude' },
];

export const ANALYTICS_TAB_IDS = TABS.map((tab) => tab.id);

type RefreshApi = {
  analyticsRefresh: () => Promise<LocalResult<null> | null>;
  claudeUsageRefresh: () => Promise<LocalResult<null> | null>;
};

interface AnalyticsTabsProps {
  rect: Rect;
  active: AnalyticsTabId;
  onSelect: (id: AnalyticsTabId) => void;
}

// Shell-rendered tab strip at the top of the Analytics column (plan D5): Devin
// (hosted tenant analytics page below) / Claude (ClaudeAnalyticsPanel). Same
// look and arrow-key behaviour as SettingsTabs. The Refresh button on the
// right re-fetches the Claude usage data; the Devin page has no shell-side
// refresh IPC (the Rail entry reloads it on surface entry), so the button is
// disabled on that tab.
import type { LocalResult } from '../../shared/ipc';

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

  const onRefresh = () => {
    const api = window.devinworkspaces as unknown as RefreshApi;
    if (active === 'claude') void api.claudeUsageRefresh();
    else void api.analyticsRefresh();
  };

  return (
    <div
      id="analyticsTabs"
      className="shell-chrome absolute flex items-end justify-between border-b border-[#39475a] bg-[#111827] px-6"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
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
  );
}
