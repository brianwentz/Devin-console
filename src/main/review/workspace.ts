// The Reviews workspace: `<home>/.agent-workspace/reviews` on the review host,
// pinned first in `claude.workspaces`. The review pty's cwd must exist
// (ConPTY error 267 otherwise), so the controller awaits this before spawning.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { hostIdForPath, normalizeWorkspacePath, toWindowsPath, type HostId } from '../../core/execHost';
import { reviewCwdMatchesHost } from '../../core/reviewSettings';
import { reviewsDirFor } from '../../core/tabReview';
import { hosts } from '../hosts';
import { localHost } from '../local/ipc';
import { log } from '../log';
import { state, testMode } from '../state';

export type ReviewsWorkspaceResult =
  | { ok: true; cwd: string; workspacePath: string; created: boolean }
  | { ok: false; reason: 'helper-not-ready' | 'not-probed' | 'io' | 'cwd-missing' };

const REVIEWS_LABEL = 'Reviews';
const MKDIR_TIMEOUT_MS = 10_000;

/** execFile rejected because the command ran and exited non-zero (not a
 * spawn error, which has a string code, nor a timeout kill). */
function exitedNonZero(error: unknown): boolean {
  const e = error as { code?: unknown; killed?: boolean } | null;
  return typeof e?.code === 'number' && e.code !== 0 && !e.killed;
}

/** A listed workspace that is the same folder: local paths compare
 * case-insensitively (win32 semantics, as workspaceTree does); others verbatim. */
function listedAs(list: readonly string[], path: string): string | undefined {
  if (hostIdForPath(path) !== 'local') return list.find((p) => p === path);
  const key = path.toLowerCase();
  return list.find((p) => hostIdForPath(p) === 'local' && p.toLowerCase() === key);
}

export async function ensureReviewWorkspace(
  hostId: HostId,
  agent: 'claude' | 'devin',
  customCwd: string | null,
): Promise<ReviewsWorkspaceResult> {
  let cwd: string;
  let workspacePath: string;
  try {
    if (customCwd !== null) {
      // Family check first: a hand-edited \\wsl.localhost cwd for host local must
      // never reach Windows-side fs (remote-fs guard).
      if (!reviewCwdMatchesHost(customCwd, hostId, process.platform)) return { ok: false, reason: 'cwd-missing' };
      cwd = customCwd;
      if (hostId === 'local') {
        workspacePath = cwd;
        if (!(await hosts().pathExists(workspacePath))) return { ok: false, reason: 'cwd-missing' };
      } else {
        const host = hosts().hostById(hostId);
        if (!host || host.kind === 'local') return { ok: false, reason: 'not-probed' };
        workspacePath = toWindowsPath(host, cwd);
        // An explicit exec like the default folder's mkdir, not pathExists: a
        // distro the controller just started has no ready helper channel yet.
        try {
          await hosts().execOn(
            host,
            { file: 'test', args: ['-d', cwd], cwd: host.home ?? '/' },
            MKDIR_TIMEOUT_MS,
            { explicit: true },
          );
        } catch (error) {
          return { ok: false, reason: exitedNonZero(error) ? 'cwd-missing' : 'io' };
        }
      }
    } else if (hostId === 'local') {
      const home = (testMode && process.env.AGENT_WORKSPACE_TEST_REVIEWS_HOME?.trim()) || homedir();
      cwd = reviewsDirFor(home, process.platform === 'win32' ? 'win32' : 'posix');
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      workspacePath = cwd;
    } else {
      const host = hosts().hostById(hostId);
      if (!host || host.kind === 'local' || !host.home) return { ok: false, reason: 'not-probed' };
      cwd = reviewsDirFor(host.home, 'posix');
      await hosts().execOn(
        host,
        { file: 'mkdir', args: ['-p', '-m', '700', cwd], cwd: host.home },
        MKDIR_TIMEOUT_MS,
        { explicit: true },
      );
      workspacePath = toWindowsPath(host, cwd);
    }
  } catch {
    return { ok: false, reason: 'io' };
  }

  let normalized = normalizeWorkspacePath(workspacePath, resolve);
  let created: boolean;
  if (agent === 'devin') {
    const settings = state.settings?.current;
    const listed = listedAs(settings?.workspaces ?? [], normalized);
    created = listed === undefined;
    if (listed !== undefined) {
      normalized = listed;
    } else {
      const devin = localHost();
      if (!devin) return { ok: false, reason: 'io' };
      try {
        // Persists settings.workspaces and syncs the Devin Local roster.
        normalized = devin.addWorkspace(normalized);
      } catch {
        return { ok: false, reason: 'io' };
      }
      state.settings?.merge({
        local: { workspaceLabels: { ...(settings?.local.workspaceLabels ?? {}), [normalized]: REVIEWS_LABEL } },
      });
    }
  } else {
    const claude = state.settings?.current.claude;
    const current = claude?.workspaces ?? [];
    const listed = listedAs(current, normalized);
    created = listed === undefined;
    if (listed !== undefined) normalized = listed;
    if (created) {
      state.settings?.merge({
        claude: {
          workspaces: [normalized, ...current],
          workspaceLabels: { ...(claude?.workspaceLabels ?? {}), [normalized]: REVIEWS_LABEL },
        },
      });
    }
  }
  log('claude', 'review-workspace', { detail: { host: hostId, created } });
  return { ok: true, cwd, workspacePath: normalized, created };
}
