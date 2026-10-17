import { useCallback, useRef } from 'react';

// ArrowUp/ArrowDown focus cycling over registered row buttons, plus a
// Ctrl+C hook for the focused row's session id.
export function useRowKeyboardNav(onCopy: (sessionId: string) => void) {
  const rowRefs = useRef<HTMLButtonElement[]>([]);
  rowRefs.current = [];

  const registerRow = useCallback((el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.push(el);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
        const active = document.activeElement;
        const id = active?.getAttribute('data-session-id');
        if (id) {
          onCopy(id);
          event.preventDefault();
        }
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const rows = rowRefs.current.filter((el) => el.isConnected);
      if (rows.length === 0) return;
      event.preventDefault();
      const active = document.activeElement;
      const index = rows.findIndex((el) => el === active);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        index === -1
          ? (delta + rows.length) % rows.length
          : (index + delta + rows.length) % rows.length;
      rows[next]?.focus();
    },
    [onCopy],
  );

  return { registerRow, onKeyDown };
}
