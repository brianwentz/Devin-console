// OpenHands (B1): effective base URL and the ShellState slice. The runtime
// (src/main/providers/openhands.ts) feeds the live snapshot; until it has
// started the surface shows a static idle state.
import { effectiveBaseUrl } from '../core/openhands';
import { OPENHANDS_DEFAULT_BASE_URL, type OpenHandsShellState } from '../shared/ipc';
import { state, testMode } from './state';

// Settings value, unless AGENT_WORKSPACE_TEST_OPENHANDS_URL (test mode only)
// overrides it in memory — never written back to settings.json.
export function openhandsBaseUrl(): string {
  const saved = state.settings?.current.openhands.baseUrl ?? OPENHANDS_DEFAULT_BASE_URL;
  return effectiveBaseUrl(saved, testMode ? process.env.AGENT_WORKSPACE_TEST_OPENHANDS_URL : undefined);
}

const INITIAL_STATE: OpenHandsShellState = {
  status: 'idle',
  cached: false,
  sessions: [],
  folders: [],
  lastError: null,
  connection: 'idle',
  capabilities: { folders: 'derived', archive: false, rename: true, delete: true, reorder: true },
};

let snapshotSource: (() => OpenHandsShellState | null) | null = null;

export function setOpenHandsSnapshotSource(fn: (() => OpenHandsShellState | null) | null): void {
  snapshotSource = fn;
}

export function openhandsSnapshot(): OpenHandsShellState {
  const live = snapshotSource?.();
  if (live) return live;
  return {
    ...INITIAL_STATE,
    sessions: [],
    folders: [],
    capabilities: { ...INITIAL_STATE.capabilities },
  };
}
