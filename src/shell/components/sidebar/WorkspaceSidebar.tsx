// Generic workspace session column (ux2 D9): sections = path-bound workspace
// folders rendered through the shared SectionHeader/SessionRow primitives.
// LocalSidebar adapts the Local surface; P4b adapts Claude the same way.
import { useMemo, useState, type ReactNode } from 'react';
import { Ellipsis, FolderPlus, RefreshCw, SquarePen } from 'lucide-react';
import type { SessionTreeNode, SidebarListData, SidebarSession } from '../../../core/sessionTree';
import { buildSessionTree } from '../../../core/sessionTree';
import type { WorkspaceEntry } from '../../../core/workspaceTree';
import type { Rect } from '../../../core/layout';
import { workspaceLabel } from '../../../core/execHost';
import { SessionRow, SessionRowButton, type RowRenderOpts } from './SessionRow';
import { SectionHeader } from './SectionHeader';
import { useOptimisticList } from './useOptimisticList';
import { useRowKeyboardNav } from './useRowKeyboardNav';

export interface WorkspaceSidebarProps<S extends SidebarSession> {
  rect: Rect;
  dataSidebar: string;
  title: string;
  statusText: string;
  statusTitle?: string;
  error?: string | null;
  entries: WorkspaceEntry[];
  listData: SidebarListData<S>;
  collapsed: string[];
  currentSessionId: string | null;
  rowOpts: RowRenderOpts<S>;
  // Optional leading node per workspace header (agent status dot).
  headerLeading?: (path: string) => ReactNode;
  // Optional data-* attributes per workspace header (data-status, data-workspace).
  headerAttrs?: (path: string) => Record<string, string>;
  onToggle: (path: string) => void;
  onReorder: (paths: string[]) => void;
  onRename: (path: string, label: string) => void;
  onNewSession: (path: string | null) => void;
  onAdd: () => void;
  onRefresh: () => void;
  // Returns the menu's action; 'rename' is handled here (inline editor), the
  // adapter performs everything else itself.
  onWorkspaceMenu: (path: string, x: number, y: number) => Promise<string | null>;
  onSessionMenu: (id: string, x: number, y: number) => Promise<string | null>;
  onHeaderMenu: (x: number, y: number) => Promise<string | null>;
  onSectionHeaderClick?: (path: string) => void;
  onCopyId?: (id: string) => void;
  emptyText?: string;
  extraSections?: ReactNode;
  // Filter match: extra per-session text (e.g. cwd basename for Claude).
  filterTextOf?(session: S): string;
  // Claude extras: custom row renderers (subagent chevron + inline session
  // rename). Defaults render SessionRow / SessionRowButton respectively.
  renderRow?(node: SessionTreeNode<S>): ReactNode;
  renderFlatRow?(session: S): ReactNode;
  // Element ids are Local-flavoured by default; Claude passes its own.
  ids?: Partial<{ newSession: string; refresh: string; status: string }>;
  statusAttrs?: Record<string, string | undefined>;
  // Extra lines under the status row (Claude: cliPath / hostErrors / lastError).
  statusExtra?: ReactNode;
}

