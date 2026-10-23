import type { ComponentType, CSSProperties } from 'react';
import { Sparkles } from 'lucide-react';
import type { Rect } from '../core/layout';
import { PROVIDERS, providerBySource, type ProviderId } from '../core/providers';
import type { SettingsTabId } from '../core/settingsDraft';
import type { Surface } from '../shared/ipc';
import { PROVIDER_UI_KEYS } from './providerKeys';
import { useShellState } from './store';
import { requestSurface } from './surface';
import { ClaudeView } from './claude/ClaudeView';
import { ClaudeAnalyticsTab } from './components/analytics/ClaudeAnalyticsTab';
import { ClaudeAnalyticsSummary, DevinAnalyticsSummary } from './components/analytics/UsageSummaries';
import { ClaudeSidebar } from './components/ClaudeSidebar';
import { ClaudeGlyph } from './components/icons/ClaudeGlyph';
import { OpenHandsGlyph } from './components/icons/OpenHandsGlyph';
import { DevinCloudSidebar } from './components/DevinCloudSidebar';
import { ClaudeTab } from './components/settings/ClaudeTab';
import { DevinTab } from './components/settings/DevinTab';
import { OpenHandsTab } from './components/settings/OpenHandsTab';
import { LocalPanel } from './local/LocalPanel';
import { LocalSidebar } from './local/LocalSidebar';
import { OpenHandsAnalyticsPanel, OpenHandsUsageSummary } from './openhands/OpenHandsAnalyticsPanel';
import { OpenHandsRailButton } from './openhands/OpenHandsRailButton';
import { OpenHandsSidebar } from './openhands/OpenHandsSidebar';

export interface RailButtonProps {
  surface: Surface;
  buttonClass: string;
}
type StyleProps = { style: CSSProperties };
type SidebarProps = { rect: Rect };

interface ProviderUiBase {
  RailButton: ComponentType<RailButtonProps>;
  SettingsTab?: ComponentType;
  Sidebar?: ComponentType<SidebarProps>;
  Panel?: ComponentType<StyleProps>;
}
// An Analytics tab brings its panel, the one-line summary under the tab strip
// and what the strip's Refresh button does there (AnalyticsTabs has no
// provider branches).
interface AnalyticsSlots {
  AnalyticsPanel: ComponentType<StyleProps>;
  AnalyticsSummary: ComponentType;
  analyticsRefresh: () => void;
  analyticsRefreshTitle: string;
}
type NoAnalytics = { [K in keyof AnalyticsSlots]?: undefined };
type ProviderUiFor<K extends { analyticsPanel: boolean; sourceGlyph: boolean }> = ProviderUiBase &
  (K['analyticsPanel'] extends true ? AnalyticsSlots : NoAnalytics) &
  (K['sourceGlyph'] extends true ? { SourceGlyph: ComponentType } : { SourceGlyph?: undefined });

export type ProviderUiMap = { [P in ProviderId]: ProviderUiFor<(typeof PROVIDER_UI_KEYS)[P]> };

function CloudButton({ surface, buttonClass }: RailButtonProps) {
  return (
    <button
      id="cloudButton"
      type="button"
      aria-label="Cloud"
      aria-pressed={surface === 'cloud'}
      title="Cloud"
      className={buttonClass}
      onClick={() => void requestSurface('cloud')}
    >
      ☁
    </button>
  );
}

function LocalButton({ surface, buttonClass }: RailButtonProps) {
  return (
    <button
      id="localButton"
      type="button"
      aria-label="Local"
      aria-pressed={surface === 'local'}
      title="Local"
      className={buttonClass}
      onClick={() => void requestSurface('local')}
    >
      ⌘
    </button>
  );
}

// Amber dot while any Claude session (hooks or chat) waits for a
// permission decision — same style as #pollerWarning.
function ClaudeButton({ surface, buttonClass }: RailButtonProps) {
  const state = useShellState();
  const waiting = state?.claude.sessions.some((s) => s.activity === 'waiting') ?? false;
  return (
    <button
      id="claudeButton"
      type="button"
      aria-label="Claude"
      aria-pressed={surface === 'claude'}
      title="Claude"
      className={`${buttonClass} relative flex items-center justify-center`}
      onClick={() => void requestSurface('claude')}
    >
      <Sparkles size={18} strokeWidth={1.8} />
      {waiting && (
        <span
          id="claudeWaitingBadge"
          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#e0a03c]"
          title="A Claude session is waiting for permission"
        />
      )}
    </button>
  );
}

// Devin's analytics tab is the hosted tenant page; the shell renders nothing.
function DevinAnalyticsPlaceholder(_props: StyleProps) {
  return null;
}

export const PROVIDER_UI: ProviderUiMap = {
  'devin-cloud': {
    RailButton: CloudButton,
    SettingsTab: DevinTab,
    AnalyticsPanel: DevinAnalyticsPlaceholder,
    AnalyticsSummary: DevinAnalyticsSummary,
    // Reloads the hosted page and refreshes the usage metric.
    analyticsRefresh: () => {
      void window.agentworkspace.analyticsRefresh();
      window.agentworkspace.devinUsageRefresh();
    },
    analyticsRefreshTitle: 'Reload analytics',
    Sidebar: DevinCloudSidebar,
  },
  'devin-local': {
    RailButton: LocalButton,
    Sidebar: LocalSidebar,
    Panel: LocalPanel,
  },
  claude: {
    RailButton: ClaudeButton,
    SettingsTab: ClaudeTab,
    AnalyticsPanel: ClaudeAnalyticsTab,
    AnalyticsSummary: ClaudeAnalyticsSummary,
    analyticsRefresh: () => void window.agentworkspace.claudeUsageRefresh(),
    analyticsRefreshTitle: 'Refresh Claude usage',
    Sidebar: ClaudeSidebar,
    Panel: ClaudeView,
    SourceGlyph: ClaudeGlyph,
  },
  // The main column is the pooled hosted view (like Cloud) — no shell Panel.
  openhands: {
    RailButton: OpenHandsRailButton,
    SettingsTab: OpenHandsTab,
    AnalyticsPanel: OpenHandsAnalyticsPanel,
    AnalyticsSummary: OpenHandsUsageSummary,
    analyticsRefresh: () => void window.agentworkspace.openhandsUsageRefresh(),
    analyticsRefreshTitle: 'Refresh OpenHands usage',
    Sidebar: OpenHandsSidebar,
    SourceGlyph: OpenHandsGlyph,
  },
};

/** Source glyph for a notification/PR row; renders nothing for sources without one. */
export function SourceGlyph({ source }: { source: string | null | undefined }) {
  const provider = source ? providerBySource(source) : undefined;
  const Glyph = provider ? PROVIDER_UI[provider.id].SourceGlyph : undefined;
  return Glyph ? <Glyph /> : null;
}

/** Settings tab body contributed by the provider that owns `tab` (none for non-provider tabs). */
export function ProviderSettingsTab({ tab }: { tab: SettingsTabId }) {
  const owner = PROVIDERS.find((p) => p.settingsTab === tab && PROVIDER_UI[p.id].SettingsTab);
  const Tab = owner ? PROVIDER_UI[owner.id].SettingsTab : undefined;
  return Tab ? <Tab /> : null;
}
