import { useMemo } from 'react';
import type { Rect } from '../../core/layout';
import { openhandsStatusLine } from '../../core/openhands';
import type { CloudState, OpenHandsShellState } from '../../shared/ipc';
import { SessionSidebar, type SessionSidebarActions } from '../components/SessionSidebar';
import { useShellState, setSettingsTab } from '../store';
import { requestSurface } from '../surface';

// Base ids whose OpenHands DOM id is not just `openhands<Id>`.
const ID_ALIASES = { cloudRefresh: 'refresh', sessionSearch: 'filter' } as const;

// SessionSidebar reads CloudState; the OpenHands slice carries the subset it
// needs. 'idle' (nothing contacted yet) renders as 'connecting' with its own
// status line.
function toCloudState(oh: OpenHandsShellState): CloudState {
  return {
    status: oh.status === 'idle' ? 'connecting' : oh.status,
    lastSyncAt: null,
    error: null,
    folders: oh.folders,
    folderTotals: {},
    sessions: oh.sessions,
    liveSessionIds: [],
    showArchived: false,
    lastError: oh.lastError,
    cached: oh.cached,
    capabilities: oh.capabilities,
  };
}

const openSettingsTab = () => {
  setSettingsTab('openhands');
  void requestSurface('settings');
};

/**
 * OpenHands adapter: maps ShellState.openhands onto the capability-driven
 * SessionSidebar. Collapse + row order persist under `openhands.collapsedRepos`
 * / `openhands.sessionOrder` (never Devin's `sessions.*`).
 */
export function OpenHandsSidebar({ rect }: { rect: Rect }) {
  const state = useShellState()!;
  const oh = state.openhands;
  const cloud = useMemo(() => toCloudState(oh), [oh]);
  const actions = useMemo<SessionSidebarActions>(
    () => ({
      open: (id) => window.agentworkspace.openhandsOpen(id),
      prefetch: () => {},
      copyLink: (id) => {
        const url = oh.sessions.find((s) => s.id === id)?.url;
        if (url) window.agentworkspace.clipboardWriteText(url);
      },
      newSession: () => window.agentworkspace.openhandsNewSession(),
      refresh: () => window.agentworkspace.openhandsRefresh(),
      loadMore: () => {},
      contextMenu: async (request) => {
        if (request.kind === 'folder') return { action: null };
        return window.agentworkspace.openhandsContextMenu({
          kind: request.kind,
          x: request.x,
          y: request.y,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
      },
      sessionRename: (id, title) => window.agentworkspace.openhandsRename(id, title),
      // Derived (repository) sections are read-only grouping.
      folderCreate: () => {},
      folderRename: () => {},
      folderReorder: () => {},
      sessionMove: () => {},
      sessionReorder: (section, ids) => window.agentworkspace.openhandsSessionReorder(section, ids),
      setCollapsedFolders: (names) =>
        void window.agentworkspace.setSettings({ openhands: { collapsedRepos: names } }),
    }),
    [oh.sessions],
  );
  const conn = oh.connection;
  const banner = (
    <>
      {conn === 'login-required' && (
        <button
          id="openhandsLogin"
          type="button"
          className="mx-3 mb-1.5 px-2 h-6 rounded text-left text-[11px] text-[#6e9bd0] hover:text-[#9fc4ea] hover:bg-[#1a2735]"
          onClick={() => window.agentworkspace.openhandsOpenHome()}
        >
          Sign in to OpenHands
        </button>
      )}
      {(conn === 'api-key-required' || conn === 'api-key-rejected') && (
        <button
          id="openhandsApiKeyHint"
          type="button"
          className="mx-3 mb-1.5 px-2 h-6 rounded text-left text-[11px] text-[#e0a03c] hover:bg-[#1a2735]"
          onClick={openSettingsTab}
        >
          {conn === 'api-key-rejected'
            ? 'API key rejected — update it in Settings'
            : 'API key required — add it in Settings'}
        </button>
      )}
    </>
  );
  return (
    <SessionSidebar
      rect={rect}
      providerId="openhands"
      idPrefix="openhands"
      idAliases={ID_ALIASES}
      capabilities={oh.capabilities}
      state={{
        cloud,
        collapsedFolders: state.settings.openhands.collapsedRepos,
        sessionOrder: state.settings.openhands.sessionOrder,
        currentSessionId: state.openhandsSessionId,
      }}
      actions={actions}
      statusText={() => openhandsStatusLine(oh.status, oh.connection)}
      banner={banner}
    />
  );
}
