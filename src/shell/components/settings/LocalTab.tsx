import { workspaceLabel } from '../../../core/execHost';
import { useLocalState } from '../../local/store';
import { updateDraft, useSettingsDraft } from '../../settingsDraft';
import { FieldError, HostsPointer, WslDistroSelect, fieldInputClass } from './fields';
import { errorTextClass } from './styles';

// Non-empty local.devinPath that didn't resolve — surfaced inline from the
// live local state rather than as a commit-blocking error.
function DevinPathHint() {
  const local = useLocalState();
  if (!local || local.cliPath !== null) return null;
  return (
    <span id="devinPathInputError" className={errorTextClass}>
      Devin CLI not found at this path
    </span>
  );
}

function AgentsSummary() {
  const local = useLocalState();
  const agents = Object.values(local?.agents ?? {});
  return (
    <div id="localAgentsSummary" className="flex flex-col gap-1 text-sm">
      <span className="text-[#aeb9c8]">Agents</span>
      {agents.length === 0 ? (
        <span className="text-xs text-[#7f8ca0]">No workspaces added yet.</span>
      ) : (
        agents.map((agent) => {
          const facts: string[] = [agent.status];
          if (agent.agentName) facts.push(agent.agentName);
          if (agent.protocolVersion !== undefined) facts.push(`protocol v${agent.protocolVersion}`);
          if (agent.restarts > 0) facts.push(`${agent.restarts} restart${agent.restarts === 1 ? '' : 's'}`);
          return (
            <div
              key={agent.workspace}
              data-local-agent={agent.workspace}
              className="flex flex-col text-xs"
            >
              <span className="text-[#dfe6ef]">{workspaceLabel(agent.workspace)}</span>
              <span data-local-agent-status={agent.status} className="text-[#7f8ca0]">
                {facts.join(' · ')}
              </span>
              {agent.error ? <span className="text-[#d08080]">{agent.error}</span> : null}
            </div>
          );
        })
      )}
    </div>
  );
}

export function LocalTab() {
  const { draft, errors } = useSettingsDraft();
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[#aeb9c8]">devin CLI path</span>
        <input
          id="devinPathInput"
          className={fieldInputClass(errors, 'devinPath')}
          value={draft.devinPath}
          aria-invalid={errors.devinPath ? 'true' : undefined}
          onChange={(event) => updateDraft({ devinPath: event.target.value })}
          placeholder="e.g. C:\Users\me\.local\bin\devin.exe"
        />
        <FieldError inputId="devinPathInput" message={errors.devinPath} />
        {draft.devinPath.trim() !== '' && <DevinPathHint />}
        <span className="text-xs text-[#7f8ca0]">Blank = find devin on PATH.</span>
        <span className="text-xs text-[#7f8ca0]">
          Local agents resolve the CLI when the app starts; restart the app to apply a changed path.
        </span>
      </label>
      <WslDistroSelect
        id="localDefaultWslDistroSelect"
        value={draft.localDefaultWslDistro}
        onChange={(next) => updateDraft({ localDefaultWslDistro: next })}
      />
      <AgentsSummary />
      <HostsPointer />
    </div>
  );
}
