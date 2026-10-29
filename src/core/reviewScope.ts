import { PROVIDERS } from './providers';

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
