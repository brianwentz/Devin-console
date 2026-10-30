// The Reviews workspace: `<home>/.agent-workspace/reviews` on the review host,
// pinned first in `claude.workspaces`. The review pty's cwd must exist
// (ConPTY error 267 otherwise), so the controller awaits this before spawning.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { normalizeWorkspacePath, toWindowsPath, type HostId } from '../../core/execHost';
import { reviewsDirFor } from '../../core/tabReview';
import { hosts } from '../hosts';
import { log } from '../log';
import { state, testMode } from '../state';

export type ReviewsWorkspaceResult =
  | { ok: true; cwd: string; workspacePath: string; created: boolean }
  | { ok: false; reason: 'helper-not-ready' | 'not-probed' | 'io' };

const REVIEWS_LABEL = 'Reviews';
const MKDIR_TIMEOUT_MS = 10_000;

export async function ensureReviewsWorkspace(hostId: HostId): Promise<ReviewsWorkspaceResult> {
  let cwd: string;
  let workspacePath: string;
  try {
    if (hostId === 'local') {
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

  const normalized = normalizeWorkspacePath(workspacePath, resolve);
  const claude = state.settings?.current.claude;
  const current = claude?.workspaces ?? [];
  const created = !current.includes(normalized);
  if (created) {
    state.settings?.merge({
      claude: {
        workspaces: [normalized, ...current],
        workspaceLabels: { ...(claude?.workspaceLabels ?? {}), [normalized]: REVIEWS_LABEL },
      },
    });
  }
  log('claude', 'review-workspace', { detail: { host: hostId, created } });
  return { ok: true, cwd, workspacePath: normalized, created };
}
