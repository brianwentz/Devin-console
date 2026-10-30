import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  clampPaneWidth,
  leftChrome,
  SPLITTER_WIDTH,
  type Rect,
} from '../../core/layout';
import { layoutStateFromShellState } from '../layoutState';
import { useShellState } from '../store';

interface SplitterProps {
  axis: 'x' | 'y' | 's' | 'r';
  // The live splitter rect (from computeBounds); the pointer turns into a drag
  // session that reports positions to the main-process layout.
  rect: Rect;
  enabled: boolean;
}

// The position reported to main is the requested splitter coordinate — for the
// vertical pane splitter it's clamped like the end state (main converts the
// resulting pane width into the persisted fraction); for the sessions column
// and the terminal dock it's the raw pointer position.
function currentPos(
  axis: 'x' | 'y' | 's' | 'r',
  clientPos: number,
  chrome = 0,
): number {
  if (axis === 'x') {
    const width = document.documentElement.clientWidth;
    return width - clampPaneWidth(width - clientPos - SPLITTER_WIDTH, width, chrome) - SPLITTER_WIDTH;
  }
  return clientPos;
}

export function Splitter({ axis, rect, enabled }: SplitterProps) {
  const dragging = useRef(false);
  const [draggingState, setDraggingState] = useState(false);
  const state = useShellState();
  const chrome = state
    ? leftChrome(layoutStateFromShellState(state), document.documentElement.clientWidth)
    : 0;

  useEffect(() => {
    const reset = () => {
      dragging.current = false;
      setDraggingState(false);
      document.body.classList.remove('dragging');
      document.body.classList.remove('dragging-y');
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragging.current) {
        event.preventDefault();
        reset();
        window.agentworkspace.dragCancel('escape');
      }
    };
    const offReset = window.agentworkspace.onDragReset(reset);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      offReset();
    };
  }, [axis]);

  const pointerPos = (event: PointerEvent) =>
    axis === 'y' || axis === 'r' ? event.clientY : event.clientX;

  const id =
    axis === 'x'
      ? 'splitter'
      : axis === 's'
        ? 'sessionsSplitter'
        : axis === 'r'
          ? 'reviewSplitter'
          : 'terminalSplitter';
  const label =
    axis === 'x'
      ? 'Resize Linked Context'
      : axis === 's'
        ? 'Resize sessions sidebar'
        : axis === 'r'
          ? 'Resize review terminal'
          : 'Resize terminal dock';
  const horizontal = axis === 'y' || axis === 'r';

  return (
    <div
      id={id}
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label={label}
      className="shell-chrome splitter absolute bg-transparent"
      data-axis={axis}
      data-enabled={enabled}
      data-dragging={draggingState}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        cursor: enabled ? (horizontal ? 'row-resize' : 'col-resize') : 'default',
        touchAction: 'none',
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !enabled) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        setDraggingState(true);
        document.body.classList.add(horizontal ? 'dragging-y' : 'dragging');
        window.agentworkspace.dragStart(axis, currentPos(axis, pointerPos(event), chrome));
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        window.agentworkspace.dragMove(currentPos(axis, pointerPos(event), chrome));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        setDraggingState(false);
        document.body.classList.remove('dragging');
        document.body.classList.remove('dragging-y');
        window.agentworkspace.dragEnd(currentPos(axis, pointerPos(event), chrome));
      }}
      onPointerCancel={() => {
        if (!dragging.current) return;
        dragging.current = false;
        setDraggingState(false);
        document.body.classList.remove('dragging');
        document.body.classList.remove('dragging-y');
        window.agentworkspace.dragCancel();
      }}
    >
      <div className="splitter-line" />
    </div>
  );
}
