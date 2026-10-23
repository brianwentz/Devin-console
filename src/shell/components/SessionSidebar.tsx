import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, Plus, RefreshCw, SquarePen } from 'lucide-react';
import type { CloudContextMenuRequest, CloudSessionState, CloudState } from '../../shared/ipc';
import type { CloudSourceCapabilities } from '../../core/cloudKit/capabilities';
import { prefixedId, sidebarListData } from '../../core/cloudKit/sidebar';
import {
  addFolder,
  buildSessionTree,
  moveSession,
  renameFolder,
  reorderFolders,
  type CloudListData,
} from '../../core/sessionTree';
import type { Rect } from '../../core/layout';
import { relativeTime } from './relativeTime';
import { sessionRowClass } from './sessionRowStyles';
import { FolderNameInput } from './sidebar/FolderNameInput';
import { PrBadges } from './sidebar/PrBadges';
import { SessionRow, SessionRowButton } from './sidebar/SessionRow';
import { ReorderableRow } from './sidebar/ReorderableRow';
import { SectionHeader } from './sidebar/SectionHeader';
import { isEditableFolder } from './sidebar/dnd';
import { useOptimisticList } from './sidebar/useOptimisticList';
import { useRowKeyboardNav } from './sidebar/useRowKeyboardNav';

// statusEnum → status dot color.
const STATUS_COLOR: Record<string, string> = {
  blocked: '#e0a03c',
  waiting: '#e0a03c',
  waiting_for_user: '#e0a03c',
  waiting_for_approval: '#e0a03c',
  working: '#6e9bd0',
  running: '#6e9bd0',
  finished: '#3fa35f',
  exit: '#3fa35f',
  crashed: '#d93a2f',
  error: '#d93a2f',
};
const statusColor = (statusEnum: string | null, status: string) =>
  STATUS_COLOR[statusEnum ?? status] ?? '#8b9bb0';

const OP_LABELS: Record<string, string> = {
  'folder-create': 'create folder',
  'folder-rename': 'rename folder',
  'folder-delete': 'delete folder',
  'folder-reorder': 'reorder folders',
  'session-move': 'move session',
  'session-archive': 'archive session',
};

function statusText(cloud: CloudState): string {
  switch (cloud.status) {
    case 'ready':
      return cloud.lastSyncAt
        ? (() => {
            const rel = relativeTime(Date.parse(cloud.lastSyncAt), Date.now());
            return rel === 'just now' ? 'synced just now' : `synced ${rel} ago`;
          })()
        : 'synced';
    case 'connecting':
      return cloud.cached ? 'Connecting… · showing cached list' : 'Connecting…';
    case 'no-token':
      return 'Sign in to Devin to load sessions';
    case 'error':
      return cloud.error ?? 'Error';
    default:
      return 'Unavailable';
  }
}

// Hovering a row for 300 ms prefetches the session's pooled view so a click
// lands on an already-loaded page.
function usePrefetch(prefetchSession: (id: string) => void): {
  onEnter: (id: string) => void;
  onLeave: () => void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  return {
    onEnter: (id: string) => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        prefetchSession(id);
      }, 300);
    },
    onLeave: cancel,
  };
}

/** What the sidebar renders — the provider adapter maps its own state onto this. */
export interface SessionSidebarState {
  cloud: CloudState;
  collapsedFolders: string[];
  sessionOrder: Record<string, string[]>;
  currentSessionId: string | null;
}

/** Everything the sidebar sends back to main — one provider's IPC surface. */
export interface SessionSidebarActions {
  open: (id: string) => void;
  prefetch: (id: string) => void;
  copyLink: (id: string) => void;
  newSession: (folder: string | null) => void;
  refresh: () => void;
  loadMore: (folder: string) => void;
  contextMenu: (request: CloudContextMenuRequest) => Promise<{ action: string | null }>;
  /** Inline session rename (providers whose capabilities.rename is true). */
  sessionRename?: (id: string, title: string) => void;
  folderCreate: (name: string) => void;
  folderRename: (oldName: string, newName: string) => void;
  folderReorder: (names: string[]) => void;
  sessionMove: (id: string, folder: string | null) => void;
  sessionReorder: (section: string, ids: string[]) => void;
  setCollapsedFolders: (names: string[]) => void;
}

