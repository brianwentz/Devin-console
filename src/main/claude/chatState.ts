import { ClaudeChatStateSchema, IpcChannels } from '../../shared/ipc';
import type { ClaudeChatSession } from './host';
import { createPushedStore } from '../pushedStore';

// In-memory claude chat state; mutated only through `update()` with the pure
// generic reducers from core/localModel. Pushes are coalesced per tick so a
// burst of stream updates becomes one `claude:chatUpdate` message.
export type ClaudeChatState = {
  sessions: Record<string, ClaudeChatSession>;
  // Read-only subagent transcripts keyed '<sessionId>/<agentId>'.
  subagentSessions: Record<string, ClaudeChatSession>;
};

const EMPTY: ClaudeChatState = { sessions: {}, subagentSessions: {} };

const store = createPushedStore<ClaudeChatState>({
  schema: ClaudeChatStateSchema,
  channel: IpcChannels.claudeChatUpdate,
  initial: { sessions: {}, subagentSessions: {} },
  empty: () => EMPTY,
  logTag: 'claude',
  logEvent: 'claude-chat-state-invalid',
});

export function getChatState(): ClaudeChatState {
  return store.get();
}

export function update(
  reducer: (state: ClaudeChatState) => ClaudeChatState,
): ClaudeChatState {
  return store.update(reducer);
}

export function publicChatState(): ClaudeChatState {
  return store.publicState();
}


