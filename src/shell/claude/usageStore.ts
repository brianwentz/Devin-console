import type { ClaudeUsageState } from '../../shared/ipc';
import { createPushedStateClient, usePushedState } from '../pushedState';

const client = createPushedStateClient<ClaudeUsageState>({
  onState: (listener) => window.agentworkspace.onClaudeUsage(listener),
  getState: () => window.agentworkspace.claudeUsageState(),
});

export function useClaudeUsage(): ClaudeUsageState | null {
  return usePushedState(client);
}
