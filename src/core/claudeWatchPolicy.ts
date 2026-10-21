// Pure policy for store change events. A full SDK listSessions over the wsl
// UNC (9P) costs seconds, so a wsl transcript change that names its files only
// feeds the history reload — never a full re-list.

import { isWslHost, type ExecHost } from './execHost';

export function watchAction(host: ExecHost, files: string[]): 'history-only' | 'refresh' {
  return isWslHost(host) && files.length > 0 ? 'history-only' : 'refresh';
}

/** Terminal-owned sessions belonging to one host's store (a session without a host is local). */
export function hotIdsForHost(
  sessions: readonly { id: string; host?: string; cwd?: string; terminalOwned?: boolean }[],
  hostId: string,
): { id: string; cwd: string | null }[] {
  return sessions
    .filter((s) => s.terminalOwned && (s.host ?? 'local') === hostId)
    .map((s) => ({ id: s.id, cwd: s.cwd || null }));
}

/** True while an id's last failed transcript lookup is younger than `ttlMs` — skip re-resolving it. */
export function missFresh(missedAt: number | undefined, now: number, ttlMs: number): boolean {
  return missedAt !== undefined && now - missedAt < ttlMs;
}

/** Rate limit: due when never run or when `minMs` elapsed since `lastAt`. */
export function throttleDue(lastAt: number | null, now: number, minMs: number): boolean {
  return lastAt === null || now - lastAt >= minMs;
}

/** Coalesce two refresh host filters; null means "every host" and absorbs any filter. */
export function mergeRefreshHosts(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): Set<string> | null {
  if (a === null || b === null) return null;
  return new Set([...a, ...b]);
}

/** Claude CLI project dir name for a cwd (every non-alphanumeric character → '-'). */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The `n` most recently modified listed transcripts that carry a cwd. */
export function newestTranscripts(
  rows: readonly { id: string; cwd: string | null; lastModified: number }[],
  n: number,
): { id: string; cwd: string }[] {
  return rows
    .filter((r): r is { id: string; cwd: string; lastModified: number } => Boolean(r.cwd))
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, n)
    .map((r) => ({ id: r.id, cwd: r.cwd }));
}

/** True when a transcript tracked in both snapshots has a different mtime (an append);
 * keys on one side only mean the tracked set moved, not that a file changed. */
export function appendsChanged(
  prev: Map<string, number> | null,
  next: Map<string, number>,
): boolean {
  if (!prev) return false;
  for (const [key, mtime] of next) {
    const before = prev.get(key);
    if (before !== undefined && before !== mtime) return true;
  }
  return false;
}

/** True when a project dir was added, removed or has a different mtime; a null `prev` counts as changed. */
export function dirsChanged(prev: Map<string, number> | null, next: Map<string, number>): boolean {
  if (!prev || prev.size !== next.size) return true;
  for (const [dir, mtime] of next) {
    if (prev.get(dir) !== mtime) return true;
  }
  return false;
}
