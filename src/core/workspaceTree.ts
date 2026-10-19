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
