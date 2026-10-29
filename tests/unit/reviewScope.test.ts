import { describe, expect, it } from 'vitest';
import { findReviewTabId, parseReviewScope } from '../../src/core/reviewScope';

describe('findReviewTabId', () => {
  const tabs = [
    { id: 'a', url: 'https://github.com/o/r/pull/1/files', originSessionId: 'claude:s' },
    { id: 'b', url: 'https://github.com/o/r/pull/1', originSessionId: 'claude:t' },
    { id: 'c', url: 'https://github.com/o/r/pull/2', originSessionId: null },
  ];
  it('matches the same PR within the scope only', () => {
    expect(findReviewTabId(tabs, 'claude:s', 'https://github.com/O/R/pull/1')).toBe('a');
    expect(findReviewTabId(tabs, 'claude:t', 'https://github.com/o/r/pull/1')).toBe('b');
    expect(findReviewTabId(tabs, 'local:s', 'https://github.com/o/r/pull/1')).toBeNull();
  });
  it('treats a null origin as the global scope', () => {
    expect(findReviewTabId(tabs, '', 'https://github.com/o/r/pull/2')).toBe('c');
  });
  it('returns null for a non-PR url', () => {
    expect(findReviewTabId(tabs, '', 'https://example.com/x')).toBeNull();
  });
});

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
