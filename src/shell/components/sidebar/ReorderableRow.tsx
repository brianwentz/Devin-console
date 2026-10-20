import { useRef, useState, type ReactNode } from 'react';
import { reorderSection } from '../../../core/sessionTree';
import { dragState, SESSION_MIME } from './dnd';

// ux3 S1: wraps a root session row so a same-section drag can reorder it.
// dragover accepts only SESSION_MIME drags started inside this section
// (cross-section stays the folder header's move target on Cloud / refused
// on workspace columns). The indicator is a 2 px border above/below the row.
export function ReorderableRow({
  section,
  sessionId,
  rootIds,
  onReorder,
  children,
}: {
  section: string;
  sessionId: string;
  rootIds: string[];
  onReorder: (section: string, ids: string[]) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dropBefore, setDropBefore] = useState(false);
  const [dropAfter, setDropAfter] = useState(false);

  const place = (clientY: number): 'before' | 'after' => {
    const rect = ref.current?.getBoundingClientRect();
    return rect && clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  return (
    <div
      ref={ref}
      data-reorder-row={sessionId}
      data-drop-before={dropBefore}
      data-drop-after={dropAfter}
      className="data-[drop-before=true]:border-t-2 data-[drop-before=true]:border-t-[#54749c] data-[drop-after=true]:border-b-2 data-[drop-after=true]:border-b-[#54749c]"
      onDragStart={() => {
        dragState.current = { id: sessionId, section };
      }}
      onDragEnd={() => {
        dragState.current = null;
        setDropBefore(false);
        setDropAfter(false);
      }}
      onDragOver={(e) => {
        const drag = dragState.current;
        if (
          !drag ||
          drag.section !== section ||
          drag.id === sessionId ||
          !e.dataTransfer.types.includes(SESSION_MIME)
        ) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const before = place(e.clientY) === 'before';
        setDropBefore(before);
        setDropAfter(!before);
      }}
      onDragLeave={() => {
        setDropBefore(false);
        setDropAfter(false);
      }}
      onDrop={(e) => {
        const drag = dragState.current;
        setDropBefore(false);
        setDropAfter(false);
        if (!drag || drag.section !== section || drag.id === sessionId) return;
        e.preventDefault();
        const ids = reorderSection(rootIds, drag.id, sessionId, place(e.clientY));
        if (ids !== rootIds) onReorder(section, ids);
      }}
    >
      {children}
    </div>
  );
}
