import type { ClaudeChatStatePublic } from '../../shared/ipc';
import { createPushedStateClient, usePushedState } from '../pushedState';

const client = createPushedStateClient<ClaudeChatStatePublic>({
  onState: (listener) => window.agentworkspace.onClaudeChatState(listener),
  getState: () => window.agentworkspace.getClaudeChatState(),
});

export function useClaudeChatState(): ClaudeChatStatePublic | null {
  return usePushedState(client);
}
