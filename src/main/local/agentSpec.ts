// The AcpAgentSpec seam lives in core (pure, unit-tested); re-exported here so
// main-side specs (devinSpec.ts, future local ACP providers) import it locally.
export { DEVIN_ACP_SPEC, fullCommand, spawnCommand, type AcpAgentSpec, type AcpMode, type AgentCommand } from '../../core/acpAgentSpec';
