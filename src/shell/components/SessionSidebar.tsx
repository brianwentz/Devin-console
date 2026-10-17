import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Plus,
  RefreshCw,
  SquarePen,
} from 'lucide-react';
import type { CloudSessionState } from '../../shared/ipc';
import {
  addFolder,
  buildSessionTree,
  moveSession,
  removeFolder,
  renameFolder,
  reorderFolders,
  type CloudListData,
  type SessionTreeNode,
} from '../../core/sessionTree';
import type { Rect } from '../../core/layout';
import { useShellState } from '../store';
import { relativeTime } from './relativeTime';
import { sessionRowClass, sessionMetaClass, sessionFolderHeaderClass } from './sessionRowStyles';

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

const SECTION_LABELS: Record<string, string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  participated: 'Participated',
};

const SESSION_MIME = 'application/x-devin-session';
const FOLDER_MIME = 'application/x-devin-folder';

// 'pinned'/'participated' are system folders: not editable/reorderable, but
// like the web app they ARE move targets (POST sessions/folder).
const isEditableFolder = (name: string) => name !== 'pinned' && name !== 'participated';
const isMoveTarget = (section: { kind: string }) =>
  section.kind === 'folder' || section.kind === 'recent';

const OP_LABELS: Record<string, string> = {
  'folder-create': 'create folder',
  'folder-rename': 'rename folder',
  'folder-delete': 'delete folder',
  'folder-reorder': 'reorder folders',
  'session-move': 'move session',
  'session-archive': 'archive session',
};

// Inline folder-name editor shared by create and rename.
function FolderNameInput({
  initial = '',
  placeholder,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      id="sessionFolderEdit"
      type="text"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      className="w-full h-6 px-1.5 rounded bg-[#141d29] border border-[#54749c] text-xs placeholder-[#5c6b80] focus:outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const name = e.currentTarget.value.trim();
          if (name) onCommit(name);
        } else if (e.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}

function statusText(cloud: ReturnType<typeof useCloud>): string {
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

function useCloud() {
  return useShellState()!.cloud;
}

type PrCounts = CloudSessionState['prs'];

// PR status badge group — same buckets/colours as the web sidebar. The count
// is hidden when exactly one bucket is present with a single PR.
const PR_BUCKETS: {
  key: keyof PrCounts;
  label: string;
  color: string;
  Icon: typeof GitPullRequest;
}[] = [
  { key: 'open', label: 'open', color: '#3fb950', Icon: GitPullRequest },
  { key: 'queued', label: 'queued', color: '#d29922', Icon: GitPullRequest },
  { key: 'draft', label: 'draft', color: '#8b9bb0', Icon: GitPullRequestDraft },
  { key: 'merged', label: 'merged', color: '#a371f7', Icon: GitMerge },
  { key: 'closed', label: 'closed', color: '#f85149', Icon: GitPullRequestClosed },
];

function PrBadges({ prs }: { prs: PrCounts }) {
  const present = PR_BUCKETS.filter((b) => prs[b.key] > 0);
  if (present.length === 0) return null;
  const hideCount = present.length === 1 && prs[present[0]!.key] === 1;
  const title = present.map((b) => `${prs[b.key]} ${b.label}`).join(', ');
  return (
    <span className="shrink-0 flex items-center gap-1" title={title}>
      {present.map(({ key, color, Icon }) => (
        <span key={key} className="flex items-center" style={{ color }}>
          <Icon size={12} />
          {!hideCount && (
            <span className="text-[11px] leading-[14px] ml-0.5">{prs[key]}</span>
          )}
        </span>
      ))}
    </span>
  );
}

// Hovering a row for 300 ms prefetches the session's pooled view so a click
// lands on an already-loaded page.
function usePrefetch(): {
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
        window.devinworkspaces.cloudPrefetch(id);
      }, 300);
    },
    onLeave: cancel,
  };
}

