import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { AppNotification } from '../../core/notificationModel';
import { openNotificationEntry } from '../notificationOpen';
import { useShellState } from '../store';
import { SourceGlyph } from '../providers';

const BANNER_MS = 8_000;

// P6: transient banner in the title bar for pushed notifications. One at a
// time — later pushes queue behind it. The test build shortens the timeout.
const bannerMs = (): number => {
  const override = (window.agentworkspace as { bannerMs?: number }).bannerMs;
  return typeof override === 'number' ? override : BANNER_MS;
};

export function NotificationBanner() {
  const state = useShellState();
  const [queue, setQueue] = useState<AppNotification[]>([]);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = window.agentworkspace.onNotificationBanner((entry) =>
      setQueue((items) => [...items, entry]),
    );
    return () => unsubscribe();
  }, []);

  const current = state?.notifications.banner === false ? null : (queue[0] ?? null);

  const dismiss = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setQueue((items) => items.slice(1));
  };

  useEffect(() => {
    if (!current) return;
    timer.current = window.setTimeout(dismiss, bannerMs());
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  if (!current) return null;

  return (
    <div
      id="notificationBanner"
      className="app-no-drag flex items-center gap-2 self-center rounded-md border border-[#39475a] bg-[#1a2330] px-2 py-0.5 text-[11px] text-[#e8edf3] shadow-md max-w-[420px] cursor-pointer hover:bg-[#2a394d]"
      role="status"
      data-source={current.source ?? 'devin'}
      onClick={() => {
        openNotificationEntry(current);
        dismiss();
      }}
    >
      <SourceGlyph source={current.source} />
      {current.kind === 'review' && current.reviewVerdict && (
        <span className="reviewDot" data-review={current.reviewVerdict} />
      )}
      <span className="truncate">
        {current.title} — {current.body}
      </span>
      <button
        type="button"
        aria-label="Dismiss notification"
        className="text-[#7d8a99] hover:text-[#e8edf3]"
        onClick={(event) => {
          event.stopPropagation();
          dismiss();
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
