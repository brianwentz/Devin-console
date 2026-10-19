import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  clampPaneWidth,
  leftChrome,
  SPLITTER_WIDTH,
  type Rect,
} from '../../core/layout';
import { useShellState } from '../store';

interface SplitterProps {
  axis: 'x' | 'y' | 's';
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
  axis: 'x' | 'y' | 's',
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
    ? leftChrome(
        {
          paneOpen: state.paneOpen,
          paneFraction: state.paneFraction,
          terminalOpen: state.terminalOpen,
          terminalHeight: state.terminalHeight,
          sessionsOpen: state.sessionsOpen && state.surface === 'cloud',
          sessionsWidth: state.sessionsWidth,
        },
        document.documentElement.clientWidth,
      )
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
        window.devinworkspaces.dragCancel('escape');
      }
    };
    const offReset = window.devinworkspaces.onDragReset(reset);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      offReset();
    };
  }, [axis]);

  const pointerPos = (event: PointerEvent) =>
    axis === 'y' ? event.clientY : event.clientX;

  const id =
    axis === 'x' ? 'splitter' : axis === 's' ? 'sessionsSplitter' : 'terminalSplitter';
  const label =
    axis === 'x'
      ? 'Resize GitHub pane'
      : axis === 's'
        ? 'Resize sessions sidebar'
        : 'Resize terminal dock';

  return (
    <div
      id={id}
      role="separator"
      aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
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
        cursor: enabled ? (axis === 'y' ? 'row-resize' : 'col-resize') : 'default',
        touchAction: 'none',
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !enabled) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        setDraggingState(true);
        document.body.classList.add(axis === 'y' ? 'dragging-y' : 'dragging');
        window.devinworkspaces.dragStart(axis, currentPos(axis, pointerPos(event), chrome));
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        window.devinworkspaces.dragMove(currentPos(axis, pointerPos(event), chrome));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        setDraggingState(false);
        document.body.classList.remove('dragging');
        document.body.classList.remove('dragging-y');
        window.devinworkspaces.dragEnd(currentPos(axis, pointerPos(event), chrome));
      }}
      onPointerCancel={() => {
        if (!dragging.current) return;
        dragging.current = false;
        setDraggingState(false);
        document.body.classList.remove('dragging');
        document.body.classList.remove('dragging-y');
        window.devinworkspaces.dragCancel();
      }}
    >
      <div className="splitter-line" />
    </div>
  );
}
