// Local adapter for WorkspaceSidebar (ux2 D9): Devin Local workspaces +
// sessions in the session column. Selection source of truth is main's
// localSessionId; the selected workspace is transient shell state.
import { useMemo, useState } from 'react';
import { sessionRowClass } from '../components/sessionRowStyles';
import type { LocalStatePublic } from '../../shared/ipc';
import type { SidebarListData, SidebarSession } from '../../core/sessionTree';
import { workspaceEntries, workspaceListData } from '../../core/workspaceTree';
import type { Rect } from '../../core/layout';
import { useShellState } from '../store';
import { WorkspaceSidebar } from '../components/sidebar/WorkspaceSidebar';
import { buttonClass } from './Cards';
import { clearDraft } from '../chat/drafts';
import { hostIdForPath } from '../../core/execHost';
import type { HostStatus } from '../../shared/ipc';
import {
  requestTerminal,
  selectWorkspace,
  useLocalState,
} from './store';

// Core UNC matching + the preload's test-root seam (mirrors main's pathHostId).
function hostIdForWorkspace(path: string, hosts: HostStatus[]): string | null {
  const id = hostIdForPath(path);
  if (id !== 'local') return id;
  const root = window.devinworkspaces.testWslUncRoot;
  if (root && path.startsWith(root)) {
    return hosts.find((h) => h.kind === 'wsl')?.id ?? 'wsl';
  }
  return null;
}

type LocalSession = LocalStatePublic['sessions'][string];
export type LocalSidebarSession = SidebarSession & { local: LocalSession };

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const AGENT_DOT: Record<string, string> = {
  ready: '#8fd18f',
  starting: '#83b6ff',
  crashed: '#ff8a8a',
  'missing-cli': '#ff8a8a',
};

function sessionsToSidebar(sessions: LocalSession[]): LocalSidebarSession[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title || 'Untitled session',
    folder: s.workspace,
    parentId: null,
    isPinned: false,
    isArchived: false,
    updatedAt: Date.parse(s.createdAt) || 0,
    prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 },
    local: s,
  }));
}

