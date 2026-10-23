import type { HostId } from './execHost';
import { DEVIN_LOCAL_MODES } from './settingsDraft';

/**
 * What a spec's `resolveCommand` hands back: the agent binary (plus any leading
 * argv) that gets the spec's `args` appended, or `{ full }` — a complete argv
 * used verbatim (the test-mode `AGENT_WORKSPACE_LOCAL_AGENT_CMD` override,
 * which carries its own args).
 */
export type AgentCommand = readonly string[] | { readonly full: readonly string[] };

export interface AcpMode {
  readonly id: string;
  readonly name: string;
}

/**
 * The provider-specific half of a local ACP agent; everything else (spawn,
 * ACP connection, sessions, terminal handoff, WSL routing) is the shared host.
 */
export interface AcpAgentSpec {
  /** Registry id (`src/core/providers.ts`), e.g. `'devin-local'`. */
  providerId: string;
  label: string;
  /** null = the CLI is not installed on that host (`missing-cli`). */
  resolveCommand(host: HostId): Promise<AgentCommand | null>;
  /** Appended to a resolved binary to start ACP mode, e.g. `['acp']`. */
  args: readonly string[];
  /** Fallback session-mode list for the default-mode select. */
  modes?: readonly AcpMode[];
}

/** The argv to spawn, or null when nothing was resolved (pure). */
export function fullCommand(spec: Pick<AcpAgentSpec, 'args'>, resolved: AgentCommand | null): string[] | null {
  if (!resolved) return null;
  const base = 'full' in resolved ? resolved.full : resolved;
  if (!base[0]) return null;
  return 'full' in resolved ? [...base] : [...base, ...spec.args];
}

/** Devin Local's static half; `createDevinSpec` (main) adds `resolveCommand`. */
export const DEVIN_ACP_SPEC: Omit<AcpAgentSpec, 'resolveCommand'> = {
  providerId: 'devin-local',
  label: 'Devin Local',
  args: ['acp'],
  modes: DEVIN_LOCAL_MODES,
};
