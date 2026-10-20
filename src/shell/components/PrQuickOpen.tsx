import { useShellState } from '../store';

interface PrQuickOpenProps {
  buttonClass: string;
}

// Shown when any of the token user's sessions (from the last API poll) have
// open, not-dismissed pull requests. Clicking toggles the PR panel popover;
// the badge counts unread PRs.
export function PrQuickOpen({ buttonClass }: PrQuickOpenProps) {
  const state = useShellState();
  const count = state?.notifications.openPrCount ?? 0;
  const unread = state?.notifications.unreadPrCount ?? 0;
  const open = state?.notifications.prsPanelOpen ?? false;
  const label = unread > 0 ? `Pull requests (${unread} unread)` : 'Pull requests';
  return (
    <>
      {count > 0 && (
        <button
          id="prQuickOpen"
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={open}
          className={`${buttonClass} relative text-sm`}
          onClick={() => window.agentworkspace.prsPanel(!open)}
        >
          PR
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#54749c] text-[10px] leading-4">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      )}
    </>
  );
}
