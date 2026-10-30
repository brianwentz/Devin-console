import { PROVIDERS } from './providers';
import { pullRequestKey } from './tabModel';

export type ReviewScopeTarget =
  | { kind: 'global' }
  | { kind: 'cloud'; id: string }
  | { kind: 'local' | 'claude' | 'openhands'; id: string };

// Inverse of providerScope: '' is the global tab scope, an unprefixed id is a
// Devin Cloud session (its descriptor has no prefix), the rest go by scopePrefix.
export function parseReviewScope(scope: string): ReviewScopeTarget {
  if (scope === '') return { kind: 'global' };
  for (const p of PROVIDERS) {
    if (p.scopePrefix && scope.startsWith(p.scopePrefix)) {
      const kind = p.scopePrefix.slice(0, -1) as 'local' | 'claude' | 'openhands';
      return { kind, id: scope.slice(p.scopePrefix.length) };
    }
  }
  return { kind: 'cloud', id: scope };
}

// The tab of `scope` showing the same PR as `prUrl` (sub-paths and query
// ignored), or null when there is none.
export function findReviewTabId(
  tabs: ReadonlyArray<{ id: string; url: string; originSessionId?: string | null | undefined }>,
  scope: string,
  prUrl: string,
): string | null {
  const key = pullRequestKey(prUrl);
  if (key === null) return null;
  const tab = tabs.find((t) => (t.originSessionId ?? '') === scope && pullRequestKey(t.url) === key);
  return tab?.id ?? null;
}
