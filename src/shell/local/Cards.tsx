import type { LocalStatePublic } from '../../shared/ipc';

// Shared chat cards live in ../chat/Cards; this file keeps the Local-only
// AgentBadge and re-exports the shared pieces for existing importers.
export { buttonClass, MessageView, PermissionCard, PlanList, ThoughtBlock, ToolCallCard } from '../chat/Cards';

type Agent = LocalStatePublic['agents'][string];

export function AgentBadge({ agent, installGuidance }: { agent: Agent | undefined; installGuidance: string }) {
  const status = agent?.status ?? 'stopped';
  const color =
    status === 'ready'
      ? 'border-[#3f7a4a] text-[#8fd18f]'
      : status === 'starting'
        ? 'border-[#54749c] text-[#83b6ff]'
        : status === 'crashed' || status === 'missing-cli'
          ? 'border-[#8a3b3b] text-[#ff8a8a]'
          : 'border-[#39475a] text-[#aeb9c8]';
  const label =
    status === 'crashed'
      ? `crashed · retry${agent?.retryInMs ? ` in ${Math.ceil(agent.retryInMs / 1000)}s` : ' on next prompt'}`
      : status;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        id="agentBadge"
        data-status={status}
        className={`rounded-full border px-2 py-0.5 font-mono ${color}`}
        title={agent?.error ?? ''}
      >
        {label}
      </span>
      {agent?.capabilities && (
        <span id="agentCaps" className="text-[#7f8ca0]">
          ACP v{agent.protocolVersion ?? '?'} · list {agent.capabilities.sessionList ? 'yes' : 'no'} · load{' '}
          {agent.capabilities.loadSession ? 'yes' : 'no'} · delete {agent.capabilities.sessionDelete ? 'yes' : 'no'}
        </span>
      )}
      {status === 'missing-cli' && (
        <span id="installGuidance" className="text-[#ff8a8a]">
          {installGuidance}
        </span>
      )}
    </div>
  );
}
