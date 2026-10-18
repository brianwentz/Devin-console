import { useCallback, useEffect, useState } from 'react';
import { CheckCheck, Sparkles, Trash2 } from 'lucide-react';
import { RAIL_WIDTH, TITLE_BAR_HEIGHT } from '../../core/layout';
import type { AppNotification } from '../../core/notificationModel';
import { useShellState } from '../store';
import { relativeTime } from './relativeTime';

// Source glyph for Claude Code entries (panel rows + banner). Inline
// so it sits before the title without changing the row layout.
export function ClaudeGlyph() {
  return (
    <span
      className="claude-glyph inline-flex align-[-2px] mr-1 text-[#c9a7ff]"
      title="Claude Code"
      aria-label="Claude Code"
    >
      <Sparkles size={12} />
    </span>
  );
}

// P6: modal popover — while open, main raises the shell view so the panel sits
// over the hosted views (backdrop click closes). Rendered only when
// state.notifications.panelOpen.
export function NotificationPanel() {
  const state = useShellState();
  const [entries, setEntries] = useState<AppNotification[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const open = state?.notifications.panelOpen ?? false;

  const refresh = useCallback(async () => {
    setEntries(await window.devinworkspaces.notificationsList());
    setNow(Date.now());
  }, []);

  // Re-fetch on every state push while open — mark/read/clear from anywhere
  // (the banner, IPC, another entry) stays in sync.
  useEffect(() => {
    if (open) void refresh();
  }, [open, state, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.devinworkspaces.notificationsPanel(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const close = () => window.devinworkspaces.notificationsPanel(false);

  return (
    <div
      id="notificationsBackdrop"
      className="absolute inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        id="notificationsPanel"
        className="absolute flex flex-col rounded-lg border border-[#39475a] bg-[#101722] shadow-xl"
        style={{
          left: RAIL_WIDTH + 8,
          top: TITLE_BAR_HEIGHT + 8,
          width: 380,
          maxHeight: Math.max(200, window.innerHeight - 80),
        }}
      >
        <header className="flex items-center gap-2 border-b border-[#39475a] px-3 py-2">
          <span className="text-[13px] font-semibold text-[#e8edf3]">Notifications</span>
          <span className="flex-1" />
          <button
            id="markAllRead"
            type="button"
            aria-label="Mark all read"
            title="Mark all read"
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[#7d8a99] hover:bg-[#2a394d] disabled:opacity-40"
            onClick={() => window.devinworkspaces.notificationsMarkAllRead()}
          >
            <CheckCheck size={13} /> Mark all read
          </button>
          <button
            id="clearAll"
            type="button"
            aria-label="Clear all"
            title="Clear all"
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[#7d8a99] hover:bg-[#2a394d] disabled:opacity-40"
            onClick={() => window.devinworkspaces.notificationsClear()}
          >
            <Trash2 size={13} /> Clear all
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-[#7d8a99]">
              No notifications yet
            </p>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              data-notification-id={entry.id}
              data-unread={entry.readAt === null || undefined}
              data-source={entry.source ?? 'devin'}
              className="relative flex items-start gap-2 border-b border-[#1a2330] px-3 py-2 last:border-0"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => window.devinworkspaces.notificationsOpen(entry.id)}
              >
                <div
                  className={`text-[12px] leading-tight ${
                    entry.readAt === null
                      ? 'font-semibold text-[#e8edf3]'
                      : 'text-[#aeb9c8]'
                  }`}
                >
                  {entry.source === 'claude' && <ClaudeGlyph />}
                  {entry.title}
                </div>
                <div className="text-[11px] text-[#7d8a99] leading-snug">{entry.body}</div>
                <div className="mt-0.5 text-right text-[10px] text-[#5d6b7d]">
                  {entry.sessionTitle} · {relativeTime(entry.createdAt, now)}
                </div>
              </button>
              <div className="flex flex-col items-center gap-1 pt-0.5">
                <input
                  type="checkbox"
                  aria-label="Mark as read"
                  title="Mark as read"
                  checked={entry.readAt !== null}
                  disabled={entry.readAt !== null}
                  onChange={() => window.devinworkspaces.notificationsMarkRead(entry.id)}
                />
                <button
                  type="button"
                  aria-label="Delete"
                  title="Delete"
                  className="text-[#7d8a99] hover:text-[#e8edf3]"
                  onClick={() => window.devinworkspaces.notificationsRemove(entry.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
