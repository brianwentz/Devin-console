import { hostIdForPath } from '../../../core/execHost';
import type { HostStatus } from '../../../shared/ipc';

// Host id for a stored workspace path, honouring the test UNC-root seam
// (main exposes it statically via preload — AGENT_WORKSPACE_TEST_WSL_UNC_ROOT
// never reaches the shell otherwise). Same rule as LocalSidebar's copy.
export function hostIdForWorkspace(path: string, hosts: HostStatus[]): string | null {
  const id = hostIdForPath(path);
  if (id !== 'local') return id;
  const root = window.agentworkspace.testWslUncRoot;
  if (root && path.startsWith(root)) {
    return hosts.find((h) => h.kind === 'wsl')?.id ?? 'wsl';
  }
  return null;
}
