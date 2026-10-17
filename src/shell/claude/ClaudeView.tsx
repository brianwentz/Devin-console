import type { CSSProperties } from 'react';
import { useShellState } from '../store';
import { relativeTime } from '../components/relativeTime';

// Phase 1 placeholder main column for the claude surface: session metadata
// only — the chat/SDK host and terminal land in a later phase.
export function ClaudeView({ style }: { style: CSSProperties }) {
  const state = useShellState();
  const claude = state!.claude;
  const session = claude.sessions.find((s) => s.id === state!.claudeSessionId) ?? null;

  return (
    <div
      data-claude-view
      className="shell-chrome absolute overflow-auto bg-[#0d141d] text-[#c9d4e3] p-6"
      style={style}
    >
      {session === null ? (
        <div className="text-sm text-[#8b9bb0]">Select a session</div>
      ) : (
        <div className="flex flex-col gap-2 max-w-xl">
          <h2 className="text-base font-semibold" title={session.title}>
            {session.title || 'Untitled session'}
          </h2>
          <div className="flex flex-col gap-1 text-sm text-[#aeb9c8]">
            {session.cwd && (
              <span data-field="cwd" title={session.cwd}>
                {session.cwd}
              </span>
            )}
            {session.gitBranch && <span data-field="branch">branch: {session.gitBranch}</span>}
            <span data-field="created">
              created:{' '}
              {session.createdAt
                ? new Date(session.createdAt).toLocaleString()
                : '—'}
            </span>
            <span data-field="updated">
              updated: {relativeTime(session.updatedAt, Date.now())} ago
            </span>
            <span className="flex items-center gap-2" data-field="id">
              <span className="font-mono text-xs">{session.id}</span>
              <button
                type="button"
                id="claudeCopyId"
                className="px-1.5 py-0.5 rounded bg-[#1a2735] hover:bg-[#1f2f42] text-xs"
                onClick={() => window.devinworkspaces.clipboardWriteText(session.id)}
              >
                copy
              </button>
            </span>
          </div>
          <p className="mt-4 text-xs text-[#5c6b80]">
            Chat and terminal for Claude sessions arrive in a later update.
          </p>
        </div>
      )}
    </div>
  );
}
