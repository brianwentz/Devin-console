import { useEffect, useState, type CSSProperties } from 'react';
import { AgentBadge } from './Cards';
import { TerminalView } from '../chat/TerminalView';
import { ChatView, sendShortcutLabel } from '../chat/ChatView';
import { UsagePill } from '../chat/UsagePill';
import { useShellState } from '../store';
import { consumeTerminalRequest, useLocalState, useSelectedWorkspace, useTerminalRequest } from './store';

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function LocalPanel({ style }: { style: CSSProperties }) {
  const local = useLocalState();
  const shell = useShellState();
  const transientWorkspace = useSelectedWorkspace();
  const sessionId = shell?.localSessionId ?? null;
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  // Lazily open one devin pty per session, only once the Terminal tab is
  // opened; every session's view stays mounted (display:none) so scrollback
  // survives session switches.
  const [terminalActive, setTerminalActive] = useState(false);
  const [terminalIds, setTerminalIds] = useState<Record<string, string>>({});
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const terminalRequest = useTerminalRequest();

  // Keep main's selection lifted — it drives the GitHub tab scope and survives
  // surface switches (this panel unmounts when leaving Local).
  useEffect(() => {
    window.agentworkspace.localActiveSession(sessionId);
  }, [sessionId]);

  const session = sessionId && local ? (local.sessions[sessionId] ?? null) : null;
  const workspace = session?.workspace ?? transientWorkspace ?? shell?.settings.workspaces[0] ?? null;
  const agent = workspace && local ? local.agents[workspace] : undefined;

  // Sidebar "Open terminal" → show the Terminal tab for the selected session.
  useEffect(() => {
    if (!terminalRequest) return;
    if (terminalRequest.sessionId === sessionId) {
      consumeTerminalRequest(terminalRequest.seq);
      setView('terminal');
      setTerminalActive(true);
    }
  }, [terminalRequest, sessionId]);

  // Open (or reuse) the selected session's devin pty when the Terminal tab is shown.
  useEffect(() => {
    if (!terminalActive || !session || terminalIds[session.id]) return;
    const targetSessionId = session.id;
    const targetWorkspace = session.workspace;
    let cancelled = false;
    void window.agentworkspace
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

  // Forget per-session terminal ids when the session disappears from state
  // (delete / delete-all / workspace removed).
  useEffect(() => {
    if (!local) return;
    setTerminalIds((map) => {
      const next = Object.fromEntries(
        Object.entries(map).filter(([id]) => id in local.sessions),
      );
      return Object.keys(next).length === Object.keys(map).length ? map : next;
    });
  }, [local]);

  const send = (text: string) => {
    if (!session) return;
    setError(null);
    void window.agentworkspace.localPrompt(session.id, text).then((result) => {
      if (!result.ok) setError(result.error);
    });
  };

  const cancel = () => {
    if (session) void window.agentworkspace.localCancel(session.id);
  };

  return (
    <main id="localPanel" className="shell-chrome relative flex bg-[#111925] text-[#e8edf5]" style={style}>
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
                      window.agentworkspace.terminalClose(id);
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
              if (session) void window.agentworkspace.localPermission(session.id, requestId, optionId);
            }}
            footerHint={
              <>
                {sendShortcutLabel()} sends · Enter newline · type <code>/handoff</code> to move this session to Devin Cloud
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
                    className="rounded border border-[#39475a] px-2 py-0.5 text-xs text-[#aeb9c8] hover:text-[#e8edf5]"
                    onClick={() => {
                      const id = terminalIds[session.id];
                      if (id) void window.agentworkspace.terminalClose(id);
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
    </main>
  );
}
