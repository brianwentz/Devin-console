// OpenHands (B1 T20): effective base URL and the ShellState slice. The runtime
// (sessions controller + view pool) replaces `openhandsSnapshot`'s source later;
// until then the surface shows a static idle state and no hosted view.
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

export function openhandsSnapshot(): OpenHandsShellState {
  return {
    ...INITIAL_STATE,
    sessions: [],
    folders: [],
    capabilities: { ...INITIAL_STATE.capabilities },
  };
}
