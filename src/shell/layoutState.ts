import {
  DEFAULT_REVIEW_TERMINAL_HEIGHT,
  layoutStateFromState,
  type LayoutState,
} from '../core/layout';
import type { ShellState } from '../shared/ipc';

// The shell-side LayoutState mapper (pure, React-free so the drift test can
// import it). Must agree with main's `layoutState()` — both go through
// `layoutStateFromState`.
export function layoutStateFromShellState(state: ShellState): LayoutState {
  return layoutStateFromState({
    surface: state.surface,
    paneOpen: state.paneOpen,
    paneFraction: state.paneFraction,
    terminalOpen: state.terminalOpen,
    terminalHeight: state.terminalHeight,
    sessionsOpen: state.sessionsOpen,
    sessionsWidth: state.sessionsWidth,
    addressBarOpen: state.tabs.addressBar.open,
    reviewTerminalOpen: state.reviewTerminalOpen ?? false,
    reviewTerminalHeight: state.reviewTerminalHeight ?? DEFAULT_REVIEW_TERMINAL_HEIGHT,
  });
}
