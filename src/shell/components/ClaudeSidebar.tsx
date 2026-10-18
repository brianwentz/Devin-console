import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Ellipsis, FolderPlus, Plus, RefreshCw } from 'lucide-react';
import type { ClaudeAgent, ClaudeSessionState } from '../../shared/ipc';
import {
  addFolder,
  buildSessionTree,
  moveSession,
  renameFolder,
  reorderFolders,
  type SidebarListData,
} from '../../core/sessionTree';
import type { Rect } from '../../core/layout';
import { useShellState } from '../store';
import { requestTerminal } from '../claude/viewRequests';
import { relativeTime } from './relativeTime';
import { sessionFolderHeaderClass, sessionMetaClass, sessionRowClass } from './sessionRowStyles';
import { FolderNameInput } from './sidebar/FolderNameInput';
import { SessionRow, SessionRowButton } from './sidebar/SessionRow';
import { SectionHeader } from './sidebar/SectionHeader';
import { isEditableFolder } from './sidebar/dnd';
import { useOptimisticList } from './sidebar/useOptimisticList';
import { useRowKeyboardNav } from './sidebar/useRowKeyboardNav';

const OP_LABELS: Record<string, string> = {
  'folder-create': 'create folder',
  'folder-rename': 'rename folder',
  'folder-delete': 'delete folder',
  'folder-reorder': 'reorder folders',
  'session-move': 'move session',
  'session-archive': 'archive session',
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

type ClaudeListData = SidebarListData<ClaudeSessionState>;

// Inline session-title editor (#sessionRenameEdit) opened by the session
// context menu's "Rename…" (action 'rename-session').
function RenameSessionInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      id="sessionRenameEdit"
      type="text"
      autoFocus
      defaultValue={initial}
      className="w-full h-6 px-1.5 rounded bg-[#141d29] border border-[#54749c] text-xs placeholder-[#5c6b80] focus:outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const title = e.currentTarget.value.trim();
          if (title) onCommit(title);
        } else if (e.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}

