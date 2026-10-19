import { BarChart3, Bell, Sparkles } from 'lucide-react';
import { RAIL_WIDTH, TITLE_BAR_HEIGHT } from '../../core/layout';
import { useShellState } from '../store';
import { requestSurface } from '../surface';
import type { Surface } from '../../shared/ipc';
import { PrQuickOpen } from './PrQuickOpen';

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
      onClick={() => window.devinworkspaces.notificationsPanel(!open)}
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

// Amber dot while any Claude session (hooks or chat) waits for a
// permission decision — same style as #pollerWarning.
function ClaudeButton({ surface, buttonClass }: { surface: Surface; buttonClass: string }) {
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

export function Rail({
  surface,
  paneOpen,
  paneCollapsed,
  terminalOpen,
}: RailProps) {
  const terminalOffSurface =
    surface !== 'cloud' && surface !== 'local' && surface !== 'claude';
  return (
    <aside
      id="rail"
      className="shell-chrome absolute top-0 bottom-0 left-0 flex flex-col items-center gap-2.5 bg-[#101722]"
      style={{ width: RAIL_WIDTH, paddingTop: TITLE_BAR_HEIGHT + 8 }}
    >
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
      <ClaudeButton surface={surface} buttonClass={buttonClass} />
      <button
        id="analyticsButton"
        type="button"
        aria-label="Analytics"
        aria-pressed={surface === 'analytics'}
        title="Analytics"
        className={`${buttonClass} flex items-center justify-center`}
        onClick={() => void requestSurface('analytics')}
      >
        <BarChart3 size={18} strokeWidth={1.8} />
      </button>
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
            ? 'Terminal dock shows on Cloud — enable for all surfaces in Settings'
            : 'Toggle terminal (Ctrl+`)'
        }
        className={`${buttonClass} text-sm${terminalOffSurface ? ' opacity-50' : ''}`}
        onClick={() => window.devinworkspaces.terminalToggle()}
      >
        &gt;_
      </button>
      <button
        id="paneToggle"
        type="button"
        aria-label="Toggle GitHub pane"
        aria-pressed={paneOpen}
        title={paneCollapsed ? 'GitHub pane hidden — widen window' : 'Toggle GitHub pane'}
        className={`${buttonClass} relative text-sm`}
        onClick={() => window.devinworkspaces.togglePane()}
      >
        GH
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
