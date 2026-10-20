import type { CSSProperties } from 'react';
import { ClaudeAnalyticsPanel } from './ClaudeAnalyticsPanel';
import { useUsageSource } from './useUsageSource';

// Data-bound Claude tab. A4 swaps `useUsageSource` for the real pushed store
// (`useClaudeUsage` from shell/claude/usageStore) — one line.
export function ClaudeAnalyticsTab({ style }: { style: CSSProperties }) {
  const state = useUsageSource();
  return <ClaudeAnalyticsPanel state={state} style={style} />;
}
