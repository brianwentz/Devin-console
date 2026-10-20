import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeft, GitFork } from 'lucide-react';
import type { ClaudeChatSessionPublic, LocalResult } from '../../shared/ipc';
import { CLAUDE_PERMISSION_MODES, isClaudePermissionMode } from '../../core/settingsDraft';
import { ChatView, sendShortcutLabel } from '../chat/ChatView';
import { TerminalView } from '../chat/TerminalView';
import { UsagePill } from '../chat/UsagePill';
import { buttonClass } from '../chat/Cards';
import { useShellState } from '../store';
import { useClaudeChatState } from './store';
import {
  consumeTerminalRequest,
  getLastView,
  rememberView,
  useTerminalRequest,
  type ClaudeViewTab,
} from './viewRequests';

const liveColor: Record<ClaudeChatSessionPublic['live'], string> = {
  idle: 'bg-[#39475a]',
  starting: 'bg-[#83b6ff]',
  live: 'bg-[#8fd18f]',
  stopped: 'bg-[#e0a03c]',
};

const selectClass =
  'h-6 rounded border border-[#39475a] bg-[#1a2330] px-1.5 font-mono text-[11px] text-[#c9d4e3] focus:border-[#54749c] focus:outline-none';

// Model override input: commits on blur/Enter; blank clears to the CLI default.
function ModelInput({ value, onCommit }: { value: string | null; onCommit: (model: string | null) => void }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    const next = text.trim() || null;
    if (next !== value) onCommit(next);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setText(value ?? '');
      event.currentTarget.blur();
    }
  };
  return (
    <input
      id="claudeModel"
      type="text"
      className={`${selectClass} w-36`}
      placeholder="default model"
      title="Model override (blank = CLI default)"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

export function ClaudeView({ style }: { style: CSSProperties }) {
  const state = useShellState();
  const chat = useClaudeChatState();
  const claude = state!.claude;
  const id = state!.claudeSessionId;
  const meta = id ? (claude.sessions.find((s) => s.id === id) ?? null) : null;
  const session = id ? (chat?.sessions[id] ?? null) : null;
  // Read-only subagent transcript selected from the sidebar (parent = `id`).
  const subagentId = claude.selectedSubagentId;
  const subagentSession =
    id && subagentId ? (chat?.subagentSessions[`${id}/${subagentId}`] ?? null) : null;
  const [error, setError] = useState<string | null>(null);
  const loadRequested = useRef<Set<string>>(new Set());
  // Chat/Terminal tab, remembered per session in shell memory (viewRequests).
  const [view, setViewState] = useState<ClaudeViewTab>(() => (id ? getLastView(id) : 'chat'));
  const setView = useCallback((next: ClaudeViewTab) => {
    setViewState(next);
    if (id) rememberView(id, next);
  }, [id]);
  useEffect(() => {
    if (id) setViewState(getLastView(id));
  }, [id]);
  // Lazily open one claude pty per session once the Terminal tab is shown;
  // every opened session's view stays mounted (display:none) so scrollback
  // survives session switches. Same pattern as LocalPanel.
  const [terminalActive, setTerminalActive] = useState(false);
  const [terminalIds, setTerminalIds] = useState<Record<string, string>>({});
  // Attach requests carry the agent id for the next open of that session.
  const attachAgent = useRef<Record<string, string>>({});
  const terminalRequest = useTerminalRequest();

  useEffect(() => setError(null), [id]);

  const forgetTerminal = (sessionId: string) =>
    setTerminalIds((map) => {
      if (!map[sessionId]) return map;
      const next = { ...map };
      delete next[sessionId];
      return next;
    });

  // Sidebar "Open in terminal" / "Attach": wait until the session is selected
  // (the sidebar calls claudeOpen first), then show the terminal tab.
  useEffect(() => {
    if (!terminalRequest || terminalRequest.sessionId !== id) return;
    if (terminalRequest.agentId) attachAgent.current[id] = terminalRequest.agentId;
    setView('terminal');
    setTerminalActive(true);
    consumeTerminalRequest(terminalRequest.seq);
  }, [terminalRequest, id, setView]);

  // Open (or reuse) the selected session's pty while the Terminal tab is shown
  // (opening hands the session to the terminal, so never do it from Chat).
  useEffect(() => {
    if (view !== 'terminal' || !id || terminalIds[id]) return;
    const targetId = id;
    const agentId = attachAgent.current[targetId];
    let cancelled = false;
    void window.devinworkspaces
      .terminalOpen(
        agentId
          ? { kind: 'claude', sessionId: targetId, mode: 'attach', agentId }
          : { kind: 'claude', sessionId: targetId, mode: 'resume' },
      )
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          delete attachAgent.current[targetId];
          setTerminalIds((map) => (map[targetId] ? map : { ...map, [targetId]: result.id }));
          setError(null);
        } else {
          setError(result.error);
          setView('chat');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, id, terminalIds, setView]);

  // Listed transcripts start `loaded: false`; fetch the history once per id.
  useEffect(() => {
    if (!session || session.loaded || session.running || loadRequested.current.has(session.id)) return;
    loadRequested.current.add(session.id);
    void window.devinworkspaces.claudeLoadHistory(session.id).then((result) => {
      if (!result.ok) {
        loadRequested.current.delete(session.id);
        setError(result.error);
      }
    });
  }, [session]);

  const run = (action: Promise<LocalResult<unknown>>) => {
    void action.then((result) => {
      if (!result.ok) setError(result.error);
    });
  };

  const newSession = () => {
    setError(null);
    run(window.devinworkspaces.claudeNewSession(null));
  };

  if (!id) {
    return (
      <div
        data-claude-view
        className="shell-chrome absolute flex flex-col items-center justify-center gap-3 bg-[#111925] text-[#c9d4e3]"
        style={style}
      >
        <p className="m-0 text-sm text-[#8b9bb0]">Select a session or start a new one.</p>
        <button id="claudeNewSessionEmpty" type="button" className={buttonClass} onClick={newSession}>
          New session
        </button>
        {error && (
          <div id="claudeError" className="text-xs text-[#ff8a8a]">
            {error}
          </div>
        )}
      </div>
    );
  }

  const title = meta?.title || session?.title || 'New session';
  const cwd = meta?.cwd ?? session?.cwd ?? '';
  const branch = meta?.gitBranch ?? null;

  // Read-only subagent transcript: swaps the header and chat pane while the
  // terminal pane stays mounted (hidden) so scrollback survives Back.
  const subagentTitle = subagentId
    ? meta?.subagents?.find((s) => s.agentId === subagentId)?.title ||
      subagentSession?.title ||
      subagentId
    : null;

  return (
    <div
      data-claude-view
      data-subagent-id={subagentId ?? undefined}
      className="shell-chrome absolute flex flex-col bg-[#111925] text-[#e8edf5]"
      style={style}
    >
      {subagentId ? (
        <header className="flex items-center gap-3 border-b border-[#39475a] px-4 py-2">
          <button
            id="claudeSubagentBack"
            type="button"
            className={`${buttonClass} flex items-center gap-1`}
            title={`Back to ${title}`}
            onClick={() => window.devinworkspaces.claudeOpen(id)}
          >
            <ArrowLeft size={12} />
            Back
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm" title={subagentTitle ?? undefined}>
              {subagentTitle}
            </div>
            <div className="truncate font-mono text-[10px] text-[#7f8ca0]" title={title}>
              Subagent of {title}
            </div>
          </div>
          <UsagePill usage={subagentSession?.usage} />
        </header>
      ) : (
        <header className="flex items-center gap-3 border-b border-[#39475a] px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 truncate text-sm">
              <span
                data-live={session?.live ?? 'idle'}
                title={`agent: ${session?.live ?? 'idle'}`}
                className={`inline-block h-2 w-2 flex-none rounded-full ${liveColor[session?.live ?? 'idle']}`}
              />
              <span className="truncate" title={title}>
                {title}
              </span>
              {branch && (
                <span data-field="branch" className="flex-none font-mono text-[10px] text-[#7f8ca0]">
                  {branch}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 truncate font-mono text-[10px] text-[#7f8ca0]">
              <span data-field="cwd" className="truncate" title={cwd}>
                {cwd}
              </span>
              <button
                type="button"
                id="claudeCopyId"
                className="flex-none rounded px-1 hover:bg-[#1a2735] hover:text-[#c9d4e3]"
                title={`Copy session id ${id}`}
                onClick={() => window.devinworkspaces.clipboardWriteText(id)}
              >
                copy id
              </button>
            </div>
          </div>
          <UsagePill usage={session?.usage} />
          <button
            id="claudeFork"
            type="button"
            className={`${buttonClass} flex items-center gap-1`}
            title="Fork session"
            aria-label="Fork session"
            disabled={!session || session.running}
            onClick={() => window.devinworkspaces.claudeFork(id)}
          >
            <GitFork size={12} />
            Fork
          </button>
          <div id="claudeViewTabs" className="flex overflow-hidden rounded-md border border-[#39475a]">
            {(['chat', 'terminal'] as const).map((tab) => (
              <button
                key={tab}
                id={`view-${tab}`}
                type="button"
                className={`px-3 py-1 text-xs ${
                  view === tab ? 'bg-[#27364a] text-[#e8edf5]' : 'text-[#7f8ca0] hover:bg-[#18212e]'
                }`}
                onClick={() => {
                  setView(tab);
                  if (tab === 'terminal') {
                    setError(null);
                    setTerminalActive(true);
                  }
                }}
              >
                {tab === 'chat' ? 'Chat' : 'Terminal'}
              </button>
            ))}
          </div>
          {claude.versions.mismatch && (
            <span
              id="claudeVersionWarning"
              className="rounded-full border border-[#8a6a2b] px-2 py-0.5 font-mono text-[10px] text-[#e0a03c]"
              title={`Claude CLI ${claude.versions.cli ?? '?'} · SDK targets ${claude.versions.sdkTarget ?? '?'}`}
            >
              CLI version mismatch
            </span>
          )}
          <select
            id="claudePermissionMode"
            className={selectClass}
            title="Permission mode"
            value={session?.permissionMode ?? state!.settings.claude.defaultPermissionMode}
            disabled={!session}
            onChange={(event) => {
              const mode = event.target.value;
              if (isClaudePermissionMode(mode)) run(window.devinworkspaces.claudeSetPermissionMode(id, mode));
            }}
          >
            {CLAUDE_PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
          {session ? (
            <ModelInput
              value={session.model}
              onCommit={(model) => run(window.devinworkspaces.claudeSetModel(id, model))}
            />
          ) : (
            <input id="claudeModel" type="text" className={`${selectClass} w-36`} placeholder="default model" disabled />
          )}
        </header>
      )}
      <div
        id="terminalPane"
        className="flex min-h-0 flex-1 flex-col"
        style={{ display: !subagentId && view === 'terminal' ? 'flex' : 'none' }}
      >
        {terminalActive &&
          Object.entries(terminalIds).map(([sid, ptyId]) => (
            <div
              key={sid}
              data-session-terminal={sid}
              className="flex min-h-0 flex-1 flex-col"
              style={{ display: sid === id ? 'flex' : 'none' }}
            >
              <TerminalView
                id={ptyId}
                active={!subagentId && view === 'terminal' && sid === id}
                onRestart={() => {
                  window.devinworkspaces.terminalClose(ptyId);
                  forgetTerminal(sid);
                }}
              />
            </div>
          ))}
      </div>
      <div
        id="chatPane"
        className="flex min-h-0 flex-1 flex-col"
        style={{ display: subagentId || view === 'chat' ? 'flex' : 'none' }}
      >
        {subagentId ? (
          <ChatView
            session={subagentSession}
            draftKey={null}
            emptyText="Loading subagent…"
            composerPlaceholder=""
            footerHint={null}
            disabledReason="Subagent transcripts are read-only"
            errorId="claudeError"
            error={error}
            readOnly
            onSend={() => undefined}
            onCancel={() => undefined}
            onPermission={() => undefined}
          />
        ) : (
          <ChatView
            session={session}
            draftKey={id}
            emptyText="Loading…"
            composerPlaceholder="Message Claude…"
            footerHint={`${sendShortcutLabel()} sends · Enter newline`}
            errorId="claudeError"
            error={error}
            disabledReason={session?.terminalOwned ? 'Close the terminal to chat here' : null}
            onSend={(text) => {
              setError(null);
              run(window.devinworkspaces.claudePrompt(id, text));
            }}
            onCancel={() => run(window.devinworkspaces.claudeCancel(id))}
            onPermission={(requestId, optionId) =>
              run(window.devinworkspaces.claudePermission(id, requestId, optionId))
            }
            banner={
              session?.terminalOwned ? (
                <div
                  id="terminalOwnedBanner"
                  className="mb-2 flex items-center justify-between gap-2 rounded-md border border-[#39475a] bg-[#1a2330] px-2 py-1.5 text-xs text-[#aeb9c8]"
                >
                  <span>Live from the terminal — close it to chat here</span>
                  <button
                    id="terminalOwnedClose"
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      const ptyId = terminalIds[session.id];
                      if (ptyId) void window.devinworkspaces.terminalClose(ptyId);
                      else setView('terminal');
                    }}
                  >
                    Close terminal
                  </button>
                </div>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
