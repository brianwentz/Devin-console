import type { ClaudeUsageState } from '../../shared/ipc';
import { createPushedStateClient, usePushedState } from '../pushedState';

const client = createPushedStateClient<ClaudeUsageState>({
  onState: (listener) => window.devinworkspaces.onClaudeUsage(listener),
  getState: () => window.devinworkspaces.claudeUsageState(),
});

export function useClaudeUsage(): ClaudeUsageState | null {
  return usePushedState(client);
}
