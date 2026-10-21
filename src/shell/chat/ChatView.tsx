import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatElapsed } from '../../core/format';
import type { ChatSessionPublic } from '../../shared/ipc';
import { MessageView, PermissionCard, PlanList, buttonClass } from './Cards';
import { ThinkingIndicator } from './ThinkingIndicator';
import { clearDraft, getDraft, setDraft as setStoredDraft } from './drafts';

// Label for the composer's send chord (Ctrl+Enter / ⌘+Enter) — the hints in
// LocalPanel and ClaudeView both read it so the string is defined once.
export const sendShortcutLabel = (): string =>
  `${window.agentworkspace.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter`;

export interface ChatViewProps {
  session: ChatSessionPublic | null;
  // Drafts store key (session id); the textarea state lives here so unsent
  // text survives unmounts and session switches.
  draftKey: string | null;
  emptyText: string;
  composerPlaceholder: string;
  footerHint: ReactNode;
  // When set the composer is disabled and shows this as its placeholder.
  disabledReason?: string | null;
  error: string | null;
  errorId?: string;
  onSend: (text: string) => void;
  onCancel: () => void;
  onPermission: (requestId: string, optionId: string) => void;
  // Rendered above the composer (Local's terminal-owned banner).
  banner?: ReactNode;
  // Hides the footer (composer, banner, hint) entirely — read-only transcripts.
  readOnly?: boolean;
}

export function ChatView({
  session,
  draftKey,
  emptyText,
  composerPlaceholder,
  footerHint,
  disabledReason = null,
  error,
  errorId = 'localError',
  onSend,
  onCancel,
  onPermission,
  banner,
  readOnly = false,
}: ChatViewProps) {
  const [draft, setDraftState] = useState(() => getDraft(draftKey));
  const scroller = useRef<HTMLDivElement>(null);
  const setDraft = (text: string) => {
    setDraftState(text);
    if (draftKey) setStoredDraft(draftKey, text);
  };

  // Swap in the newly selected session's stored draft.
  useEffect(() => {
    setDraftState(getDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session?.messages.length, session?.plan, session?.pendingPermission?.requestId]);

  const disabled = !session || disabledReason !== null;

  const send = () => {
    const text = draft.trim();
    if (!text || !session || session.running || disabled) return;
    setDraftState('');
    if (draftKey) clearDraft(draftKey);
    onSend(text);
  };

  // Ctrl+Enter (⌘+Enter on macOS) sends; plain Enter and Shift+Enter fall
  // through to the textarea and insert a newline.
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  return (
    <>
      <div ref={scroller} id="messageList" className="flex flex-1 flex-col gap-2 overflow-auto px-4 py-3">
        {!session && <p className="text-sm text-[#7f8ca0]">{emptyText}</p>}
        {session?.messages.map((message, index) => (
          <MessageView key={index} message={message} session={session} />
        ))}
        {session?.plan && session.plan.length > 0 && <PlanList plan={session.plan} />}
        {session?.pendingPermission && (
          <PermissionCard permission={session.pendingPermission} onRespond={onPermission} />
        )}
        {session?.running && <ThinkingIndicator startedAt={session.promptStartedAt} />}
        {!session?.running && session?.lastTurnMs !== undefined && (
          <div
            id="turnSummary"
            className={`text-xs ${
              session.lastStopReason && session.lastStopReason !== 'end_turn'
                ? 'text-[#e0a03c]'
                : 'text-[#7f8ca0]'
            }`}
          >
            <span id="stopReason" data-stop-reason={session.lastStopReason ?? ''}>
              Took {formatElapsed(session.lastTurnMs)}
              {session.lastStopReason && session.lastStopReason !== 'end_turn'
                ? ` · ${session.lastStopReason}`
                : ''}
              {session.error ? ` — ${session.error}` : ''}
            </span>
          </div>
        )}
      </div>
      {error && (
        <div id={errorId} className="border-t border-[#39475a] px-4 py-1.5 text-xs text-[#ff8a8a]">
          {error}
        </div>
      )}
      {!readOnly && (
        <footer className="border-t border-[#39475a] px-4 py-3">
          {banner}
          <div className="flex items-end gap-2">
            <textarea
              id="composer"
              className="min-h-[44px] max-h-40 flex-1 resize-y rounded-md border border-[#39475a] bg-[#0d141d] px-2 py-1.5 text-sm text-[#e8edf5]"
              placeholder={
                disabledReason ?? (session ? composerPlaceholder : 'Start a session to chat')
              }
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKey}
              rows={2}
            />
            {session?.running ? (
              <button id="cancelButton" type="button" className={buttonClass} onClick={onCancel}>
                Cancel
              </button>
            ) : (
              <button
                id="sendButton"
                type="button"
                className={buttonClass}
                disabled={disabled || !draft.trim()}
                onClick={send}
              >
                Send
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-[#7f8ca0]">{footerHint}</p>
        </footer>
      )}
    </>
  );
}
