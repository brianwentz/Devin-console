import { useEffect, type CSSProperties } from 'react';
import { emptyClaudeUsageState, monthKey } from '../../../core/claudeUsage';
import { useClaudeUsage } from '../../claude/usageStore';
import { ClaudeAnalyticsPanel } from './ClaudeAnalyticsPanel';

// Data-bound Claude tab: the pushed usage store (A2's service) + the
// visibility signal that drives its fetch/scan cadence.
export function ClaudeAnalyticsTab({ style }: { style: CSSProperties }) {
  const state = useClaudeUsage();
  useEffect(() => {
    window.agentworkspace.claudeUsageVisible(true);
    return () => window.agentworkspace.claudeUsageVisible(false);
  }, []);
  return (
    <ClaudeAnalyticsPanel
      state={state ?? emptyClaudeUsageState(monthKey(new Date()))}
      style={style}
    />
  );
}
