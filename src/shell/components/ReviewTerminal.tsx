import { useEffect, useState } from 'react';
import type { Rect } from '../../core/layout';
import { reviewDotLabel } from '../../core/tabReview';
import type { ShellState } from '../../shared/ipc';
import { TerminalView } from '../chat/TerminalView';
import { buttonClass } from '../chat/Cards';

type ReviewTerminalState = NonNullable<ShellState['reviewTerminal']>;

interface ReviewTerminalProps {
  // null while the strip is hidden — the component stays mounted so the xterm
  // scrollback of each review pty survives tab switches (TerminalView has no replay).
  rect: Rect | null;
  review: ReviewTerminalState | null;
  terminals: ShellState['terminals'];
}

export const HOOKS_WARNING = "Result detection unavailable: hooks can't reach the app";

export function ReviewTerminal({ rect, review, terminals }: ReviewTerminalProps) {
  const [mounted, setMounted] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const tabId = review?.tabId ?? null;
  const status = review?.status ?? null;
  const ptyId = review?.ptyId ?? null;

  useEffect(() => {
    if (ptyId) setMounted((ids) => (ids.includes(ptyId) ? ids : [...ids, ptyId]));
  }, [ptyId]);

  // Drop ids of ptys that no longer exist.
  useEffect(() => {
    setMounted((ids) => {
      const kept = ids.filter((id) => terminals.some((entry) => entry.id === id));
      return kept.length === ids.length ? ids : kept;
    });
  }, [terminals]);

  // A different tab, or a verdict landing, voids a pending close confirmation.
  useEffect(() => setConfirming(false), [tabId, status]);

  const live = mounted.filter((id) => terminals.some((entry) => entry.id === id));
  const visible = Boolean(rect && review);

  const close = () => {
    if (!review) return;
    if (review.status === 'reviewing' && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void window.agentworkspace.reviewClose(review.tabId);
  };

  return (
    <section
      id="reviewTerminal"
      aria-label="Review terminal"
      className="shell-chrome absolute flex flex-col bg-[#0d141d] border-t border-[#39475a]"
      data-tab-id={tabId ?? undefined}
      style={{
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        display: visible ? 'flex' : 'none',
      }}
    >
      <div className="flex h-[30px] flex-none items-center gap-2 border-b border-[#39475a] bg-[#101722] px-2 text-[11px] text-[#e8edf3]">
        {review && (
          <span
            className="reviewDot"
            data-review={review.status}
            title={reviewDotLabel(review.status)}
            aria-label={reviewDotLabel(review.status)}
          />
        )}
        <span id="reviewTerminalLabel" className="truncate font-medium">
          {review ? `Review ${review.prLabel}` : ''}
        </span>
        <span
          id="reviewTerminalStatus"
          data-review={review?.status ?? ''}
          className="flex-none text-[#aeb9c8]"
        >
          {review ? reviewDotLabel(review.status) : ''}
        </span>
        {review && !review.hooksReachable && (
          <span id="reviewTerminalHooksWarning" className="truncate text-[#e0a03c]">
            {HOOKS_WARNING}
          </span>
        )}
        <span className="flex-1" />
        {confirming && (
          <span id="reviewTerminalCloseConfirm" className="flex flex-none items-center gap-1.5">
            <span className="text-[#e0a03c]">Stop the running review?</span>
            <button
              type="button"
              id="reviewTerminalCloseConfirmYes"
              className={buttonClass}
              onClick={close}
            >
              Stop review
            </button>
            <button
              type="button"
              id="reviewTerminalCloseConfirmNo"
              className={buttonClass}
              onClick={() => setConfirming(false)}
            >
              Keep running
            </button>
          </span>
        )}
        <button
          id="reviewTerminalClose"
          type="button"
          aria-label="Close review terminal"
          title="Close review terminal"
          className="px-2 text-[#aeb9c8] hover:text-white"
          tabIndex={-1}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {live.map((id) => (
          <div
            key={id}
            className="absolute inset-0 flex flex-col"
            style={{ display: id === review?.ptyId ? 'flex' : 'none' }}
          >
            <TerminalView id={id} active={visible && id === review?.ptyId} />
          </div>
        ))}
      </div>
    </section>
  );
}
