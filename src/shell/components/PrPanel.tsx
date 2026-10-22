import { useCallback, useEffect, useState } from 'react';
import { CheckCheck, Trash2 } from 'lucide-react';
import { RAIL_WIDTH, TITLE_BAR_HEIGHT } from '../../core/layout';
import type { SessionPr } from '../../shared/ipc';
import { useShellState } from '../store';
import { SourceGlyph } from '../providers';

// Same modal popover as NotificationPanel — while open, main raises the shell
// view so the panel sits over the hosted views (backdrop click closes).
// Rendered only when state.notifications.prsPanelOpen.
export function PrPanel() {
  const state = useShellState();
  const [entries, setEntries] = useState<SessionPr[]>([]);
  const open = state?.notifications.prsPanelOpen ?? false;

  const refresh = useCallback(async () => {
    setEntries(await window.agentworkspace.listPrs());
  }, []);

  // Re-fetch on every state push while open — mark/read/clear from anywhere
  // stays in sync.
  useEffect(() => {
    if (open) void refresh();
  }, [open, state, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.agentworkspace.prsPanel(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const close = () => window.agentworkspace.prsPanel(false);

  return (
    <div
      id="prsBackdrop"
      className="absolute inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        id="prsPanel"
        className="absolute flex flex-col rounded-lg border border-[#39475a] bg-[#101722] shadow-xl"
        style={{
          left: RAIL_WIDTH + 8,
          top: TITLE_BAR_HEIGHT + 8,
          width: 380,
          maxHeight: Math.max(200, window.innerHeight - 80),
        }}
      >
        <header className="flex items-center gap-2 border-b border-[#39475a] px-3 py-2">
          <span className="text-[13px] font-semibold text-[#e8edf3]">Pull requests</span>
          <span className="flex-1" />
          <button
            id="prsMarkAllRead"
            type="button"
            aria-label="Mark all read"
            title="Mark all read"
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[#7d8a99] hover:bg-[#2a394d] disabled:opacity-40"
            onClick={() => window.agentworkspace.prsMarkAllRead()}
          >
            <CheckCheck size={13} /> Mark all read
          </button>
          <button
            id="prsClearAll"
            type="button"
            aria-label="Clear all"
            title="Clear all"
            disabled={entries.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[#7d8a99] hover:bg-[#2a394d] disabled:opacity-40"
            onClick={() => window.agentworkspace.prsClear()}
          >
            <Trash2 size={13} /> Clear all
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-[#7d8a99]">
              No open pull requests
            </p>
          )}
          {entries.map((pr) => (
            <div
              key={pr.url}
              data-pr-url={pr.url}
              data-unread={pr.readAt === null || undefined}
              data-source={pr.source}
              className="relative flex items-start gap-2 border-b border-[#1a2330] px-3 py-2 last:border-0"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => window.agentworkspace.prsOpen(pr.sessionId, pr.url)}
              >
                <div
                  className={`text-[12px] leading-tight ${
                    pr.readAt === null
                      ? 'font-semibold text-[#e8edf3]'
                      : 'text-[#aeb9c8]'
                  }`}
                >
                  <SourceGlyph source={pr.source} />
                  {pr.title ?? pr.ref}
                </div>
                {pr.title !== null && (
                  <div className="text-[11px] text-[#7d8a99] leading-snug">{pr.ref}</div>
                )}
                <div className="mt-0.5 text-right text-[10px] text-[#5d6b7d]">
                  {pr.sessionTitle}
                </div>
              </button>
              <div className="flex flex-col items-center gap-1 pt-0.5">
                <input
                  type="checkbox"
                  aria-label="Mark as read"
                  title="Mark as read"
                  checked={pr.readAt !== null}
                  disabled={pr.readAt !== null}
                  onChange={() => window.agentworkspace.prsMarkRead(pr.url)}
                />
                <button
                  type="button"
                  aria-label="Delete"
                  title="Delete"
                  className="text-[#7d8a99] hover:text-[#e8edf3]"
                  onClick={() => window.agentworkspace.prsRemove(pr.url)}
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