export function WorkspaceSidebar<S extends SidebarSession>({
  rect,
  dataSidebar,
  title,
  statusText,
  statusTitle,
  error,
  entries,
  listData,
  collapsed,
  currentSessionId,
  rowOpts,
  headerLeading,
  headerAttrs,
  onToggle,
  onReorder,
  onRename,
  onNewSession,
  onAdd,
  onRefresh,
  onWorkspaceMenu,
  onSessionMenu,
  onHeaderMenu,
  onSectionHeaderClick,
  onCopyId,
  emptyText,
  extraSections,
  filterTextOf,
  renderRow,
  renderFlatRow,
  ids,
  statusAttrs,
  statusExtra,
}: WorkspaceSidebarProps<S>) {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const { registerRow, onKeyDown } = useRowKeyboardNav(
    onCopyId ?? ((id) => void navigator.clipboard?.writeText(id)),
  );

  // Optimistic order/labels until the next settings publish replaces them.
  const { data, applyOptimistic } = useOptimisticList(
    useMemo(() => ({ entries, listData }), [entries, listData]),
    [entries, listData],
  );

  const tree = useMemo(
    () =>
      buildSessionTree(data.listData, {
        collapsedFolders: collapsed,
        currentSessionId,
      }),
    [data.listData, collapsed, currentSessionId],
  );
  const entryByPath = useMemo(() => new Map(data.entries.map((e) => [e.path, e])), [data.entries]);
  const userFolderNames = useMemo(() => data.entries.map((e) => e.path), [data.entries]);

  const reorderTo = (names: string[]) => {
    applyOptimistic((d) => ({
      ...d,
      entries: names
        .map((name) => entryByPath.get(name))
        .filter((e): e is WorkspaceEntry => Boolean(e)),
    }));
    onReorder(names);
  };
  const renameTo = (path: string, label: string) => {
    applyOptimistic((d) => ({
      ...d,
      entries: d.entries.map((e) => (e.path === path ? { ...e, label } : e)),
    }));
    onRename(path, label);
  };
  const workspaceMenu = async (path: string, x: number, y: number) => {
    const action = await onWorkspaceMenu(path, x, y);
    if (action === 'rename') setRenaming(path);
  };

  const q = query.trim().toLowerCase();
  const matches = (s: S) =>
    (s.title || 'Untitled session').toLowerCase().includes(q) ||
    (filterTextOf?.(s) ?? '').toLowerCase().includes(q) ||
    (s.folder !== null && (entryByPath.get(s.folder)?.label ?? '').toLowerCase().includes(q));
  const filtered: S[] = q ? data.listData.sessions.filter(matches) : [];

  return (
    <section
      id="sessionsPanel"
      data-sidebar={dataSidebar}
      className="shell-chrome absolute flex flex-col bg-[#0d141d] border-r border-[#1e2a38] text-[#c9d4e3]"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-[13px] font-semibold flex-1">{title}</span>
        <button
          id={ids?.newSession ?? 'sessionNew'}
          type="button"
          aria-label="New session"
          title="New session"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => onNewSession(null)}
        >
          <SquarePen size={13} />
        </button>
        <button
          id="workspaceAdd"
          type="button"
          aria-label="Add workspace"
          title="Add workspace"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={onAdd}
        >
          <FolderPlus size={13} />
        </button>
        <button
          id={ids?.refresh ?? 'workspaceRefresh'}
          type="button"
          aria-label="Refresh sessions"
          title="Refresh"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={onRefresh}
        >
          <RefreshCw size={13} />
        </button>
        <button
          id="sessionsMenu"
          type="button"
          aria-label="Sessions options"
          title="More"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={(e) => void onHeaderMenu(e.clientX, e.clientY)}
        >
          <Ellipsis size={13} />
        </button>
      </div>
      <div
        id={ids?.status ?? 'localStatus'}
        {...(statusAttrs ?? {})}
        data-sidebar-status
        className="px-3 pb-1.5 text-[11px] text-[#8b9bb0] truncate"
        title={statusTitle}
      >
        {statusText}
      </div>
      {statusExtra}
      {error && (
        <div id="sessionsError" className="px-3 pb-1.5 text-[11px] text-[#e0a03c] truncate">
          {error}
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
        {!q && extraSections}
        {q ? (
          filtered.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-[#5c6b80]">No matches</div>
          ) : (
            filtered.map((s) =>
              renderFlatRow ? (
                renderFlatRow(s)
              ) : (
                <SessionRowButton
                  key={s.id}
                  s={s}
                  depth={0}
                  current={s.id === currentSessionId}
                  registerRow={registerRow}
                  opts={rowOpts}
                  onMenu={(id, x, y) => void onSessionMenu(id, x, y)}
                />
              )
            )
          )
        ) : data.entries.length === 0 && data.listData.sessions.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-[#5c6b80]">
            {emptyText ?? 'Add a workspace folder to start.'}
            <div className="pt-2">
              <button
                id="workspaceAddEmpty"
                type="button"
                className="rounded border border-[#2c3949] px-2 py-1 text-[11px] text-[#8b9bb0] hover:text-[#c9d4e3] hover:bg-[#1a2735]"
                onClick={onAdd}
              >
                Add workspace
              </button>
            </div>
          </div>
        ) : (
          tree.sections.map((sectionItem) => {
            const entry = entryByPath.get(sectionItem.name);
            const label = entry?.label ?? sectionItem.name;
            return (
              <div key={`${sectionItem.kind}:${sectionItem.name}`} className="mb-px">
                <SectionHeader
                  section={sectionItem}
                  userFolderNames={userFolderNames}
                  renaming={renaming === sectionItem.name}
                  onRenameCommit={(name) => {
                    renameTo(sectionItem.name, name);
                    setRenaming(null);
                  }}
                  onRenameCancel={() => setRenaming(null)}
                  onToggle={(name) => {
                    onToggle(name);
                    if (sectionItem.kind === 'folder') onSectionHeaderClick?.(name);
                  }}
                  onMenu={(name, x, y) => void workspaceMenu(name, x, y)}
                  onMove={() => undefined}
                  onReorder={reorderTo}
                  {...(sectionItem.kind === 'folder'
                    ? {
                        onNewInFolder: onNewSession,
                        label,
                        title: workspaceLabel(sectionItem.name),
                        leading: headerLeading?.(sectionItem.name),
                        ...(headerAttrs ? { dataAttrs: headerAttrs(sectionItem.name) } : {}),
                      }
                    : {})}
                  moveDisabled
                />
                {!sectionItem.collapsed &&
                  (sectionItem.nodes.length === 0 ? (
                    <div className="pl-6 py-1 text-[11px] text-[#5c6b80]">No sessions</div>
                  ) : (
                    sectionItem.nodes.map((node) =>
                      renderRow ? (
                        renderRow(node)
                      ) : (
                        <SessionRow
                          key={node.session.id}
                          node={node}
                          collapsedChildren={emptyChildren}
                          onToggleChildren={() => undefined}
                          registerRow={registerRow}
                          opts={rowOpts}
                          onMenu={(id, x, y) => void onSessionMenu(id, x, y)}
                        />
                      ),
                    )
                  ))}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

const emptyChildren = new Set<string>();
