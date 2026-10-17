import { ClaudeChatStateSchema, IpcChannels } from '../../shared/ipc';
import type { ClaudeChatSession } from './host';
import { log } from '../log';
import { state } from '../state';

// In-memory claude chat state; mutated only through `update()` with the pure
// generic reducers from core/localModel. Pushes are coalesced per tick so a
// burst of stream updates becomes one `claude:chatUpdate` message.
export type ClaudeChatState = { sessions: Record<string, ClaudeChatSession> };

let current: ClaudeChatState = { sessions: {} };
let scheduled = false;

export function getChatState(): ClaudeChatState {
  return current;
}

export function replaceChatState(next: ClaudeChatState): void {
  current = next;
  schedulePublish();
}

export function update(reducer: (state: ClaudeChatState) => ClaudeChatState): ClaudeChatState {
  const next = reducer(current);
  if (next !== current) {
    current = next;
    schedulePublish();
  }
  return current;
}

function schedulePublish(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    publishChatState();
  });
}

export function publicChatState(): ClaudeChatState {
  const parsed = ClaudeChatStateSchema.safeParse(current);
  if (parsed.success) return parsed.data as ClaudeChatState;
  log('claude', 'claude-chat-state-invalid', {
    detail: { issues: parsed.error.issues.slice(0, 5) },
  });
  return { sessions: {} };
}

export function publishChatState(): void {
  const view = state.shellView;
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.send(IpcChannels.claudeChatUpdate, publicChatState());
}
