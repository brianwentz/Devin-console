// agents.list: raw stdout of `claude agents --json --all`, parsed app-side by
// core/claudeAgents.ts parseAgentsJson.

import { execFile } from 'node:child_process';
import { RpcError, optStr } from './params';

export const AGENTS_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 8 * 1024 * 1024;

type ExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; windowsHide: boolean },
  cb: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string) => void,
) => unknown;

export function listAgents(claudePath: string | undefined, exec: ExecFile = execFile as unknown as ExecFile): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    exec(
      claudePath || 'claude',
      ['agents', '--json', '--all'],
      { timeout: AGENTS_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve({ stdout: String(stdout) });
          return;
        }
        // Only the failure kind crosses the channel — never the CLI's output.
        const reason = error.killed ? 'timeout' : typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : 'failed';
        reject(new RpcError('internal', `claude agents failed: ${reason}`));
      },
    );
  });
}

export function agentsHandlers(): Record<string, (params: unknown) => unknown> {
  return {
    'agents.list': (params) => listAgents(optStr(params, 'claudePath')),
  };
}
