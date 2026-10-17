import { formatTokens } from '../../core/format';
import type { ChatSessionPublic } from '../../shared/ipc';

type Usage = NonNullable<ChatSessionPublic['usage']>;

export function usageTooltip(usage: Usage): string {
  const lines: string[] = [];
  const num = (value: number | null) => (value === null ? null : value.toLocaleString());
  if (usage.used !== null && usage.size !== null)
    lines.push(`Context: ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()}`);
  if (usage.inputTokens !== null) lines.push(`Input: ${num(usage.inputTokens)}`);
  if (usage.outputTokens !== null) lines.push(`Output: ${num(usage.outputTokens)}`);
  if (usage.thoughtTokens !== null) lines.push(`Thought: ${num(usage.thoughtTokens)}`);
  if (usage.cachedReadTokens !== null) lines.push(`Cache read: ${num(usage.cachedReadTokens)}`);
  if (usage.cachedWriteTokens !== null) lines.push(`Cache write: ${num(usage.cachedWriteTokens)}`);
  if (usage.totalTokens !== null) lines.push(`Total: ${num(usage.totalTokens)}`);
  return lines.join('\n');
}

// Header token pill (#tokenUsage); renders nothing when every field is null.
export function UsagePill({ usage }: { usage: Usage | undefined }) {
  if (!usage || !Object.values(usage).some((value) => value !== null)) return null;
  return (
    <div
      id="tokenUsage"
      className="flex items-center gap-2 rounded-md border border-[#39475a] bg-[#1a2330] px-2 py-0.5 font-mono text-[10px] text-[#aeb9c8]"
      title={usageTooltip(usage)}
    >
      {usage.used !== null && usage.size !== null && (
        <span>
          {formatTokens(usage.used)} / {formatTokens(usage.size)} ctx
        </span>
      )}
      {usage.inputTokens !== null && <span>↑{formatTokens(usage.inputTokens)}</span>}
      {usage.outputTokens !== null && <span>↓{formatTokens(usage.outputTokens)}</span>}
    </div>
  );
}
