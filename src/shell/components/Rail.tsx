import { BarChart3, Bell } from 'lucide-react';
import { dockSurface, RAIL_WIDTH, TITLE_BAR_HEIGHT } from '../../core/layout';
import { PROVIDERS } from '../../core/providers';
import { PROVIDER_UI } from '../providers';
import { useShellState } from '../store';
import { requestSurface } from '../surface';
import type { Surface } from '../../shared/ipc';
import { PrQuickOpen } from './PrQuickOpen';
import { ChromiumIcon } from './icons/ChromiumIcon';

interface RailProps {
  surface: Surface;
  paneOpen: boolean;
  paneCollapsed: boolean;
  terminalOpen: boolean;
}

const buttonClass =
  'w-10 h-10 text-xl rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] aria-pressed:bg-[#31455f] aria-pressed:border-[#54749c]';

// P6: bell toggles the notification panel (a shell-DOM modal; main raises the
// shell view while it's open). Unread badge mirrors the taskbar overlay count.
function NotificationsButton({ buttonClass }: { buttonClass: string }) {
  const state = useShellState();
  const unread = state?.notifications.unreadCount ?? 0;
  const open = state?.notifications.panelOpen ?? false;
  const authError = state?.notifications.authError ?? false;
  const noUserIdentity = state?.notifications.noUserIdentity ?? false;
  return (
    <button
      id="notificationsButton"
      type="button"
      aria-label="Notifications"
      aria-pressed={open}
      title="Notifications"
      className={`${buttonClass} relative flex items-center justify-center`}
      onClick={() => window.agentworkspace.notificationsPanel(!open)}
    >
      <Bell size={18} strokeWidth={1.8} />
      {unread > 0 && (
        <span
          id="notificationsBadge"
          className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#d93a2f] text-[10px] leading-4 text-center"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
      {(authError || noUserIdentity) && (
        <span
          id="pollerWarning"
          className="absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#e0a03c]"
          title={
            authError
              ? 'Devin API token rejected — open Settings'
              : 'Could not determine your user — open Settings'
          }
        />
      )}
    </button>
  );
}

// Usage alerts: a dot while any tracked metric is ≥50% of its limit — amber
// for warn, red for critical; the tooltip lists the hot metrics.
function AnalyticsButton({ surface, buttonClass }: { surface: Surface; buttonClass: string }) {
  const state = useShellState();
  const level = state?.usage.level ?? 'none';
  const hot = (state?.usage.items ?? []).filter((item) => item.percent >= 50);
  return (
    <button
      id="analyticsButton"
      type="button"
      aria-label="Analytics"
      aria-pressed={surface === 'analytics'}
      title="Analytics"
      className={`${buttonClass} relative flex items-center justify-center`}
      onClick={() => void requestSurface('analytics')}
    >
      <BarChart3 size={18} strokeWidth={1.8} />
      {level !== 'none' && (
        <span
          id="usageBadge"
          data-usage-level={level}
          className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ${
            level === 'critical' ? 'bg-[#d93a2f]' : 'bg-[#e0a03c]'
          }`}
          title={hot.map((item) => `${item.label} ${Math.round(item.percent)}%`).join(' · ')}
        />
      )}
    </button>
  );
}

export function Rail({
  surface,
  paneOpen,
  paneCollapsed,
  terminalOpen,
}: RailProps) {
  // Settings/Analytics: the dock is hidden and the toggle is inert (the
  // persisted preference survives the visit — see core/layout dockSurface).
  const terminalOffSurface = !dockSurface(surface);
  const dockLabels = PROVIDERS.filter((p) => p.dock).map((p) => p.label);
  const dockList =
    dockLabels.length > 1
      ? `${dockLabels.slice(0, -1).join(', ')} and ${dockLabels[dockLabels.length - 1]}`
      : dockLabels.join('');
  return (
    <aside
      id="rail"
      className="shell-chrome absolute top-0 bottom-0 left-0 flex flex-col items-center gap-2.5 bg-[#101722]"
      style={{ width: RAIL_WIDTH, paddingTop: TITLE_BAR_HEIGHT + 8 }}
    >
      {PROVIDERS.map((p) => {
        const RailButton = PROVIDER_UI[p.id].RailButton;
        return <RailButton key={p.id} surface={surface} buttonClass={buttonClass} />;
      })}
      <AnalyticsButton surface={surface} buttonClass={buttonClass} />
      <PrQuickOpen buttonClass={buttonClass} />
      <NotificationsButton buttonClass={buttonClass} />
      <span className="flex-1" />
      <button
        id="terminalToggle"
        type="button"
        aria-label="Toggle terminal"
        aria-pressed={terminalOpen}
        title={
          terminalOffSurface
            ? `Terminal dock shows on ${dockList}`
            : 'Toggle terminal (Ctrl+`)'
        }
        disabled={terminalOffSurface}
        className={`${buttonClass} text-sm`}
        onClick={() => {
          if (!terminalOffSurface) window.agentworkspace.terminalToggle();
        }}
      >
        &gt;_
      </button>
      <button
        id="paneToggle"
        type="button"
        aria-label="Toggle Linked Context"
        aria-pressed={paneOpen}
        title={paneCollapsed ? 'Linked Context hidden — widen window' : 'Linked Context'}
        className={`${buttonClass} relative flex items-center justify-center`}
        onClick={() => window.agentworkspace.togglePane()}
      >
        <ChromiumIcon size={18} strokeWidth={1.8} />
        {paneCollapsed && paneOpen && (
          <span
            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#e0a03c]"
            title="pane hidden — widen window"
          />
        )}
      </button>
      <button
        id="settingsButton"
        type="button"
        aria-label="Settings"
        aria-pressed={surface === 'settings'}
        title="Settings"
        className={`${buttonClass} mb-3`}
        onClick={() => void requestSurface('settings')}
      >
        ⚙
      </button>
    </aside>
  );
}
