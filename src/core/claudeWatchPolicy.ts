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