export function ClaudeSidebar({ rect }: { rect: Rect }) {
  const state = useShellState();
  const claude = state!.claude;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<
    | { kind: 'create'; pendingSessionId?: string }
    | { kind: 'rename'; name: string }
    | { kind: 'renameSession'; sessionId: string }
    | null
  >(null);
  const { registerRow, onKeyDown } = useRowKeyboardNav((id) =>
    window.devinworkspaces.clipboardWriteText(id),
  );
  const collapsedFolders = state!.settings.claude.collapsedFolders;

  const claudeData = useMemo<ClaudeListData>(
    () => ({
      sessions: claude.sessions,
      folders: claude.folders,
      folderTotals: {},
    }),
    [claude.sessions, claude.folders],
  );
  // Same optimistic pattern as the Cloud sidebar: edits hold until the next
  // claude state update or a lastError lands.
  const { data, applyOptimistic } = useOptimisticList(claudeData, [
    claude.lastSyncAt,
    claude.lastError,
  ]);
  const userFolderNames = useMemo(
    () => data.folders.filter(isEditableFolder),
    [data.folders],
  );

  const createFolder = (name: string, pendingSessionId?: string) => {
    applyOptimistic((d) => {
      const next = addFolder(d, name);
      return pendingSessionId ? moveSession(next, pendingSessionId, name) : next;
    });
    window.devinworkspaces.claudeFolderCreate(name);
    if (pendingSessionId) window.devinworkspaces.claudeSessionMove(pendingSessionId, name);
  };
  const renameFolderTo = (oldName: string, newName: string) => {
    applyOptimistic((d) => renameFolder(d, oldName, newName));
    window.devinworkspaces.claudeFolderRename(oldName, newName);
  };
  const moveSessionTo = (id: string, folder: string | null) => {
    applyOptimistic((d) => moveSession(d, id, folder));
    window.devinworkspaces.claudeSessionMove(id, folder);
  };
  const reorderTo = (names: string[]) => {
    applyOptimistic((d) => reorderFolders(d, names));
    window.devinworkspaces.claudeFolderReorder(names);
  };

  // Terminal for a session (optionally attaching a background agent): select
  // it, then ask ClaudeView to switch to its Terminal tab.
  const openTerminal = (sessionId: string, agentId?: string) => {
    window.devinworkspaces.claudeOpen(sessionId);
    requestTerminal(sessionId, agentId);
  };
  // Orphan agents have no session row to select; attach in the dock instead.
  const attachInDock = (agentId: string) => {
    if (!state!.terminalOpen) window.devinworkspaces.terminalToggle();
    void window.devinworkspaces.terminalOpen({ kind: 'shell', command: ['claude', 'attach', agentId] });
  };
  const attachAgent = (agent: ClaudeAgent) => {
    if (agent.sessionId) openTerminal(agent.sessionId, agent.id);
    else attachInDock(agent.id);
  };

  const sessionMenu = async (sessionId: string, x: number, y: number) => {
    const result = await window.devinworkspaces.claudeContextMenu({
      kind: 'session',
      sessionId,
      x,
      y,
    });
    const { action } = result;
    if (action === 'new-folder') setEditing({ kind: 'create', pendingSessionId: sessionId });
    else if (action === 'rename-session') setEditing({ kind: 'renameSession', sessionId });
    else if (action === 'open-terminal') openTerminal(sessionId);
    else if (action === 'attach-agent') {
      const agentId =
        result.agentId ?? claude.agents.find((a) => a.sessionId === sessionId)?.id;
      openTerminal(sessionId, agentId);
    }
  };
  const agentMenu = async (agent: ClaudeAgent, x: number, y: number) => {
    const { action } = await window.devinworkspaces.claudeContextMenu({
      kind: 'agent',
      agentId: agent.id,
      x,
      y,
    });
    if (action === 'attach-agent') attachAgent(agent);
    window.devinworkspaces.claudeAgentsRefresh();
  };
  const folderMenu = async (name: string, x: number, y: number) => {
    const { action } = await window.devinworkspaces.claudeContextMenu({
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
        currentSessionId: state!.claudeSessionId,
      }),
    [data, collapsedFolders, state!.claudeSessionId],
  );

  const toggleFolder = (name: string) => {
    const next = collapsedFolders.includes(name)
      ? collapsedFolders.filter((f) => f !== name)
      : [...collapsedFolders, name];
    void window.devinworkspaces.setSettings({ claude: { collapsedFolders: next } });
  };

  const collapsedChildren = useMemo(() => new Set<string>(), []);

  const rowOpts = {
    attrs: (s: ClaudeSessionState) => ({
      'data-missing': s.missing,
      'data-pinned': s.isPinned,
      'data-cwd': s.cwd ?? '',
      'data-archived': s.isArchived,
      'data-agent-status': s.agentStatus ?? undefined,
      'data-activity': s.activity ?? undefined,
    }),
    // Hook/chat activity dot (blue running / amber waiting), mirroring the
    // Cloud sidebar's status dot in the leading slot. Hidden when idle.
    leading: (s: ClaudeSessionState) =>
      s.activity ? (
        <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center">
          <span
            className={`activity-dot w-2 h-2 rounded-full ${
              s.activity === 'running' ? 'bg-[#83b6ff]' : 'bg-[#e0a03c]'
            }`}
            title={s.activity === 'running' ? 'Running' : 'Waiting for permission'}
          />
        </span>
      ) : null,
    badges: (s: ClaudeSessionState) => (
      <>
        {s.agentStatus === 'running' && (
          <span
            className="agent-dot shrink-0 w-2 h-2 rounded-full bg-[#8fd18f]"
            title="Background agent running"
          />
        )}
        {s.tag && (
          <span
            className="shrink-0 px-1 rounded bg-[#243447] text-[10px] leading-[14px] text-[#9fc4ea]"
            title={s.tag}
          >
            {s.tag}
          </span>
        )}
      </>
    ),
    meta: (s: ClaudeSessionState) => (
      <>
        {s.cwd ? basename(s.cwd) : ''}
        {s.cwd && s.gitBranch ? ' · ' : ''}
        {s.gitBranch ?? ''}
        {(s.cwd || s.gitBranch) && s.updatedAt ? ' · ' : ''}
        {s.updatedAt ? relativeTime(s.updatedAt, Date.now()) : ''}
      </>
    ),
    title: (s: ClaudeSessionState) => s.title || 'Untitled session',
    titleClass: (s: ClaudeSessionState) => (s.missing ? 'italic text-[#8b9bb0]' : undefined),
    rowClass: (s: ClaudeSessionState, variant: 'tree' | 'flat') =>
      variant === 'tree'
        ? `session-row ${s.isArchived ? 'opacity-50' : ''} flex-1 min-w-0 flex items-center ${sessionRowClass} text-left text-[#c9d4e3] hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[current=true]:bg-[#1f2f42]`
        : `${s.isArchived ? 'opacity-50 ' : ''}w-full flex items-center ${sessionRowClass} text-left hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none`,
    onOpen: (id: string) => window.devinworkspaces.claudeOpen(id),
  };

  const statusText = () => {
    switch (claude.status) {
      case 'ready': {
        const rel = claude.lastSyncAt
          ? relativeTime(Date.parse(claude.lastSyncAt), Date.now())
          : null;
        return `ready · ${data.sessions.length} sessions · synced ${rel ?? 'just now'}${rel === 'just now' ? '' : ' ago'}`;
      }
      case 'loading':
        return 'Loading…';
      case 'error':
        return claude.error ?? 'Error';
    }
  };

  // Agents whose session has no visible row (or none at all) get their own
  // section; mapped agents show as a dot on the session row instead.
  const orphanAgents = useMemo(() => {
    const visible = new Set(data.sessions.map((s) => s.id));
    return claude.agents.filter((a) => !a.sessionId || !visible.has(a.sessionId));
  }, [claude.agents, data.sessions]);
  const [agentsCollapsed, setAgentsCollapsed] = useState(false);

  const q = query.trim().toLowerCase();
  const filtered: ClaudeSessionState[] = q
    ? data.sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q),
      )
    : [];

  return (
    <section
      id="sessionsPanel"
      data-sidebar="claude"
      className="shell-chrome absolute flex flex-col bg-[#0d141d] border-r border-[#1e2a38] text-[#c9d4e3]"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-[13px] font-semibold flex-1">Claude</span>
        <button
          id="claudeNewSession"
          type="button"
          aria-label="New session"
          title="New session"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => void window.devinworkspaces.claudeNewSession(null)}
        >
          <Plus size={13} />
        </button>
        <button
          id="sessionFolderNew"
          type="button"
          aria-label="New folder"
          title="New folder"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => setEditing({ kind: 'create' })}
        >
          <FolderPlus size={13} />
        </button>
        <button
          id="claudeRefresh"
          type="button"
          aria-label="Refresh sessions"
          title="Refresh"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={() => window.devinworkspaces.claudeRefresh()}
        >
          <RefreshCw size={13} className={claude.status === 'loading' ? 'animate-spin' : ''} />
        </button>
        <button
          id="sessionsMenu"
          type="button"
          aria-label="Sessions options"
          title="More"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#1a2735] text-[#8b9bb0] hover:text-[#c9d4e3]"
          onClick={(e) =>
            void window.devinworkspaces.claudeContextMenu({
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
        id="claudeStatus"
        data-claude-status={claude.status}
        className="px-3 pb-1.5 text-[11px] text-[#8b9bb0] truncate"
        title={claude.status === 'error' ? (claude.error ?? '') : undefined}
      >
        {statusText()}
      </div>
      {claude.cliPath === null && (
        <div className="px-3 pb-1.5 text-[11px] text-[#e0a03c] truncate" title={claude.installGuidance}>
          Claude Code CLI not found — set the path in Settings
        </div>
      )}
      {claude.lastError && (
        <div
          id="sessionsError"
          className="px-3 pb-1.5 text-[11px] text-[#e0a03c] truncate"
        >
          Couldn't {OP_LABELS[claude.lastError.op] ?? claude.lastError.op} ·{' '}
          {claude.lastError.message}
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
        {!q && orphanAgents.length > 0 && (
          <section data-section-kind="agents" className="mb-px">
            <button
              type="button"
              data-section-name="agents"
              aria-expanded={!agentsCollapsed}
              className={`w-full flex items-center gap-1 px-1 py-1 ${sessionFolderHeaderClass} text-[#8b9bb0] hover:text-[#c9d4e3]`}
              onClick={() => setAgentsCollapsed((v) => !v)}
            >
              {agentsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span className="flex-1 text-left truncate">Background agents</span>
              <span className="text-[11px] leading-[14px] text-[#5c6b80]">{orphanAgents.length}</span>
            </button>
            {!agentsCollapsed &&
              orphanAgents.map((agent) => (
                <div
                  key={agent.id}
                  data-agent-id={agent.id}
                  data-agent-status={agent.status}
                  title={agent.cwd ?? undefined}
                  className={`ml-4 flex items-center ${sessionRowClass} text-left text-[#c9d4e3] hover:bg-[#1a2735]`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    void agentMenu(agent, e.clientX, e.clientY);
                  }}
                >
                  <span
                    className={`agent-dot shrink-0 w-2 h-2 rounded-full ${
                      agent.status === 'running' ? 'bg-[#8fd18f]' : 'bg-[#39475a]'
                    }`}
                  />
                  <span className="flex-1 min-w-0 truncate">{agent.name ?? agent.id}</span>
                  <span className={`shrink-0 ${sessionMetaClass}`}>
                    {agent.status}
                    {agent.cwd ? ` · ${basename(agent.cwd)}` : ''}
                  </span>
                </div>
              ))}
          </section>
        )}
        {q ? (
          filtered.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-[#5c6b80]">No matches</div>
          ) : (
            filtered.map((s) =>
              editing?.kind === 'renameSession' && editing.sessionId === s.id ? (
                <div key={s.id} className="px-1 py-0.5">
                  <RenameSessionInput
                    initial={s.title}
                    onCommit={(title) => {
                      window.devinworkspaces.claudeRename(s.id, title);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <SessionRowButton
                  key={s.id}
                  s={s}
                  depth={0}
                  current={s.id === state!.claudeSessionId}
                  registerRow={registerRow}
                  opts={rowOpts}
                  onMenu={(id, x, y) => void sessionMenu(id, x, y)}
                />
              ),
            )
          )
        ) : tree.sections.length === 0 && claude.status === 'ready' ? (
          <div className="px-2 py-3 text-[12px] text-[#5c6b80]">
            No Claude Code sessions found in {claude.configDir}
          </div>
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
                onMenu={(name, x, y) => void folderMenu(name, x, y)}
                onMove={moveSessionTo}
                onReorder={reorderTo}
              />
              {!sectionItem.collapsed && (
                <>
                  {sectionItem.nodes.length === 0 ? (
                    <div className="pl-6 py-1 text-[11px] text-[#5c6b80]">No sessions</div>
                  ) : (
                    sectionItem.nodes.map((node) =>
                      editing?.kind === 'renameSession' &&
                      editing.sessionId === node.session.id ? (
                        <div key={node.session.id} className="px-1 py-0.5">
                          <RenameSessionInput
                            initial={node.session.title}
                            onCommit={(title) => {
                              window.devinworkspaces.claudeRename(node.session.id, title);
                              setEditing(null);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </div>
                      ) : (
                        <SessionRow
                          key={node.session.id}
                          node={node}
                          collapsedChildren={collapsedChildren}
                          onToggleChildren={() => undefined}
                          registerRow={registerRow}
                          opts={rowOpts}
                          onMenu={(id, x, y) => void sessionMenu(id, x, y)}
                        />
                      ),
                    )
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