function Row({
  node,
  collapsedChildren,
  onToggleChildren,
  registerRow,
  liveIds,
  prefetch,
  onMenu,
}: {
  node: SessionTreeNode<CloudSessionState>;
  collapsedChildren: Set<string>;
  onToggleChildren: (id: string) => void;
  registerRow: (el: HTMLButtonElement | null) => void;
  liveIds: Set<string>;
  prefetch: ReturnType<typeof usePrefetch>;
  onMenu: (sessionId: string, x: number, y: number) => void;
}) {
  const s = node.session;
  const hasChildren = node.children.length > 0 || s.directChildrenCount > 0;
  const childrenVisible = !collapsedChildren.has(s.id);
  return (
    <>
      <div className="flex items-center" style={{ paddingLeft: node.depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={childrenVisible ? 'Collapse children' : 'Expand children'}
            className="w-4 h-4 shrink-0 flex items-center justify-center text-[#8b9bb0] hover:text-[#c9d4e3]"
            onClick={(e) => {
              e.stopPropagation();
              onToggleChildren(s.id);
            }}
          >
            {childrenVisible ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          ref={registerRow}
          data-session-id={s.id}
          data-depth={node.depth}
          data-current={node.current}
          data-unread={s.isUnread}
          data-status-enum={s.statusEnum ?? s.status}
          data-pr-open={s.prs.open}
          data-pr-merged={s.prs.merged}
          data-archived={s.isArchived}
          data-live={liveIds.has(s.id)}
          title={s.title || 'Untitled session'}
          className={`session-row ${s.isArchived ? 'opacity-50' : ''} flex-1 min-w-0 flex items-center ${sessionRowClass} text-left text-[#c9d4e3] hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[current=true]:bg-[#1f2f42] data-[live=true]:border-l-2 data-[live=true]:border-l-[#3d5a80]`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SESSION_MIME, s.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onMouseEnter={() => prefetch.onEnter(s.id)}
          onMouseLeave={prefetch.onLeave}
          onClick={() => window.devinworkspaces.cloudOpen(s.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu(s.id, e.clientX, e.clientY);
          }}
        >
          <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: statusColor(s.statusEnum, s.status) }}
            />
          </span>
          <span
            className={`flex-1 min-w-0 truncate ${s.isUnread ? 'font-medium text-white' : ''}`}
          >
            {s.title || 'Untitled session'}
          </span>
          <PrBadges prs={s.prs} />
          <span className={`shrink-0 ${sessionMetaClass}`}>
            {relativeTime(s.updatedAt, Date.now())}
          </span>
        </button>
      </div>
      {childrenVisible &&
        node.children.map((child) => (
          <Row
            key={child.session.id}
            node={child}
            collapsedChildren={collapsedChildren}
            onToggleChildren={onToggleChildren}
            registerRow={registerRow}
            liveIds={liveIds}
            prefetch={prefetch}
            onMenu={onMenu}
          />
        ))}
    </>
  );
}

export function SessionSidebar({ rect }: { rect: Rect }) {
  const state = useShellState();
  const prefetch = usePrefetch();
  const [query, setQuery] = useState('');
  const [collapsedChildren, setCollapsedChildren] = useState<Set<string>>(new Set());
  const [override, setOverride] = useState<CloudListData | null>(null);
  const [editing, setEditing] = useState<
    { kind: 'create'; pendingSessionId?: string } | { kind: 'rename'; name: string } | null
  >(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const rowRefs = useRef<HTMLButtonElement[]>([]);
  rowRefs.current = [];

  const cloud = state!.cloud;
  const liveIds = useMemo(() => new Set(cloud.liveSessionIds), [cloud.liveSessionIds]);
  const collapsedFolders = state!.settings.sessions.collapsedFolders;

  const cloudData = useMemo<CloudListData>(
    () => ({
      sessions: cloud.sessions,
      folders: cloud.folders,
      folderTotals: cloud.folderTotals,
    }),
    [cloud.sessions, cloud.folders, cloud.folderTotals],
  );
  // Optimistic edits hold until the next cloud update (a successful list —
  // or the test-mode fake applying the same change — replaces them) or a
  // mutation failure lands in lastError (revert).
  useEffect(() => {
    setOverride(null);
  }, [cloud.lastSyncAt, cloud.lastError]);
  const baseData = override ?? cloudData;
  const data = useMemo<CloudListData>(
    () => ({
      ...baseData,
      sessions: baseData.sessions.filter((s) => cloud.showArchived || !s.isArchived),
    }),
    [baseData, cloud.showArchived],
  );
  const userFolderNames = useMemo(
    () => data.folders.filter(isEditableFolder),
    [data.folders],
  );

  const applyOptimistic = (fn: (d: CloudListData) => CloudListData) =>
    setOverride(fn(baseData));
  const createFolder = (name: string, pendingSessionId?: string) => {
    applyOptimistic((d) => {
      const next = addFolder(d, name);
      return pendingSessionId ? moveSession(next, pendingSessionId, name) : next;
    });
    window.devinworkspaces.cloudFolderCreate(name);
    if (pendingSessionId) window.devinworkspaces.cloudSessionMove(pendingSessionId, name);
  };
  const renameFolderTo = (oldName: string, newName: string) => {
    applyOptimistic((d) => renameFolder(d, oldName, newName));
    window.devinworkspaces.cloudFolderRename(oldName, newName);
  };
  const moveSessionTo = (id: string, folder: string | null) => {
    applyOptimistic((d) => moveSession(d, id, folder));
    window.devinworkspaces.cloudSessionMove(id, folder);
  };
  const reorderTo = (names: string[]) => {
    applyOptimistic((d) => reorderFolders(d, names));
    window.devinworkspaces.cloudFolderReorder(names);
  };

  const sessionMenu = async (sessionId: string, x: number, y: number) => {
    const { action } = await window.devinworkspaces.cloudContextMenu({
      kind: 'session',
      sessionId,
      x,
      y,
    });
    if (action === 'new-folder') setEditing({ kind: 'create', pendingSessionId: sessionId });
  };
  const folderMenu = async (name: string, x: number, y: number) => {
    const { action } = await window.devinworkspaces.cloudContextMenu({
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
        currentSessionId: state!.currentSessionId,
      }),
    [data, collapsedFolders, state!.currentSessionId],
  );

  const toggleFolder = (name: string) => {
    const next = collapsedFolders.includes(name)
      ? collapsedFolders.filter((f) => f !== name)
      : [...collapsedFolders, name];
    void window.devinworkspaces.setSettings({ sessions: { collapsedFolders: next } });
  };

  const toggleChildren = (id: string) => {
    setCollapsedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const registerRow = (el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.push(el);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
      const active = document.activeElement;
      const id = active?.getAttribute('data-session-id');
      if (id) {
        window.devinworkspaces.cloudCopyLink(id);
        event.preventDefault();
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = rowRefs.current.filter((el) => el.isConnected);
    if (rows.length === 0) return;
    event.preventDefault();
    const active = document.activeElement;
    const index = rows.findIndex((el) => el === active);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next =
      index === -1
        ? (delta + rows.length) % rows.length
        : (index + delta + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const q = query.trim().toLowerCase();
  const filtered: CloudSessionState[] = q
    ? data.sessions.filter((s) => s.title.toLowerCase().includes(q))
    : [];

  return (
    <section
      id="sessionsPanel"
      className="shell-chrome absolute flex flex-col bg-[#0d141d] border-r border-[#1e2a38] text-[#c9d4e3]"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-[13px] font-semibold flex-1">Sessions</span>
        <button
          id="sessionNew"
          type="button"
          aria-label="New session"
          title="New session"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => window.devinworkspaces.cloudNewSession(null)}
        >
          <SquarePen size={13} />
        </button>
        <button
          id="sessionFolderNew"
          type="button"
          aria-label="New folder"
          title="New folder"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => setEditing({ kind: 'create' })}
        >
          <Plus size={13} />
        </button>
        <button
          id="cloudRefresh"
          type="button"
          aria-label="Refresh sessions"
          title="Refresh"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => window.devinworkspaces.cloudRefresh()}
        >
          <RefreshCw size={13} className={cloud.status === 'connecting' ? 'animate-spin' : ''} />
        </button>
        <button
          id="sessionsMenu"
          type="button"
          aria-label="Sessions options"
          title="More"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={(e) =>
            void window.devinworkspaces.cloudContextMenu({
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
        id="cloudStatus"
        data-cloud-status={cloud.status}
        data-cloud-cached={cloud.cached}
        className="px-3 pb-1.5 text-[11px] text-[#8b9bb0] truncate"
        title={cloud.status === 'error' ? (cloud.error ?? '') : undefined}
      >
        {statusText(cloud)}
      </div>
      {cloud.lastError && (
        <div
          id="sessionsError"
          className="px-3 pb-1.5 text-[11px] text-[#e0a03c] truncate"
        >
          Couldn't {OP_LABELS[cloud.lastError.op] ?? cloud.lastError.op} ·{' '}
          {cloud.lastError.message}
        </div>
      )}
      <div className="px-3 pb-2">
        <input
          id="sessionSearch"
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
            filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                ref={registerRow}
                data-session-id={s.id}
                data-depth={0}
                data-current={s.id === state!.currentSessionId}
                data-unread={s.isUnread}
                data-status-enum={s.statusEnum ?? s.status}
                data-pr-open={s.prs.open}
                data-pr-merged={s.prs.merged}
                data-archived={s.isArchived}
                data-live={liveIds.has(s.id)}
                title={s.title || 'Untitled session'}
                className={`${s.isArchived ? 'opacity-50 ' : ''}w-full flex items-center ${sessionRowClass} text-left hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[live=true]:border-l-2 data-[live=true]:border-l-[#3d5a80]`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(SESSION_MIME, s.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onMouseEnter={() => prefetch.onEnter(s.id)}
                onMouseLeave={prefetch.onLeave}
                onClick={() => window.devinworkspaces.cloudOpen(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void sessionMenu(s.id, e.clientX, e.clientY);
                }}
              >
                <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: statusColor(s.statusEnum, s.status) }}
                  />
                </span>
                <span
                  className={`flex-1 min-w-0 truncate ${s.isUnread ? 'font-medium text-white' : ''}`}
                >
                  {s.title || 'Untitled session'}
                </span>
                <span className={`shrink-0 ${sessionMetaClass}`}>
                  {relativeTime(s.updatedAt, Date.now())}
                </span>
              </button>
            ))
          )
        ) : tree.sections.length === 0 && cloud.status === 'ready' ? (
          <div className="px-2 py-3 text-[12px] text-[#5c6b80]">No sessions yet</div>
        ) : (
          tree.sections.map((sectionItem) => (
            <div key={`${sectionItem.kind}:${sectionItem.name}`} className="mb-px">
              {editing?.kind === 'rename' && editing.name === sectionItem.name ? (
                <div className="px-1 py-1">
                  <FolderNameInput
                    initial={sectionItem.name}
                    placeholder="Folder name"
                    onCommit={(name) => {
                      renameFolderTo(sectionItem.name, name);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <span className="group flex items-center">
                  <button
                    type="button"
                    data-section-kind={sectionItem.kind}
                    data-section-name={sectionItem.name}
                    data-drop-target={dropTarget === sectionItem.name}
                    data-drop-before={dropBefore === sectionItem.name}
                    draggable={sectionItem.kind === 'folder' && isEditableFolder(sectionItem.name)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(FOLDER_MIME, sectionItem.name);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      const types = e.dataTransfer.types;
                      const isFolderTarget = isMoveTarget(sectionItem);
                      if (types.includes(SESSION_MIME) && isFolderTarget) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDropTarget(sectionItem.name);
                      } else if (
                        types.includes(FOLDER_MIME) &&
                        sectionItem.kind === 'folder' &&
                        isEditableFolder(sectionItem.name)
                      ) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDropBefore(sectionItem.name);
                      }
                    }}
                    onDragLeave={() => {
                      if (dropTarget === sectionItem.name) setDropTarget(null);
                      if (dropBefore === sectionItem.name) setDropBefore(null);
                    }}
                    onDrop={(e) => {
                      const sessionId = e.dataTransfer.getData(SESSION_MIME);
                      const target = isMoveTarget(sectionItem)
                        ? sectionItem.kind === 'recent'
                          ? null
                          : sectionItem.name
                        : undefined;
                      if (sessionId && target !== undefined) {
                        e.preventDefault();
                        moveSessionTo(sessionId, target);
                      }
                      const folder = e.dataTransfer.getData(FOLDER_MIME);
                      if (
                        folder &&
                        folder !== sectionItem.name &&
                        sectionItem.kind === 'folder' &&
                        isEditableFolder(sectionItem.name)
                      ) {
                        e.preventDefault();
                        const names = userFolderNames.filter((n) => n !== folder);
                        names.splice(names.indexOf(sectionItem.name), 0, folder);
                        reorderTo(names);
                      }
                      setDropTarget(null);
                      setDropBefore(null);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (sectionItem.kind === 'folder' && isEditableFolder(sectionItem.name)) {
                        void folderMenu(sectionItem.name, e.clientX, e.clientY);
                      }
                    }}
                    className={`flex-1 min-w-0 flex items-center gap-1 px-1 py-1 ${sessionFolderHeaderClass} text-[#8b9bb0] hover:text-[#c9d4e3] data-[drop-target=true]:bg-[#1f2f42] data-[drop-before=true]:border-t-2 data-[drop-before=true]:border-t-[#54749c]`}
                    onClick={() => toggleFolder(sectionItem.name)}
                  >
                    {sectionItem.collapsed ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    <span className="flex-1 text-left truncate">
                      {SECTION_LABELS[sectionItem.name] ?? sectionItem.name}
                    </span>
                    <span className="text-[11px] leading-[14px] text-[#5c6b80]">
                      {sectionItem.total !== null
                        ? `${sectionItem.nodes.length} / ${sectionItem.total}`
                        : sectionItem.nodes.length}
                    </span>
                  </button>
                  {sectionItem.kind === 'folder' && isEditableFolder(sectionItem.name) && (
                    <button
                      type="button"
                      data-folder-new-session={sectionItem.name}
                      aria-label="New session in folder"
                      title="New session in folder"
                      className="w-5 h-5 mr-1 shrink-0 flex items-center justify-center rounded text-[#5c6b80] hover:text-[#c9d4e3] hover:bg-[#1a2735] opacity-0 group-hover:opacity-100 focus:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.devinworkspaces.cloudNewSession(sectionItem.name);
                      }}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </span>
              )}
              {!sectionItem.collapsed && (
                <>
                  {sectionItem.nodes.length === 0 ? (
                    <div className="pl-6 py-1 text-[11px] text-[#5c6b80]">No sessions</div>
                  ) : (
                    sectionItem.nodes.map((node) => (
                      <Row
                        key={node.session.id}
                        node={node}
                        collapsedChildren={collapsedChildren}
                        onToggleChildren={toggleChildren}
                        registerRow={registerRow}
                        liveIds={liveIds}
                        prefetch={prefetch}
                        onMenu={(id, x, y) => void sessionMenu(id, x, y)}
                      />
                    ))
                  )}
                  {sectionItem.hasMore && (
                    <button
                      type="button"
                      data-load-more={sectionItem.name}
                      className="w-full pl-6 py-1 text-left text-[11px] text-[#6e9bd0] hover:text-[#9fc4ea]"
                      onClick={() => window.devinworkspaces.cloudLoadMore(sectionItem.name)}
                    >
                      Show more
                    </button>
                  )}
                </>
              )}
            </div>
          ))
        )}
        {editing?.kind === 'create' && (
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