export function LocalSidebar({ rect }: { rect: Rect }) {
  const state = useShellState();
  const local = useLocalState();
  const [confirmDeleteAll, setConfirmDeleteAll] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settings = state!.settings;
  const workspaces = settings.workspaces;
  const labels = settings.local.workspaceLabels;
  const collapsed = settings.local.collapsedWorkspaces;

  const entries = useMemo(() => workspaceEntries(workspaces, labels), [workspaces, labels]);
  const workspacePaths = useMemo(() => new Set(workspaces), [workspaces]);
  const sessions = useMemo(
    () =>
      local
        ? Object.values(local.sessions).sort((a, b) =>
            a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
          )
        : [],
    [local],
  );
  const listData = useMemo<SidebarListData<LocalSidebarSession>>(
    () =>
      workspaceListData(
        entries,
        sessionsToSidebar(sessions).map((s) => ({
          ...s,
          folder: s.folder && workspacePaths.has(s.folder) ? s.folder : null,
        })),
      ),
    [entries, sessions, workspacePaths],
  );

  const selectedSessionId = state?.localSessionId ?? null;
  const selectedSession = selectedSessionId ? (local?.sessions[selectedSessionId] ?? null) : null;
  const selectedWorkspace = selectedSession?.workspace ?? null;

  const sessionsIn = (path: string) =>
    sessions.filter((s) => s.workspace === path);

  const toggleWorkspace = (path: string) => {
    const next = collapsed.includes(path)
      ? collapsed.filter((p) => p !== path)
      : [...collapsed, path];
    void window.devinworkspaces.setSettings({ local: { collapsedWorkspaces: next } });
  };

  const selectSession = async (id: string) => {
    setError(null);
    const session = local?.sessions[id];
    window.devinworkspaces.localActiveSession(id);
    if (session && !session.loaded) {
      const result = await window.devinworkspaces.localLoadSession(session.workspace, id);
      if (!result.ok) setError(result.error);
    }
  };

  const newSession = async (path: string | null) => {
    const workspace = path ?? selectedWorkspace ?? workspaces[0];
    if (!workspace) {
      await addWorkspace();
      return;
    }
    selectWorkspace(workspace);
    const result = await window.devinworkspaces.localNewSession(workspace);
    if (!result.ok) setError(result.error);
    else window.devinworkspaces.localActiveSession(result.value);
  };

  const addWorkspace = async () => {
    const picked = await window.devinworkspaces.localPickWorkspace();
    if (picked.ok && picked.value) selectWorkspace(picked.value);
    else if (!picked.ok) setError(picked.error);
  };

  const refreshAll = () => {
    for (const ws of workspaces) void window.devinworkspaces.localListSessions(ws);
  };

  const openTerminalHere = (path: string) => {
    if (!state!.terminalOpen) window.devinworkspaces.terminalToggle();
    void window.devinworkspaces.terminalOpen({ kind: 'shell', cwd: path });
  };

  const workspaceMenu = async (path: string, x: number, y: number) => {
    const { action } = await window.devinworkspaces.localContextMenu({
      kind: 'workspace',
      path,
      x,
      y,
    });
    selectWorkspace(path);
    if (action === 'open-terminal') openTerminalHere(path);
    else if (action === 'delete-all') setConfirmDeleteAll(path);
    return action;
  };

  const sessionMenu = async (id: string, x: number, y: number) => {
    const session = local?.sessions[id];
    const { action } = await window.devinworkspaces.localContextMenu({
      kind: 'session',
      sessionId: id,
      x,
      y,
    });
    if (action === 'open-terminal' && session) {
      void selectSession(id).then(() => requestTerminal(id));
    } else if (action === 'delete' && session) {
      void window.devinworkspaces.localSessionDelete(id).then((result) => {
        if (!result.ok) setError(result.error);
      });
    }
    return action;
  };

  const headerMenu = async (x: number, y: number) => {
    const { action } = await window.devinworkspaces.localContextMenu({ kind: 'header', x, y });
    if (action === 'add') await addWorkspace();
    return action;
  };

  const deleteAllSessions = async (path: string) => {
    const ids = sessionsIn(path).map((s) => s.id);
    setConfirmDeleteAll(null);
    const result = await window.devinworkspaces.localSessionDeleteAll(path);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const remaining = await window.devinworkspaces.getLocalState();
    const gone = new Set(ids.filter((id) => !(id in remaining.sessions)));
    for (const id of gone) clearDraft(id);
    if (selectedSessionId && gone.has(selectedSessionId)) {
      window.devinworkspaces.localActiveSession(null);
    }
  };

  const readyCount = workspaces.filter((w) => local?.agents[w]?.status === 'ready').length;
  const statusText = !local?.cliPath
    ? 'Devin CLI not found — sessions unavailable'
    : `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} · ${readyCount} ready`;

  const rowOpts = {
    attrs: (s: LocalSidebarSession) => ({
      'data-history-source': s.local.historySource,
      'data-running': s.local.running || undefined,
      'data-workspace': s.local.workspace,
    }),
    badges: (s: LocalSidebarSession) => (
      <>
        {s.local.terminalOwned && (
          <span className="session-terminal-marker text-[#83b6ff]" title="Open in Terminal">
            &gt;_
          </span>
        )}
        {s.local.running && <span className="spinner" />}
        {s.local.historySource === 'local-index' && (
          <span className="history-label text-[#e0a03c]">history not supported by agent</span>
        )}
      </>
    ),
    meta: (s: LocalSidebarSession) => (
      <span className="flex items-center gap-2">
        <span>{formatDate(s.local.createdAt)}</span>
      </span>
    ),
    rowClass: () =>
      `session-item flex-1 min-w-0 flex items-center ${sessionRowClass} text-left text-[#c9d4e3] hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none data-[current=true]:bg-[#27364a]`,
    onOpen: (id: string) => void selectSession(id),
  };

  const headerLeading = (path: string) => {
    const status = local?.agents[path]?.status;
    const color = status ? (AGENT_DOT[status] ?? '#39475a') : '#39475a';
    const hostId = hostIdForWorkspace(path, state?.hosts ?? []);
    return (
      <>
        <span
          className="mr-1 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          data-agent-status={status ?? 'stopped'}
        />
        {hostId && (
          <span
            data-host-chip
            className="mr-1 shrink-0 px-1 rounded bg-[#243447] text-[10px] leading-[14px] text-[#9fc4ea]"
            title={`Runs on ${hostId}`}
          >
            {hostId.replace(/^wsl:/, '')}
          </span>
        )}
      </>
    );
  };

  const confirmSessions = confirmDeleteAll ? sessionsIn(confirmDeleteAll) : [];

  return (
    <>
      <WorkspaceSidebar
        rect={rect}
        dataSidebar="local"
        title="Workspaces"
        statusText={statusText}
        {...(local?.cliPath ? {} : { statusTitle: local?.installGuidance ?? '' })}
        error={error}
        entries={entries}
        listData={listData}
        collapsed={collapsed}
        currentSessionId={selectedSessionId}
        rowOpts={rowOpts}
        headerLeading={headerLeading}
        headerAttrs={(path) => ({
          'data-workspace': path,
          'data-status': local?.agents[path]?.status ?? 'stopped',
        })}
        onToggle={toggleWorkspace}
        onReorder={(paths) => void window.devinworkspaces.localWorkspaceReorder(paths)}
        onRename={(path, label) => void window.devinworkspaces.localWorkspaceRename(path, label)}
        onNewSession={(path) => void newSession(path)}
        onAdd={() => void addWorkspace()}
        onRefresh={refreshAll}
        onWorkspaceMenu={workspaceMenu}
        onSessionMenu={sessionMenu}
        onHeaderMenu={headerMenu}
        onSectionHeaderClick={selectWorkspace}
        emptyText="Add a workspace folder, then start a session with the Devin CLI."
      />
      {confirmDeleteAll && (
        <div
          id="sessionDeleteAllBackdrop"
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDeleteAll(null);
          }}
        >
          <section
            id="sessionDeleteAllDialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sessionDeleteAllTitle"
            className="flex w-[360px] flex-col gap-3 rounded-lg border border-[#39475a] bg-[#101722] px-4 py-4 shadow-xl"
          >
            <h2 id="sessionDeleteAllTitle" className="m-0 text-sm font-semibold text-[#e8edf5]">
              Delete all sessions?
            </h2>
            <p className="m-0 text-xs text-[#7f8ca0]">
              This permanently deletes {confirmSessions.length} session
              {confirmSessions.length === 1 ? '' : 's'} in {baseName(confirmDeleteAll)}. Running
              prompts are cancelled first.
            </p>
            <div className="flex justify-end gap-2">
              <button
                id="sessionDeleteAllCancel"
                type="button"
                className={buttonClass}
                onClick={() => setConfirmDeleteAll(null)}
              >
                Cancel
              </button>
              <button
                id="sessionDeleteAllConfirm"
                type="button"
                autoFocus
                className="rounded-md border border-[#7a3a3a] bg-[#3a1d1d] px-3 py-1.5 text-sm text-[#ff8a8a] hover:bg-[#4a2424] disabled:opacity-50"
                onClick={() => void deleteAllSessions(confirmDeleteAll)}
              >
                Delete {confirmSessions.length}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
