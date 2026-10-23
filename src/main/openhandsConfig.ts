// OpenHands (B1): effective base URL and the ShellState slice. The runtime
// (src/main/providers/openhands.ts) feeds the live snapshot; until it has
// started the surface shows a static idle state.
import { effectiveBaseUrl } from '../core/openhands';
import { OPENHANDS_DEFAULT_BASE_URL, type OpenHandsShellState } from '../shared/ipc';
import { state, testMode } from './state';

// Settings value, unless AGENT_WORKSPACE_TEST_OPENHANDS_URL / _URL_MAP (test
// mode only) override it in memory - never written back to settings.json.
// The single place the effective base is computed.
export function openhandsEffectiveBase(saved: string | undefined): string {
  return effectiveBaseUrl(
    saved ?? OPENHANDS_DEFAULT_BASE_URL,
    testMode ? process.env.AGENT_WORKSPACE_TEST_OPENHANDS_URL : undefined,
    testMode ? process.env.AGENT_WORKSPACE_TEST_OPENHANDS_URL_MAP : undefined,
  );
}

export function openhandsBaseUrl(): string {
  return openhandsEffectiveBase(state.settings?.current.openhands.baseUrl);
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

// Static idle state, optionally carrying a runtime-local error (rename/delete
// with no gate open) so it is visible before any controller exists.
export function idleOpenHandsState(lastError: OpenHandsShellState['lastError'] = null): OpenHandsShellState {
  return {
    ...INITIAL_STATE,
    sessions: [],
    folders: [],
    lastError,
    capabilities: { ...INITIAL_STATE.capabilities },
  };
}

export function openhandsSnapshot(): OpenHandsShellState {
  return snapshotSource?.() ?? idleOpenHandsState();
}
