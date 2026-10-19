import type { LocalStatePublic } from '../../shared/ipc';
import { createPushedStateClient, usePushedState } from '../pushedState';

const client = createPushedStateClient<LocalStatePublic>({
  onState: (listener) => window.devinworkspaces.onLocalState(listener),
  getState: () => window.devinworkspaces.getLocalState(),
});

export function useLocalState(): LocalStatePublic | null {
  return usePushedState(client);
}
