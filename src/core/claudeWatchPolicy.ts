// Pure policy for store refreshes: the surface-entry throttle and coalescing
// of host-scoped refresh filters. (WSL hosts need no polling policy — their
// helper watch pushes `store.changed` patches over the channel.)

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

/**
 * Hosts a status-change refresh lists: local (cheap), plus every WSL host
 * whose store has not started watching yet. A not-ready one costs no I/O —
 * the refresh keeps its rows and reports it in `skippedHosts` (the startup
 * gating evidence, hostsStartup.spec); a ready one gets its first list and
 * starts watching. A store that already watches resyncs itself on its
 * channel's return, so helper state flaps never re-list it.
 */
export function statusRefreshTargets(
  hosts: ReadonlyArray<{ id: string; wsl: boolean; watching: boolean }>,
): string[] {
  const targets = ['local'];
  for (const host of hosts) {
    if (host.wsl && !host.watching) targets.push(host.id);
  }
  return targets;
}
