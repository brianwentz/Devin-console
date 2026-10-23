import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { HostId } from '../../core/execHost';
import { hosts } from '../hosts';
import { DEVIN_ACP_SPEC, type AcpAgentSpec, type AgentCommand } from './agentSpec';

// Resolve the `devin` executable: explicit override, else PATH lookup via
// `where` (Windows) / `which` (POSIX). Returns null when nothing is found.
export function resolveDevinPath(override: string | null | undefined): string | null {
  if (override) return existsSync(override) ? override : null;
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(lookup, ['devin'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

export interface DevinSpecOptions {
  testMode: boolean;
  /** Base for relative args of the test command override. */
  appPath: string;
  /** `local.devinPath` — read once, when the host resolves its local command at start. */
  devinPathOverride: string | null | undefined;
}

// The production path spawns the external `devin` binary (RunAsNode is fused
// off, so we never fork Node). A full command override exists only in test mode.
function resolveLocal(options: DevinSpecOptions): AgentCommand | null {
  const testCommand = options.testMode ? process.env.AGENT_WORKSPACE_LOCAL_AGENT_CMD : undefined;
  if (testCommand) {
    const [file, ...args] = testCommand.split(/\s+/).filter(Boolean);
    if (!file) return null;
    const resolvedArgs = args.map((arg) => {
      if (isAbsolute(arg)) return arg;
      const candidate = resolve(options.appPath, arg);
      return existsSync(candidate) ? candidate : arg;
    });
    // The override is the whole argv — `acp` is not appended.
    return { full: [file, ...resolvedArgs] };
  }
  const devinPath = resolveDevinPath(options.devinPathOverride);
  return devinPath ? [devinPath] : null;
}

/**
 * Devin Local's AcpAgentSpec. `local` = test override, else `local.devinPath`,
 * else PATH (`where`/`which`). A WSL host = the probe's CLI path
 * (`hosts.overrides[id].devinPath` wins inside the probe); callers prime the
 * probe with `hosts().shellEnv(host, { explicit: true })` first.
 */
export function createDevinSpec(options: DevinSpecOptions): AcpAgentSpec {
  return {
    ...DEVIN_ACP_SPEC,
    async resolveCommand(host: HostId): Promise<AgentCommand | null> {
      if (host === 'local') return resolveLocal(options);
      const path = hosts().status(host)?.devin.path;
      return path ? [path] : null;
    },
  };
}
