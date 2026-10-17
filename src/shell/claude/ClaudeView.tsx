import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ClaudeChatSessionPublic, LocalResult } from '../../shared/ipc';
import { CLAUDE_PERMISSION_MODES, isClaudePermissionMode } from '../../core/settingsDraft';
import { ChatView } from '../chat/ChatView';
import { UsagePill } from '../chat/UsagePill';
import { buttonClass } from '../chat/Cards';
import { useShellState } from '../store';
import { useClaudeChatState } from './store';

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
  const [error, setError] = useState<string | null>(null);
  const loadRequested = useRef<Set<string>>(new Set());

  useEffect(() => setError(null), [id]);

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

  return (
    <div
      data-claude-view
      className="shell-chrome absolute flex flex-col bg-[#111925] text-[#e8edf5]"
      style={style}
    >
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
      <ChatView
        session={session}
        draftKey={id}
        emptyText="Loading…"
        composerPlaceholder="Message Claude…"
        footerHint="Enter sends · Shift+Enter newline"
        errorId="claudeError"
        error={error}
        onSend={(text) => {
          setError(null);
          run(window.devinworkspaces.claudePrompt(id, text));
        }}
        onCancel={() => run(window.devinworkspaces.claudeCancel(id))}
        onPermission={(requestId, optionId) =>
          run(window.devinworkspaces.claudePermission(id, requestId, optionId))
        }
      />
    </div>
  );
}
