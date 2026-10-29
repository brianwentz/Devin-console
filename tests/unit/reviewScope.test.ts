import { describe, expect, it } from 'vitest';
import { parseReviewScope } from '../../src/core/reviewScope';

describe('parseReviewScope', () => {
  it('maps the empty scope to global', () => {
    expect(parseReviewScope('')).toEqual({ kind: 'global' });
  });
  it('treats a bare id as a cloud session', () => {
    expect(parseReviewScope('abc')).toEqual({ kind: 'cloud', id: 'abc' });
  });
  it.each(['local', 'claude', 'openhands'] as const)('parses %s: scopes', (kind) => {
    expect(parseReviewScope(`${kind}:x`)).toEqual({ kind, id: 'x' });
  });
});
