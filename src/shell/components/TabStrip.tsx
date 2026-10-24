import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ShellState } from '../../shared/ipc';

type Tab = ShellState['tabs']['tabs'][number];

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
}

// Tabs only ever move along the strip.
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

export function TabStrip({ tabs, activeId }: TabStripProps) {
  const stripRef = useRef<HTMLElement>(null);
  const sensors = useSensors(
    // Distance constraint keeps plain clicks (activate / close) working.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Overflow: keep the active tab scrolled into view.
  useEffect(() => {
    if (!activeId || !stripRef.current) return;
    const selector = `[data-tab-id="${CSS_escape(activeId)}"]`;
    const element = stripRef.current.querySelector<HTMLElement>(selector);
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  // The scrollbar is hidden (it would eat a third of the 36px strip); a vertical wheel over
  // the strip scrolls it horizontally like browser tab strips do.
  const onWheel = (event: WheelEvent) => {
    const strip = stripRef.current;
    if (!strip || event.deltaY === 0 || event.deltaX !== 0) return;
    strip.scrollLeft += event.deltaY;
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = tabs.findIndex((tab) => tab.id === over.id);
    if (toIndex < 0) return;
    window.agentworkspace.reorderTab(String(active.id), toIndex);
  };

  return (
    <section
      id="tabStrip"
      ref={stripRef}
      role="tablist"
      aria-label="Linked Context tabs"
      className="shell-chrome app-no-drag flex flex-1 min-w-0 overflow-x-auto overflow-y-hidden items-stretch"
      style={{ scrollbarWidth: 'none' }}
      onWheel={onWheel}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[horizontalOnly]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableTab key={tab.id} tab={tab} active={tab.id === activeId} />
          ))}
        </SortableContext>
      </DndContext>
      {/* Empty strip space moves the window; tiny grow so tabs still fill the row up to their max width. */}
      {tabs.length > 0 && (
        <div
          data-testid="tabStripFiller"
          className="app-drag h-full shrink-0 min-w-2"
          style={{ flexGrow: 0.0001 }}
        />
      )}
      {tabs.length === 0 && (
        <div
          data-testid="tabStripEmpty"
          className="flex-1 flex items-center justify-center text-[#7d8a99] text-[12px]"
        >
          No tabs yet — drop a link here or press +
        </div>
      )}
    </section>
  );
}

function SortableTab({ tab, active }: { tab: Tab; active: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab.id });
  // Pointer dragging works on the whole tab; keyboard reordering lives on the handle so
  // Enter/Space on the tab itself still activate it.
  const { onKeyDown: handleKeyDown, ...pointerListeners } = listeners ?? {};

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('.closeMark')) {
      window.agentworkspace.closeTab(tab.id);
    } else if (target instanceof HTMLElement && target.closest('.dragHandle')) {
      // keyboard handle: no-op on click
    } else {
      window.agentworkspace.activateTab(tab.id);
    }
  };

  const onAuxClick = (event: MouseEvent) => {
    if (event.button === 1) {
      event.preventDefault();
      window.agentworkspace.closeTab(tab.id);
    }
  };

  // Middle button on an overflowing (scrollable) strip would start Chromium's autoscroll
  // and swallow the auxclick; cancelling the mousedown keeps middle-click = close.
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      window.agentworkspace.activateTab(tab.id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      window.agentworkspace.closeTab(tab.id);
    }
  };

  const dragStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-label={tab.title || tab.url}
      className={`tab${active ? ' active' : ''}${isDragging ? ' dragging' : ''}${tab.discarded ? ' discarded' : ''}`}
      title={tab.discarded ? `${tab.title || tab.url} (discarded — reloads on activation)` : undefined}
      data-tab-id={tab.id}
      style={dragStyle}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        window.agentworkspace.openTabMenu(tab.id, event.clientX, event.clientY);
      }}
      {...pointerListeners}
    >
      {/* Not natively draggable: dropped on the row it would open the icon as a tab. */}
      {tab.favicon && <img className="favicon" src={tab.favicon} alt="" draggable={false} />}
      <span className="tabTitle">{tab.title || safeHostname(tab.url)}</span>
      {tab.loading && <span className="spinner" aria-label="Loading" />}
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="dragHandle"
        aria-label={`Reorder tab ${tab.title || tab.url}`}
        title="Reorder (Space, then arrow keys)"
        {...attributes}
        onKeyDown={handleKeyDown as ((event: KeyboardEvent) => void) | undefined}
        onClick={(event) => event.stopPropagation()}
      >
        ⋮
      </button>
      <button
        type="button"
        className="closeMark"
        aria-label={`Close ${tab.title || tab.url}`}
        tabIndex={-1}
      >
        ×
      </button>
    </div>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function CSS_escape(value: string): string {
  return globalThis.CSS.escape(value);
}
