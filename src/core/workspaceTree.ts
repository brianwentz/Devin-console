// Path-bound workspaces in the session column (ux2 D7/D8): workspace list →
// sidebar sections. Generic over the session type — Local files by a stored
// `session.workspace`; P4b (Claude) maps via a host-aware cwd matcher. Pure.

import type { SidebarListData, SidebarSession } from './sessionTree';

export interface WorkspaceEntry {
  path: string;
  label: string;
}

// Default display label: the last non-empty path segment (handles `\` and
// `/` separators, trailing separators, and UNC `\wsl.localhost\<d>\...\x`
// -> `x`). The full `workspaceLabel(path)` stays available as the header title.
export function defaultWorkspaceLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function workspaceEntries(
  paths: string[],
  labels: Record<string, string>,
): WorkspaceEntry[] {
  return paths.map((path) => ({ path, label: labels[path] ?? defaultWorkspaceLabel(path) }));
}

// Folders = workspace paths in array order (folderTotals is a Cloud-server
// concept — Local/Claude rows are counted client-side, so it stays empty).
// A session whose folder matches no workspace files under 'recent'.
export function workspaceListData<S extends SidebarSession>(
  entries: WorkspaceEntry[],
  sessions: S[],
): SidebarListData<S> {
  return { sessions, folders: entries.map((e) => e.path), folderTotals: {} };
}

// Reorder guard: `next` must be a permutation of `paths` (the sidebar builds
// it from the same list, but a stale render could hold a removed path).
export function reorderWorkspaces(paths: string[], next: string[]): string[] {
  if (next.length !== paths.length) return paths;
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  for (const item of next) {
    const left = counts.get(item) ?? 0;
    if (left === 0) return paths;
    counts.set(item, left - 1);
  }
  return [...next];
}

// A label identical to the computed default (or blank) stores nothing —
// the default still renders, and the row reverts when the path's default
// label changes.
export function renameWorkspace(
  labels: Record<string, string>,
  path: string,
  label: string,
): Record<string, string> {
  const trimmed = label.trim();
  if (trimmed === '' || trimmed === defaultWorkspaceLabel(path)) {
    if (!(path in labels)) return labels;
    const next = { ...labels };
    delete next[path];
    return next;
  }
  return { ...labels, [path]: trimmed };
}

// --- host-aware cwd → workspace matcher (P4b, D8) ---------------------------
// A session files under the FIRST workspace (array order) that matches its
// (host, cwd) exactly — a session in a sub-folder is Recent, not the
// workspace's child.

import { hostIdForPath, toHostPath, wslHost, type HostId } from './execHost';

const stripTrailingSep = (s: string): string =>
  s.length > 1 ? s.replace(/[\\/]+$/g, '') : s;

const normalizeWin = (p: string): string => stripTrailingSep(p.replace(/\\/g, '/')).toLowerCase();

export interface WorkspaceMatchOpts {
  /** Test seam: a path under this root maps to `uncHostId`, like
   * hosts().pathHostId/windowsPath's DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT. */
  uncRoot?: string | undefined;
  /** Host id the uncRoot maps to (first wsl host, same as pathHostId). */
  uncHostId?: HostId | undefined;
}

/** Host id for a stored workspace path (core UNC match + uncRoot seam). */
function workspaceHostId(path: string, opts?: WorkspaceMatchOpts): HostId {
  if (opts?.uncRoot && path.startsWith(opts.uncRoot)) {
    return opts.uncHostId ?? 'local';
  }
  return hostIdForPath(path);
}

/** The workspace path as its host sees it (UNC → linux cwd, uncRoot → /rest). */
function workspaceHostPath(path: string, hostId: HostId, opts?: WorkspaceMatchOpts): string {
  if (opts?.uncRoot && path.startsWith(opts.uncRoot)) {
    const rest = path.slice(opts.uncRoot.length).replace(/\\/g, '/').replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }
  if (hostId !== 'local' && hostId.startsWith('wsl:')) {
    return toHostPath(wslHost(hostId.slice(4), null), path);
  }
  return path;
}

export function workspaceMatches(
  workspacePath: string,
  session: { host: HostId; cwd: string | null },
  opts?: WorkspaceMatchOpts,
): boolean {
  if (session.cwd === null) return false;
  const hostId = workspaceHostId(workspacePath, opts);
  if (hostId !== session.host) return false;
  if (hostId === 'local') {
    // Local paths compare normalised + case-insensitively (win32 semantics).
    return normalizeWin(workspacePath) === normalizeWin(session.cwd);
  }
  // WSL: linux cwd compares verbatim (case-sensitive) minus a trailing slash.
  const hostPath = workspaceHostPath(workspacePath, hostId, opts);
  const cwd = session.cwd;
  return stripTrailingSep(hostPath) === (cwd === '/' ? '/' : cwd.replace(/\/+$/g, ''));
}

export function workspaceFor(
  workspaces: string[],
  session: { host: HostId; cwd: string | null },
  opts?: WorkspaceMatchOpts,
): string | null {
  for (const path of workspaces) {
    if (workspaceMatches(path, session, opts)) return path;
  }
  return null;
}

// --- legacy Claude folder → workspace migration (D8) -----------------------
// Pure: the caller merges the result into settings.claude.* and strips the
// legacy fields from the registry.

export interface LegacyFolderMigrationResult {
  workspaces: string[];
  labels: Record<string, string>;
  converted: number;
  dropped: number;
}

/**
 * folders: legacy folder names in registry order.
 * candidates: sessions carrying a legacy `folder` (entries' in-memory field)
 *   plus their (host, cwd) — store rows; cwd null → ineligible.
 * toWindows: host+cwd → the stored workspace path form (UNC for wsl,
 *   uncRoot-seamed in tests — callers pass hosts().windowsPath).
 */
export function migrateLegacyFolders(
  folders: string[],
  candidates: { id: string; host: HostId; cwd: string | null; folder: string | null }[],
  toWindows: (host: HostId, cwd: string) => string,
): LegacyFolderMigrationResult {
  const workspaces: string[] = [];
  const labels: Record<string, string> = {};
  let converted = 0;
  let dropped = 0;
  const seenPaths = new Set<string>();
  for (const name of folders) {
    const members = candidates.filter((c) => c.folder === name && c.cwd !== null);
    // Most common (host,cwd), ties → first seen in list order.
    const counts = new Map<string, { host: HostId; cwd: string; count: number; first: number }>();
    members.forEach((m, index) => {
      const key = `${m.host}${m.cwd}`;
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { host: m.host, cwd: m.cwd!, count: 1, first: index });
    });
    const best = [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
    const path = best ? toWindows(best.host, best.cwd) : null;
    if (path === null || seenPaths.has(path) || workspaces.includes(path)) {
      dropped += 1;
      continue;
    }
    seenPaths.add(path);
    workspaces.push(path);
    converted += 1;
    if (name !== defaultWorkspaceLabel(path)) labels[path] = name;
  }
  return { workspaces, labels, converted, dropped };
}
