import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Trash2 } from 'lucide-react';
import type { LocalStatePublic } from '../../shared/ipc';
import { AgentBadge, buttonClass } from './Cards';
import { TerminalView } from '../chat/TerminalView';
import { ChatView } from '../chat/ChatView';
import { UsagePill } from '../chat/UsagePill';
import { useShellState } from '../store';
import { useLocalState } from './store';
import { sessionTitleClass } from '../components/sessionRowStyles';
import { clearDraft } from '../chat/drafts';

type Session = LocalStatePublic['sessions'][string];

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sessionsOf(state: LocalStatePublic, workspace: string | null): Session[] {
  if (!workspace) return [];
  return Object.values(state.sessions)
    .filter((session) => session.workspace === workspace)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export function LocalPanel({ style }: { style: CSSProperties }) {
  const local = useLocalState();
  const shell = useShellState();
  const [workspace, setWorkspace] = useState<string | null>(null);
  // App only renders surfaces once shell state exists, so the initializer sees
  // the selection the main process kept across the last surface switch.
  const [sessionId, setSessionId] = useState<string | null>(
    () => shell?.localSessionId ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  // Lazily open one devin pty per session, only once the Terminal tab is
  // opened; every session's view stays mounted (display:none) so scrollback
  // survives session switches.
  const [terminalActive, setTerminalActive] = useState(false);
  const [terminalIds, setTerminalIds] = useState<Record<string, string>>({});
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const listedFor = useRef<Set<string>>(new Set());

  const workspaces = useMemo(() => Object.keys(local?.agents ?? {}).sort(), [local]);

  // Pick a default workspace, and auto-list its sessions once. On remount
  // (surface switch), restore the selection the main process kept for us.
  useEffect(() => {
    if (!local) return;
    if (!workspace || !local.agents[workspace]) {
      const remembered = shell?.localSessionId ? local.sessions[shell.localSessionId] : undefined;
      setWorkspace(remembered ? remembered.workspace : (workspaces[0] ?? null));
      setSessionId(remembered ? remembered.id : null);
    }
  }, [local, workspace, workspaces, shell?.localSessionId]);

  // Keep main's selection in sync — it drives the GitHub tab scope and
  // survives surface switches (this panel unmounts when leaving Local).
  useEffect(() => {
    window.devinworkspaces.localActiveSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    setConfirmDeleteAll(false);
  }, [workspace]);

  useEffect(() => {
    if (!confirmDeleteAll) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmDeleteAll(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDeleteAll]);

  useEffect(() => {
    if (!workspace || listedFor.current.has(workspace)) return;
    listedFor.current.add(workspace);
    void window.devinworkspaces.localListSessions(workspace).then((result) => {
      if (!result.ok) setError(result.error);
    });
  }, [workspace]);

  const sessions = local ? sessionsOf(local, workspace) : [];
  const session = sessionId && local ? (local.sessions[sessionId] ?? null) : null;
  const agent = workspace && local ? local.agents[workspace] : undefined;

  // Open (or reuse) the selected session's devin pty when the Terminal tab is shown.
  useEffect(() => {
    if (!terminalActive || !session || terminalIds[session.id]) return;
    const targetSessionId = session.id;
    const targetWorkspace = session.workspace;
    let cancelled = false;
    void window.devinworkspaces
      .terminalOpen({ kind: 'devin', workspace: targetWorkspace, sessionId: targetSessionId })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setTerminalIds((map) =>
            map[targetSessionId] ? map : { ...map, [targetSessionId]: result.id },
          );
          setTerminalError(null);
        } else {
          setTerminalError(result.error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [terminalActive, session, terminalIds]);

  useEffect(() => {
    setTerminalError(null);
  }, [session?.id]);

  const run = async <T,>(
    action: Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  ): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await action;
      if (!result.ok) {
        setError(result.error);
        return undefined;
      }
      setError(null);
      return result.value;
    } finally {
      setBusy(false);
    }
  };

  const addWorkspace = async () => {
    const picked = await run(window.devinworkspaces.localPickWorkspace());
    if (picked) {
      setWorkspace(picked);
      setSessionId(null);
    }
  };

  const removeWorkspace = async (path: string) => {
    await run(window.devinworkspaces.localRemoveWorkspace(path));
    listedFor.current.delete(path);
    if (workspace === path) {
      setWorkspace(null);
      setSessionId(null);
    }
  };

  const newSession = async () => {
    if (!workspace) return;
    const id = await run(window.devinworkspaces.localNewSession(workspace));
    if (id) setSessionId(id);
  };

  const deleteSession = async (id: string) => {
    const result = await run(window.devinworkspaces.localSessionDelete(id));
    if (result !== undefined) {
      // The pty itself was closed in main (terminalHost.closeForSession).
      setTerminalIds((map) => {
        if (!map[id]) return map;
        const next = { ...map };
        delete next[id];
        return next;
      });
      if (sessionId === id) setSessionId(null);
      clearDraft(id);
    }
  };

  const deleteAllSessions = async () => {
    if (!workspace) return;
    setConfirmDeleteAll(false);
    const ids = sessions.map((item) => item.id);
    await run(window.devinworkspaces.localSessionDeleteAll(workspace));
    // On partial failure `run` surfaces the error, but succeeded sessions are
    // already gone from local state — prune ids that no longer exist.
    const remaining = await window.devinworkspaces.getLocalState();
    const gone = new Set(ids.filter((id) => !(id in remaining.sessions)));
    if (gone.size > 0) {
      setTerminalIds((map) => {
        const next = { ...map };
        for (const id of gone) delete next[id];
        return next;
      });
      for (const id of gone) clearDraft(id);
      if (sessionId && gone.has(sessionId)) setSessionId(null);
    }
  };

  const openSession = async (target: Session) => {
    setSessionId(target.id);
    setError(null);
    if (!target.loaded && workspace) {
      const result = await window.devinworkspaces.localLoadSession(workspace, target.id);
      if (!result.ok) setError(result.error);
    }
  };

  const send = (text: string) => {
    if (!session) return;
    setError(null);
    void window.devinworkspaces.localPrompt(session.id, text).then((result) => {
      if (!result.ok) setError(result.error);
    });
  };

  const cancel = () => {
    if (session) void window.devinworkspaces.localCancel(session.id);
  };

  return (
    <main id="localPanel" className="shell-chrome relative flex bg-[#111925] text-[#e8edf5]" style={style}>
      {/* Left column: workspaces + sessions */}
      <aside className="flex w-64 flex-none flex-col border-r border-[#39475a] bg-[#101722]">
        <div className="flex items-center justify-between border-b border-[#39475a] px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-[#7f8ca0]">Workspaces</span>
          <button id="wsAdd" type="button" className={buttonClass} onClick={() => void addWorkspace()} disabled={busy}>
            + Add
          </button>
        </div>
        <ul id="wsList" className="m-0 flex list-none flex-col p-0">
          {workspaces.length === 0 && (
            <li className="px-3 py-2 text-xs text-[#7f8ca0]">No workspaces yet — add a folder to start.</li>
          )}
          {workspaces.map((path) => {
            const status = local?.agents[path]?.status ?? 'stopped';
            return (
              <li
                key={path}
                className={`ws-item flex items-center gap-2 px-3 py-1.5 text-xs ${
                  path === workspace ? 'bg-[#27364a]' : 'hover:bg-[#18212e]'
                }`}
                data-workspace={path}
                data-status={status}
              >
                <button
                  type="button"
                  className="ws-select flex-1 truncate text-left"
                  title={path}
                  onClick={() => {
                    setWorkspace(path);
                    setSessionId(null);
                  }}
                >
                  <span
                    className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                      status === 'ready'
                        ? 'bg-[#8fd18f]'
                        : status === 'starting'
                          ? 'bg-[#83b6ff]'
                          : status === 'crashed' || status === 'missing-cli'
                            ? 'bg-[#ff8a8a]'
                            : 'bg-[#39475a]'
                    }`}
                  />
                  {baseName(path)}
                </button>
                <button
                  type="button"
                  className="ws-remove closeMark"
                  title="Remove workspace"
                  aria-label={`Remove ${baseName(path)}`}
                  onClick={() => void removeWorkspace(path)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex items-center justify-between border-y border-[#39475a] px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-[#7f8ca0]">Sessions</span>
          <span className="flex items-center gap-1">
            {agent?.capabilities?.sessionDelete && sessions.length > 0 && (
              <button
                id="sessionDeleteAll"
                type="button"
                aria-label="Delete all sessions"
                title="Delete all sessions"
                className="rounded p-1 text-[#7f8ca0] hover:text-[#ff8a8a]"
                disabled={busy}
                onClick={() => setConfirmDeleteAll(true)}
              >
                <Trash2 size={13} />
              </button>
            )}
            <button
              id="sessionNew"
              type="button"
              className={buttonClass}
              disabled={!workspace || busy || !local?.cliPath}
              onClick={() => void newSession()}
            >
              New session
            </button>
          </span>
        </div>
        <ul id="sessionList" className="m-0 flex flex-1 list-none flex-col overflow-auto p-0">
          {sessions.map((item) => (
            <li key={item.id} className="group relative flex items-center">
              <button
                type="button"
                className={`session-item w-full px-3 py-1.5 text-left text-xs ${
                  item.id === sessionId ? 'bg-[#27364a]' : 'hover:bg-[#18212e]'
                }`}
                data-session-id={item.id}
                data-history-source={item.historySource}
                onClick={() => void openSession(item)}
              >
                <div className={`session-title flex items-center gap-1 truncate ${sessionTitleClass}`}>
                  {item.terminalOwned && (
                    <span className="session-terminal-marker text-[#83b6ff]" title="Open in Terminal">
                      &gt;_
                    </span>
                  )}
                  <span className="truncate">{item.title || 'Untitled session'}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] leading-[14px] text-[#7f8ca0]">
                  <span>{formatDate(item.createdAt)}</span>
                  {item.running && <span className="spinner" />}
                  {item.historySource === 'local-index' && (
                    <span className="history-label text-[#e0a03c]">history not supported by agent</span>
                  )}
                </div>
              </button>
              {agent?.capabilities?.sessionDelete && (
                <button
                  type="button"
                  className="session-delete absolute right-1 rounded p-1 text-[#7f8ca0] opacity-0 hover:text-[#ff8a8a] group-hover:opacity-100 disabled:hidden"
                  aria-label="Delete session"
                  data-session-id={item.id}
                  disabled={item.running}
                  onClick={() => void deleteSession(item.id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>

      {/* Right column: chat | terminal */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-[#39475a] px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{session?.title || (workspace ? baseName(workspace) : 'Devin Local')}</div>
            <div className="truncate font-mono text-[10px] text-[#7f8ca0]">{workspace ?? ''}</div>
          </div>
          <UsagePill usage={session?.usage} />
          <div id="localViewTabs" className="flex overflow-hidden rounded-md border border-[#39475a]">
            {(['chat', 'terminal'] as const).map((tab) => (
              <button
                key={tab}
                id={`view-${tab}`}
                type="button"
                className={`px-3 py-1 text-xs ${
                  view === tab ? 'bg-[#27364a] text-[#e8edf5]' : 'text-[#7f8ca0] hover:bg-[#18212e]'
                }`}
                disabled={tab === 'terminal' && !session}
                title={tab === 'terminal' && !session ? 'Select a session' : undefined}
                onClick={() => {
                  setView(tab);
                  if (tab === 'terminal') setTerminalActive(true);
                }}
              >
                {tab === 'chat' ? 'Chat' : 'Terminal'}
              </button>
            ))}
          </div>
          <AgentBadge agent={agent} installGuidance={local?.installGuidance ?? ''} />
        </header>
        <div
          id="terminalPane"
          className="flex min-h-0 flex-1 flex-col"
          style={{ display: view === 'terminal' ? 'flex' : 'none' }}
        >
          {terminalActive && workspace && (
            <>
              {Object.entries(terminalIds).map(([sid, id]) => (
                <div
                  key={sid}
                  data-session-terminal={sid}
                  className="flex min-h-0 flex-1 flex-col"
                  style={{ display: sid === session?.id ? 'flex' : 'none' }}
                >
                  <TerminalView
                    id={id}
                    active={view === 'terminal' && sid === session?.id}
                    onRestart={() => {
                      window.devinworkspaces.terminalClose(id);
                      setTerminalIds((map) => {
                        if (!map[sid]) return map;
                        const next = { ...map };
                        delete next[sid];
                        return next;
                      });
                    }}
                  />
                </div>
              ))}
              {terminalError && (
                <div className="border-b border-[#39475a] px-3 py-1.5 text-xs text-[#ff8a8a]">
                  {terminalError}
                </div>
              )}
            </>
          )}
        </div>
        <div
          id="chatPane"
          className="flex min-h-0 flex-1 flex-col"
          style={{ display: view === 'chat' ? 'flex' : 'none' }}
        >
          <ChatView
            session={session}
            draftKey={sessionId}
            emptyText={
              workspace
                ? 'Select a session or start a new one.'
                : 'Add a workspace folder, then start a session with the Devin CLI.'
            }
            composerPlaceholder="Message Devin…"
            disabledReason={session?.terminalOwned ? 'Close the terminal to chat here' : null}
            error={error}
            onSend={send}
            onCancel={cancel}
            onPermission={(requestId, optionId) => {
              if (session) void window.devinworkspaces.localPermission(session.id, requestId, optionId);
            }}
            footerHint={
              <>
                Enter sends · Shift+Enter newline · type <code>/handoff</code> to move this session to Devin Cloud
              </>
            }
            banner={
              session?.terminalOwned ? (
                <div
                  id="terminalOwnedBanner"
                  className="mb-2 flex items-center justify-between gap-2 rounded-md border border-[#39475a] bg-[#1a2330] px-2 py-1.5 text-xs text-[#aeb9c8]"
                >
                  <span>
                    This session is open in the Terminal tab — close the terminal to chat here.
                  </span>
                  <button
                    id="terminalOwnedClose"
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      const id = terminalIds[session.id];
                      if (id) void window.devinworkspaces.terminalClose(id);
                      else setView('terminal');
                    }}
                  >
                    Close terminal
                  </button>
                </div>
              ) : undefined
            }
          />
        </div>
      </section>
      {confirmDeleteAll && (
        <div
          id="sessionDeleteAllBackdrop"
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDeleteAll(false);
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
              This permanently deletes {sessions.length} session{sessions.length === 1 ? '' : 's'} in{' '}
              {baseName(workspace ?? '')}. Running prompts are cancelled first.
            </p>
            <div className="flex justify-end gap-2">
              <button
                id="sessionDeleteAllCancel"
                type="button"
                className={buttonClass}
                onClick={() => setConfirmDeleteAll(false)}
              >
                Cancel
              </button>
              <button
                id="sessionDeleteAllConfirm"
                type="button"
                autoFocus
                disabled={busy}
                className="rounded-md border border-[#7a3a3a] bg-[#3a1d1d] px-3 py-1.5 text-sm text-[#ff8a8a] hover:bg-[#4a2424] disabled:opacity-50"
                onClick={() => void deleteAllSessions()}
              >
                Delete {sessions.length}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
