import type { Rect } from '../../core/layout';
import { useShellState } from '../store';
import { SessionSidebar, type SessionSidebarActions } from './SessionSidebar';

// devin-cloud's IPC surface for the shared SessionSidebar. Arrow wrappers read
// window.agentworkspace at call time; module-level so the object is stable.
const DEVIN_CLOUD_ACTIONS: SessionSidebarActions = {
  open: (id) => window.agentworkspace.cloudOpen(id),
  prefetch: (id) => window.agentworkspace.cloudPrefetch(id),
  copyLink: (id) => window.agentworkspace.cloudCopyLink(id),
  newSession: (folder) => window.agentworkspace.cloudNewSession(folder),
  refresh: () => window.agentworkspace.cloudRefresh(),
  loadMore: (folder) => window.agentworkspace.cloudLoadMore(folder),
  contextMenu: (request) => window.agentworkspace.cloudContextMenu(request),
  folderCreate: (name) => window.agentworkspace.cloudFolderCreate(name),
  folderRename: (oldName, newName) => window.agentworkspace.cloudFolderRename(oldName, newName),
  folderReorder: (names) => window.agentworkspace.cloudFolderReorder(names),
  sessionMove: (id, folder) => window.agentworkspace.cloudSessionMove(id, folder),
  sessionReorder: (section, ids) => window.agentworkspace.cloudSessionReorder(section, ids),
  setCollapsedFolders: (names) =>
    void window.agentworkspace.setSettings({ sessions: { collapsedFolders: names } }),
};

/** devin-cloud adapter: maps ShellState onto the capability-driven SessionSidebar. */
export function DevinCloudSidebar({ rect }: { rect: Rect }) {
  const state = useShellState()!;
  return (
    <SessionSidebar
      rect={rect}
      providerId="devin-cloud"
      idPrefix=""
      capabilities={state.cloud.capabilities}
      state={{
        cloud: state.cloud,
        collapsedFolders: state.settings.sessions.collapsedFolders,
        sessionOrder: state.settings.sessions.sessionOrder,
        currentSessionId: state.currentSessionId,
      }}
      actions={DEVIN_CLOUD_ACTIONS}
    />
  );
}
