import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ClaudeAgent, ClaudeSessionState, ClaudeSubagent } from '../../shared/ipc';
import type { SessionTreeNode } from '../../core/sessionTree';
import { relativeToWorkspace, workspaceEntries, workspaceListData } from '../../core/workspaceTree';
import type { HostId } from '../../core/execHost';
import type { Rect } from '../../core/layout';
import { useShellState } from '../store';
import { requestTerminal } from '../claude/viewRequests';
import { relativeTime } from './relativeTime';
import { sessionFolderHeaderClass, sessionMetaClass, sessionRowClass } from './sessionRowStyles';
import { SessionRowButton, type RowRenderOpts } from './sidebar/SessionRow';
import { WorkspaceSidebar } from './sidebar/WorkspaceSidebar';
import { hostIdForWorkspace } from './sidebar/hostMatch';

const OP_LABELS: Record<string, string> = {
  'workspace-reorder': 'reorder workspaces',
  'workspace-rename': 'rename workspace',
  'session-archive': 'archive session',
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// Reserved `claude.collapsedFolders` entry for the Background-agents section
// (never a real workspace: it is not in `claude.workspaces`, so the tree never
// sees it).
const AGENTS_FOLDER = '__agents__';

const hostChip = (host: string) => (
  <span
    data-host-chip
    className="shrink-0 px-1 rounded bg-[#243447] text-[10px] leading-[14px] text-[#9fc4ea]"
    title={`Runs on ${host}`}
  >
    {host.replace(/^(wsl|ssh):/, '')}
  </span>
);

// Subagent transcripts nested under a session row (read-only in the chat column).
function SubagentRows({
  session,
  depth,
  selectedId,
  onOpen,
}: {
  session: ClaudeSessionState;
  depth: number;
  selectedId: string | null;
  onOpen: (agentId: string) => void;
}) {
  const list: ClaudeSubagent[] | null = session.subagents;
  if (list === null) {
    return (
      <div className="py-1 text-[11px] text-[#5c6b80]" style={{ paddingLeft: (depth + 1) * 12 + 16 }}>
        Loading subagents…
      </div>
    );
  }
  return (
    <>
      {list.map((sub) => {
        const selected = selectedId === sub.agentId;
        return (
          <div
            key={sub.agentId}
            role="button"
            tabIndex={-1}
            data-subagent-id={sub.agentId}
            data-parent-session-id={session.id}
            data-current={selected}
            title={sub.title}
            className={`flex items-center ${sessionRowClass} text-left text-[#aeb9c8] hover:bg-[#1a2735] cursor-pointer ${
              selected ? 'bg-[#1f2f42] text-[#e8edf5]' : ''
            }`}
            style={{ marginLeft: (depth + 1) * 12 + 16 }}
            onClick={() => onOpen(sub.agentId)}
          >
            <span className="flex-1 min-w-0 truncate">{sub.title || sub.agentId}</span>
            {sub.messageCount !== null && (
              <span className={`shrink-0 ${sessionMetaClass}`}>{sub.messageCount}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

// Same layout as the shared SessionRow (chevron slot + tree-variant button),
// but the chevron expands the session's subagents instead of tree children:
// shown while the list is unknown (null) or non-empty, default collapsed.
function ClaudeSessionRow(props: {
  node: SessionTreeNode<ClaudeSessionState>;
  expandedSubagents: Set<string>;
  onToggleSubagents: (id: string) => void;
  selectedSubagentId: string | null;
  onOpenSubagent: (sessionId: string, agentId: string) => void;
  registerRow: (el: HTMLButtonElement | null) => void;
  opts: RowRenderOpts<ClaudeSessionState>;
  onMenu: (sessionId: string, x: number, y: number) => void;
}) {
  const { node, expandedSubagents, onToggleSubagents, selectedSubagentId, onOpenSubagent } = props;
  const { registerRow, opts, onMenu } = props;
  const s = node.session;
  const expanded = expandedSubagents.has(s.id);
  const hasSubagents = s.subagents === null || s.subagents.length > 0;
  return (
    <>
      <div className="flex items-center" style={{ paddingLeft: node.depth * 12 }}>
        {hasSubagents ? (
          <button
            type="button"
            tabIndex={-1}
            data-subagents-toggle
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse subagents' : 'Expand subagents'}
            className="w-4 h-4 shrink-0 flex items-center justify-center text-[#8b9bb0] hover:text-[#c9d4e3]"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSubagents(s.id);
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <SessionRowButton
          s={s}
          depth={node.depth}
          current={node.current}
          registerRow={registerRow}
          opts={opts}
          onMenu={onMenu}
          variant="tree"
        />
      </div>
      {expanded && hasSubagents && (
        <SubagentRows
          session={s}
          depth={node.depth}
          selectedId={node.current ? selectedSubagentId : null}
          onOpen={(agentId) => onOpenSubagent(s.id, agentId)}
        />
      )}
      {node.children.map((child) => (
        <ClaudeSessionRow key={child.session.id} {...props} node={child} />
      ))}
    </>
  );
}

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
  const hosts = state?.hosts ?? [];
  const multiHost = hosts.some((host) => host.kind !== 'local');
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const collapsedFolders = state!.settings.claude.collapsedFolders;
  const { workspaces, workspaceLabels } = state!.settings.claude;

  const entries = useMemo(() => workspaceEntries(workspaces, workspaceLabels), [workspaces, workspaceLabels]);
  // The session's folder is already derived (host+cwd match) in main — the
  // adapter only wraps rows into SidebarListData.
  const claudeData = useMemo(
    () => workspaceListData(entries, claude.sessions),
    [entries, claude.sessions],
  );

  // Terminal for a session (optionally attaching a background agent): select
  // it, then ask ClaudeView to switch to its Terminal tab.
  const openTerminal = (sessionId: string, agentId?: string) => {
    window.agentworkspace.claudeOpen(sessionId);
    requestTerminal(sessionId, agentId);
  };
  // Orphan agents have no session row to select; attach in the dock instead.
  const attachInDock = (agentId: string) => {
    if (!state!.terminalOpen) window.agentworkspace.terminalToggle();
    void window.agentworkspace.terminalOpen({ kind: 'shell', command: ['claude', 'attach', agentId] });
  };
  const attachAgent = (agent: ClaudeAgent) => {
    if (agent.sessionId) openTerminal(agent.sessionId, agent.id);
    else attachInDock(agent.id);
  };
  // "Open terminal here" on a workspace header: shell pty at the workspace cwd.
  const openTerminalAt = (path: string) => {
    if (!state!.terminalOpen) window.agentworkspace.terminalToggle();
    void window.agentworkspace.terminalOpen({ kind: 'shell', cwd: path });
  };

  const sessionMenu = async (sessionId: string, x: number, y: number) => {
    const result = await window.agentworkspace.claudeContextMenu({
      kind: 'session',
      sessionId,
      x,
      y,
    });
    const { action } = result;
    if (action === 'rename-session') setRenamingSession(sessionId);
    else if (action === 'open-terminal') openTerminal(sessionId);
    else if (action === 'attach-agent') {
      const agentId =
        result.agentId ?? claude.agents.find((a) => a.sessionId === sessionId)?.id;
      openTerminal(sessionId, agentId);
    }
    return action;
  };
  const agentMenu = async (agent: ClaudeAgent, x: number, y: number) => {
    const { action } = await window.agentworkspace.claudeContextMenu({
      kind: 'agent',
      agentId: agent.id,
      x,
      y,
    });
    if (action === 'attach-agent') attachAgent(agent);
    window.agentworkspace.claudeAgentsRefresh();
  };
  const workspaceMenu = async (path: string, x: number, y: number) => {
    const { action } = await window.agentworkspace.claudeContextMenu({
      kind: 'workspace',
      path,
      x,
      y,
    });
    if (action === 'open-terminal') openTerminalAt(path);
    return action;
  };
  const headerMenu = async (x: number, y: number) => {
    const { action } = await window.agentworkspace.claudeContextMenu({
      kind: 'header',
      x,
      y,
    });
    if (action === 'add') void window.agentworkspace.claudeWorkspaceAdd();
    else if (action === 'add-remote') void window.agentworkspace.claudeWorkspaceAdd(undefined, { remote: true });
    return action;
  };

  const toggleFolder = (name: string) => {
    const next = collapsedFolders.includes(name)
      ? collapsedFolders.filter((f) => f !== name)
      : [...collapsedFolders, name];
    void window.agentworkspace.setSettings({ claude: { collapsedFolders: next } });
  };

  // Subagent lists are fetched on first expand (main fills `subagents` on the row).
  const [expandedSubagents, setExpandedSubagents] = useState<Set<string>>(() => new Set());
  const toggleSubagents = (sessionId: string) => {
    const session = claude.sessions.find((s) => s.id === sessionId);
    const opening = !expandedSubagents.has(sessionId);
    setExpandedSubagents((prev) => {
      const next = new Set(prev);
      if (opening) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
    if (opening && session?.subagents === null) void window.agentworkspace.claudeSubagents(sessionId);
  };
  const openSubagent = (sessionId: string, agentId: string) =>
    void window.agentworkspace.claudeOpenSubagent(sessionId, agentId);

  const rowOpts: RowRenderOpts<ClaudeSessionState> = {
    attrs: (s) => ({
      'data-missing': s.missing,
      'data-pinned': s.isPinned,
      'data-cwd': s.cwd ?? '',
      'data-archived': s.isArchived,
      'data-agent-status': s.agentStatus ?? undefined,
      'data-activity': s.activity ?? undefined,
    }),
    // Hook/chat activity dot (blue running / amber waiting), mirroring the
    // Cloud sidebar's status dot in the leading slot. Hidden when idle.
    leading: (s) =>
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
    badges: (s) => (
      <>
        {s.agentStatus === 'running' && (
          <span
            className="agent-dot shrink-0 w-2 h-2 rounded-full bg-[#8fd18f]"
            title="Background agent running"
          />
        )}
        {multiHost && s.host && s.host !== 'local' && hostChip(s.host)}
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
    meta: (s) => {
      // Workspace rows show the sub-path below the workspace ('' on an exact
      // match); a null return means the shell can't re-derive the match
      // (e.g. the uncRoot test seam) — fall back to the basename.
      const cwdSeg =
        s.folder !== null && s.cwd
          ? (relativeToWorkspace(s.folder, { host: s.host as HostId, cwd: s.cwd }) ??
            basename(s.cwd))
          : s.cwd
            ? basename(s.cwd)
            : '';
      return (
        <>
          {cwdSeg}
          {cwdSeg && s.gitBranch ? ' · ' : ''}
          {s.gitBranch ?? ''}
          {(cwdSeg || s.gitBranch) && s.updatedAt ? ' · ' : ''}
          {s.updatedAt ? relativeTime(s.updatedAt, Date.now()) : ''}
        </>
      );
    },
    title: (s) => s.title || 'Untitled session',
    titleClass: (s) => (s.missing ? 'italic text-[#8b9bb0]' : undefined),
    rowClass: (s, variant: 'tree' | 'flat') =>
      variant === 'tree'
        ? `session-row ${s.isArchived ? 'opacity-50' : ''} flex-1 min-w-0 flex items-center ${sessionRowClass} text-left text-[#c9d4e3] hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[current=true]:bg-[#1f2f42]`
        : `${s.isArchived ? 'opacity-50 ' : ''}w-full flex items-center ${sessionRowClass} text-left hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none`,
    onOpen: (id) => window.agentworkspace.claudeOpen(id),
  };

  const statusText = () => {
    switch (claude.status) {
      case 'ready': {
        const rel = claude.lastSyncAt
          ? relativeTime(Date.parse(claude.lastSyncAt), Date.now())
          : null;
        return `ready · ${claude.sessions.length} sessions · synced ${rel ?? 'just now'}${rel === 'just now' ? '' : ' ago'}`;
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
    const visible = new Set(claude.sessions.map((s) => s.id));
    return claude.agents.filter((a) => !a.sessionId || !visible.has(a.sessionId));
  }, [claude.agents, claude.sessions]);
  // Persisted with the folder collapse state under the reserved `__agents__` name.
  const agentsCollapsed = collapsedFolders.includes(AGENTS_FOLDER);

  const statusExtra = (
    <>
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
    </>
  );

  const extraSections =
    orphanAgents.length > 0 ? (
      <section data-section-kind="agents" className="mb-px">
        <button
          type="button"
          data-section-name="agents"
          aria-expanded={!agentsCollapsed}
          className={`w-full flex items-center gap-1 px-1 py-1 ${sessionFolderHeaderClass} text-[#8b9bb0] hover:text-[#c9d4e3]`}
          onClick={() => toggleFolder(AGENTS_FOLDER)}
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
    ) : undefined;

  const renameEditor = (session: ClaudeSessionState, children: React.ReactNode) =>
    renamingSession === session.id ? (
      <div className="px-1 py-0.5">
        <RenameSessionInput
          initial={session.title}
          onCommit={(title) => {
            window.agentworkspace.claudeRename(session.id, title);
            setRenamingSession(null);
          }}
          onCancel={() => setRenamingSession(null)}
        />
      </div>
    ) : (
      children
    );

  return (
    <WorkspaceSidebar<ClaudeSessionState>
      rect={rect}
      dataSidebar="claude"
      title="Claude"
      ids={{ newSession: 'claudeNewSession', refresh: 'claudeRefresh', status: 'claudeStatus' }}
      statusAttrs={{ 'data-claude-status': claude.status }}
      statusText={statusText()}
      {...(claude.status === 'error' ? { statusTitle: claude.error ?? '' } : {})}
      statusExtra={statusExtra}
      entries={entries}
      listData={claudeData}
      sessionOrder={state!.settings.claude.sessionOrder}
      collapsed={collapsedFolders}
      currentSessionId={state!.claudeSessionId}
      rowOpts={rowOpts}
      filterTextOf={(s) => `${basename(s.cwd ?? '')} ${s.cwd ?? ''}`}
      headerLeading={(path) => {
        const id = hostIdForWorkspace(path, hosts);
        return id && id !== 'local' ? hostChip(id) : null;
      }}
      onToggle={toggleFolder}
      onReorder={(paths) => void window.agentworkspace.claudeWorkspaceReorder(paths)}
      onReorderSessions={(section, ids) =>
        void window.agentworkspace.claudeSessionReorder(section, ids)
      }
      onRename={(path, label) => void window.agentworkspace.claudeWorkspaceRename(path, label)}
      onNewSession={(path) => void window.agentworkspace.claudeNewSession(path)}
      onAdd={() => void window.agentworkspace.claudeWorkspaceAdd()}
      onRefresh={() => window.agentworkspace.claudeRefresh()}
      onWorkspaceMenu={workspaceMenu}
      onSessionMenu={sessionMenu}
      onHeaderMenu={headerMenu}
      onCopyId={(id) => window.agentworkspace.clipboardWriteText(id)}
      emptyText={`No Claude Code sessions found in ${claude.configDir}`}
      extraSections={extraSections}
      renderRow={(node) =>
        renameEditor(
          node.session,
          <ClaudeSessionRow
            key={node.session.id}
            node={node}
            expandedSubagents={expandedSubagents}
            onToggleSubagents={toggleSubagents}
            selectedSubagentId={claude.selectedSubagentId}
            onOpenSubagent={openSubagent}
            registerRow={(el) => void el /* keyboard nav handled by WorkspaceSidebar */}
            opts={rowOpts}
            onMenu={(id, x, y) => void sessionMenu(id, x, y)}
          />,
        )
      }
      renderFlatRow={(s) =>
        renameEditor(
          s,
          <SessionRowButton
            key={s.id}
            s={s}
            depth={0}
            current={s.id === state!.claudeSessionId}
            registerRow={() => undefined}
            opts={rowOpts}
            onMenu={(id, x, y) => void sessionMenu(id, x, y)}
          />,
        )
      }
    />
  );
}
