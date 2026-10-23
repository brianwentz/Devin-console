import { useEffect, useRef, useState, type DragEvent } from 'react';
import { isUrlDrag, pickDroppedUrl, safeDropTypes } from '../../core/dropUrl';
import { USER_URL_MAX } from '../../core/userUrl';
import { USER_URL_REASON_TEXT, type UserUrlReason } from '../userUrlText';

export type TabDropHint = { state: 'drop' } | { state: 'error'; text: string } | null;

const ERROR_HINT_MS = 3000;

// A drop carries no "typed" text, so "Type a web address" would read wrong.
const dropReasonText = (reason: UserUrlReason): string =>
  reason === 'empty' ? USER_URL_REASON_TEXT['not-a-url'] : USER_URL_REASON_TEXT[reason];

// HTML5 drop target for links on the tab row (dnd-kit's tab reorder uses
// pointer events, not HTML5 drags, so the two never meet). Every URL goes
// through main's `openUserUrl`, which re-validates it.
export function useTabDrop() {
  const [hint, setHint] = useState<TabDropHint>(null);
  // dragenter/dragleave fire per child element; the depth tells when the
  // pointer actually left the row.
  const depth = useRef(0);
  const errorTimer = useRef<number | null>(null);

  const clearErrorTimer = () => {
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    errorTimer.current = null;
  };
  useEffect(() => clearErrorTimer, []);

  const showError = (text: string) => {
    clearErrorTimer();
    setHint({ state: 'error', text });
    errorTimer.current = window.setTimeout(() => {
      errorTimer.current = null;
      setHint(null);
    }, ERROR_HINT_MS);
  };

  const showDropHint = () => {
    clearErrorTimer();
    setHint((current) => (current?.state === 'drop' ? current : { state: 'drop' }));
  };

  const hideDropHint = () => setHint((current) => (current?.state === 'drop' ? null : current));

  const onDragEnter = (event: DragEvent) => {
    const types = Array.from(event.dataTransfer.types);
    // Type names only: values are unreadable before the drop anyway.
    if (depth.current === 0) window.agentworkspace.reportDropTypes(safeDropTypes(types));
    depth.current += 1;
    if (!isUrlDrag(types)) return;
    event.preventDefault();
    showDropHint();
  };

  const onDragOver = (event: DragEvent) => {
    if (!isUrlDrag(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    showDropHint();
  };

  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) hideDropHint();
  };

  const onDrop = (event: DragEvent) => {
    depth.current = 0;
    const types = Array.from(event.dataTransfer.types);
    if (!isUrlDrag(types)) {
      hideDropHint();
      return;
    }
    event.preventDefault();
    hideDropHint();
    // DataTransfer is only readable synchronously inside the drop event.
    const raw = pickDroppedUrl((type) => event.dataTransfer.getData(type), types);
    if (raw === null) {
      showError(dropReasonText('empty'));
      return;
    }
    if (raw.length > USER_URL_MAX) {
      showError(dropReasonText('too-long'));
      return;
    }
    void window.agentworkspace
      .openUserUrl({ url: raw, source: 'drop', target: 'new' })
      .then((reply) => {
        if (!reply.ok) showError(dropReasonText(reply.reason));
      })
      .catch(() => showError(dropReasonText('unavailable')));
  };

  return { hint, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
