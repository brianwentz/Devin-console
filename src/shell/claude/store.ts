import type { ClaudeChatStatePublic } from '../../shared/ipc';
import { createPushedStateClient, usePushedState } from '../pushedState';

const client = createPushedStateClient<ClaudeChatStatePublic>({
  onState: (listener) => window.devinworkspaces.onClaudeChatState(listener),
  getState: () => window.devinworkspaces.getClaudeChatState(),
});

export function useClaudeChatState(): ClaudeChatStatePublic | null {
  return usePushedState(client);
}