export interface SessionSidebarProps {
  rect: Rect;
  providerId: string;
  /** '' keeps the original DOM ids (Devin); else ids become `<prefix><Id>`. */
  idPrefix: string;
  capabilities: CloudSourceCapabilities;
  state: SessionSidebarState;
  actions: SessionSidebarActions;
  /** Base id -> id suffix for prefixed ids that are not just `<prefix><Id>`
   * (OpenHands: cloudRefresh -> openhandsRefresh, sessionSearch -> openhandsFilter). */
  idAliases?: Partial<Record<string, string>>;
  /** Status line override (e.g. provider-specific sign-in text). */
  statusText?: (cloud: CloudState) => string | undefined;
  /** Rows under the status line (login / API-key hints). */
  banner?: ReactNode;
}

export function SessionSidebar({
  rect,
  providerId,
  idPrefix,
  capabilities,
  state,
  actions,
  idAliases,
  statusText: statusTextOverride,
  banner,
}: SessionSidebarProps) {
  const prefetch = usePrefetch(actions.prefetch);
  const pid = (id: string) => prefixedId(idPrefix, idAliases?.[id] ?? id);
  const serverFolders = capabilities.folders === 'server';
  const [query, setQuery] = useState('');
  const [collapsedChildren, setCollapsedChildren] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<
    | { kind: 'create'; pendingSessionId?: string }
    | { kind: 'rename'; name: string }
    | { kind: 'rename-session'; id: string }
    | null
  >(null);
  const { registerRow, onKeyDown } = useRowKeyboardNav((id) => actions.copyLink(id));

  const { cloud, collapsedFolders, sessionOrder, currentSessionId } = state;
  const liveIds = useMemo(() => new Set(cloud.liveSessionIds), [cloud.liveSessionIds]);

  const cloudData = useMemo<CloudListData & { sessionOrder: Record<string, string[]> }>(
    () => ({
      sessions: cloud.sessions,
      folders: cloud.folders,
      folderTotals: cloud.folderTotals,
      sessionOrder,
    }),
    [cloud.sessions, cloud.folders, cloud.folderTotals, sessionOrder],
  );
  // Optimistic edits hold until the next cloud update (a successful list —
  // or the test-mode fake applying the same change — replaces them) or a
  // mutation failure lands in lastError (revert).
  const { data: baseData, applyOptimistic } = useOptimisticList(cloudData, [
    cloud.lastSyncAt,
    cloud.lastError,
    sessionOrder,
  ]);
  const data = useMemo<CloudListData>(
    () => sidebarListData(baseData, capabilities, cloud.showArchived),
    [baseData, capabilities, cloud.showArchived],
  );
  // Only server folders are user folders (rename/reorder/move targets);
  // derived sections are read-only grouping.
  const userFolderNames = useMemo(
    () => (serverFolders ? data.folders.filter(isEditableFolder) : []),
    [data.folders, serverFolders],
  );

  const createFolder = (name: string, pendingSessionId?: string) => {
    applyOptimistic((d) => {
      const next = addFolder(d, name);
      return pendingSessionId ? moveSession(next, pendingSessionId, name) : next;
    });
    actions.folderCreate(name);
    if (pendingSessionId) actions.sessionMove(pendingSessionId, name);
  };
  const renameFolderTo = (oldName: string, newName: string) => {
    applyOptimistic((d) => renameFolder(d, oldName, newName));
    actions.folderRename(oldName, newName);
  };
  const moveSessionTo = (id: string, folder: string | null) => {
    applyOptimistic((d) => moveSession(d, id, folder));
    actions.sessionMove(id, folder);
  };
  const reorderTo = (names: string[]) => {
    applyOptimistic((d) => reorderFolders(d, names));
    actions.folderReorder(names);
  };
  const reorderSessionsTo = (section: string, ids: string[]) => {
    applyOptimistic((d) => ({
      ...d,
      sessionOrder: { ...d.sessionOrder, [section]: ids },
    }));
    actions.sessionReorder(section, ids);
  };

  const sessionMenu = async (sessionId: string, x: number, y: number) => {
    const { action } = await actions.contextMenu({
      kind: 'session',
      sessionId,
      x,
      y,
    });
    if (action === 'new-folder') setEditing({ kind: 'create', pendingSessionId: sessionId });
    else if (action === 'rename') setEditing({ kind: 'rename-session', id: sessionId });
  };
  const renameSessionTo = (id: string, title: string) => {
    applyOptimistic((d) => ({
      ...d,
      sessions: d.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
    actions.sessionRename?.(id, title);
  };
  // The row's place in the list while it is being renamed.
  const sessionEditor = (s: CloudSessionState) => (
    <div key={s.id} className="px-1 py-1">
      <FolderNameInput
        id={pid('sessionRenameEdit')}
        initial={s.title}
        placeholder="Session name"
        onCommit={(title) => {
          renameSessionTo(s.id, title);
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    </div>
  );
  const renamingId = editing?.kind === 'rename-session' ? editing.id : null;
  const folderMenu = async (name: string, x: number, y: number) => {
    const { action } = await actions.contextMenu({
      kind: 'folder',
      name,
      x,
      y,
    });
    if (action === 'rename') setEditing({ kind: 'rename', name });
  };

  const tree = useMemo(
    () =>
      buildSessionTree(data, {
        collapsedFolders,
        currentSessionId,
        sectionOrder: baseData.sessionOrder,
      }),
    [data, baseData.sessionOrder, collapsedFolders, currentSessionId],
  );

  const toggleFolder = (name: string) => {
    const next = collapsedFolders.includes(name)
      ? collapsedFolders.filter((f) => f !== name)
      : [...collapsedFolders, name];
    actions.setCollapsedFolders(next);
  };

  const toggleChildren = (id: string) => {
    setCollapsedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rowOpts = {
    attrs: (s: CloudSessionState) => ({
      'data-unread': s.isUnread,
      'data-status-enum': s.statusEnum ?? s.status,
      'data-pr-open': s.prs.open,
      'data-pr-merged': s.prs.merged,
      'data-archived': s.isArchived,
      'data-live': liveIds.has(s.id),
      // Prefixed (non-Devin) sidebars also expose the raw status (ShellState row status).
      ...(idPrefix ? { 'data-status': s.status } : {}),
    }),
    leading: (s: CloudSessionState) => (
      <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center">
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: statusColor(s.statusEnum, s.status) }}
        />
      </span>
    ),
    // Flat filtered rows show no badges (Cloud sidebar behaviour).
    badges: (s: CloudSessionState, variant: 'tree' | 'flat') =>
      variant === 'tree' ? <PrBadges prs={s.prs} /> : null,
    meta: (s: CloudSessionState) => relativeTime(s.updatedAt, Date.now()),
    title: (s: CloudSessionState) => s.title || 'Untitled session',
    titleClass: (s: CloudSessionState) =>
      s.isUnread ? 'font-medium text-white' : undefined,
    rowClass: (s: CloudSessionState, variant: 'tree' | 'flat') =>
      variant === 'tree'
        ? `session-row ${s.isArchived ? 'opacity-50' : ''} flex-1 min-w-0 flex items-center ${sessionRowClass} text-left text-[#c9d4e3] hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[current=true]:bg-[#1f2f42] data-[live=true]:border-l-2 data-[live=true]:border-l-[#3d5a80]`
        : `${s.isArchived ? 'opacity-50 ' : ''}w-full flex items-center ${sessionRowClass} text-left hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[live=true]:border-l-2 data-[live=true]:border-l-[#3d5a80]`,
    onOpen: (id: string) => actions.open(id),
    prefetch,
    hasChildren: (node: { session: CloudSessionState; children: unknown[] }) =>
      node.children.length > 0 || node.session.directChildrenCount > 0,
  };

  const q = query.trim().toLowerCase();
  const filtered: CloudSessionState[] = q
    ? data.sessions.filter((s) => s.title.toLowerCase().includes(q))
    : [];

  return (
    <section
      id={pid('sessionsPanel')}
      data-sidebar={providerId === 'devin-cloud' ? 'cloud' : providerId}
      className="shell-chrome absolute flex flex-col bg-[#0d141d] border-r border-[#1e2a38] text-[#c9d4e3]"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-[13px] font-semibold flex-1">Sessions</span>
        <button
          id={pid('sessionNew')}
          type="button"
          aria-label="New session"
          title="New session"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => actions.newSession(null)}
        >
          <SquarePen size={13} />
        </button>
        {serverFolders && (
          <button
            id={pid('sessionFolderNew')}
            type="button"
            aria-label="New folder"
            title="New folder"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
            onClick={() => setEditing({ kind: 'create' })}
          >
            <Plus size={13} />
          </button>
        )}
        <button
          id={pid('cloudRefresh')}
          type="button"
          aria-label="Refresh sessions"
          title="Refresh"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => actions.refresh()}
        >
          <RefreshCw size={13} className={cloud.status === 'connecting' ? 'animate-spin' : ''} />
        </button>
        <button
          id={pid('sessionsMenu')}
          type="button"
          aria-label="Sessions options"
          title="More"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={(e) =>
            void actions.contextMenu({
              kind: 'header',
              x: e.clientX,
              y: e.clientY,
            })
          }
        >
          <Ellipsis size={13} />
        </button>
      </div>
      <div
        id={pid('cloudStatus')}
        data-cloud-status={cloud.status}
        data-cloud-cached={cloud.cached}
        className="px-3 pb-1.5 text-[11px] text-[#8b9bb0] truncate"
        title={cloud.status === 'error' ? (cloud.error ?? '') : undefined}
      >
        {statusTextOverride?.(cloud) ?? statusText(cloud)}
      </div>
      {banner}
      {cloud.lastError && (
        <div
          id={pid('sessionsError')}
          className="px-3 pb-1.5 text-[11px] text-[#e0a03c] truncate"
        >
          Couldn't {OP_LABELS[cloud.lastError.op] ?? cloud.lastError.op} ·{' '}
          {cloud.lastError.message}
        </div>
      )}
      <div className="px-3 pb-2">
        <input
          id={pid('sessionSearch')}
          type="text"
          placeholder="Filter sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full h-7 px-2 rounded bg-[#141d29] border border-[#2c3949] text-[12px] placeholder-[#5c6b80] focus:outline-none focus:border-[#54749c]"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {q ? (
          filtered.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-[#5c6b80]">No matches</div>
          ) : (
            filtered.map((s) =>
              s.id === renamingId ? (
                sessionEditor(s)
              ) : (
              <SessionRowButton
                key={s.id}
                s={s}
                depth={0}
                current={s.id === currentSessionId}
                registerRow={registerRow}
                opts={rowOpts}
                onMenu={(id, x, y) => void sessionMenu(id, x, y)}
              />
              ),
            )
          )
        ) : tree.sections.length === 0 && cloud.status === 'ready' ? (
          <div className="px-2 py-3 text-[12px] text-[#5c6b80]">No sessions yet</div>
        ) : (
          tree.sections.map((sectionItem) => (
            <div key={`${sectionItem.kind}:${sectionItem.name}`} className="mb-px">
              <SectionHeader
                section={sectionItem}
                userFolderNames={userFolderNames}
                renaming={editing?.kind === 'rename' && editing.name === sectionItem.name}
                onRenameCommit={(name) => {
                  renameFolderTo(sectionItem.name, name);
                  setEditing(null);
                }}
                onRenameCancel={() => setEditing(null)}
                onToggle={toggleFolder}
                onMenu={(name, x, y) => {
                  if (serverFolders) void folderMenu(name, x, y);
                }}
                onMove={moveSessionTo}
                onReorder={reorderTo}
                moveDisabled={!serverFolders}
                reorderable={serverFolders && userFolderNames.length > 1}
                {...(serverFolders
                  ? { onNewInFolder: (name: string) => actions.newSession(name) }
                  : {})}
              />
              {!sectionItem.collapsed && (
                <>
                  {sectionItem.nodes.length === 0 ? (
                    <div className="pl-6 py-1 text-[11px] text-[#5c6b80]">No sessions</div>
                  ) : (
                    sectionItem.nodes.map((node) => {
                      if (node.session.id === renamingId) return sessionEditor(node.session);
                      const row = (
                        <SessionRow
                          key={node.session.id}
                          node={node}
                          collapsedChildren={collapsedChildren}
                          onToggleChildren={toggleChildren}
                          registerRow={registerRow}
                          opts={rowOpts}
                          onMenu={(id, x, y) => void sessionMenu(id, x, y)}
                        />
                      );
                      // No reorder → the bare row (no drop-indicator wrapper).
                      return capabilities.reorder ? (
                        <ReorderableRow
                          key={node.session.id}
                          section={sectionItem.name}
                          sessionId={node.session.id}
                          rootIds={sectionItem.nodes.map((n) => n.session.id)}
                          onReorder={reorderSessionsTo}
                        >
                          {row}
                        </ReorderableRow>
                      ) : (
                        row
                      );
                    })
                  )}
                  {sectionItem.hasMore && (
                    <button
                      type="button"
                      data-load-more={sectionItem.name}
                      className="w-full pl-6 py-1 text-left text-[11px] text-[#6e9bd0] hover:text-[#9fc4ea]"
                      onClick={() => actions.loadMore(sectionItem.name)}
                    >
                      Show more
                    </button>
                  )}
                </>
              )}
            </div>
          ))
        )}
        {serverFolders && editing?.kind === 'create' && (
          <div className="px-1 py-1">
            <FolderNameInput
              placeholder="New folder name"
              onCommit={(name) => {
                createFolder(name, editing.pendingSessionId);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
