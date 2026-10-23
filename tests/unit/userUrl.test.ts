import { describe, expect, it } from 'vitest';
import { normalizeUserUrl, USER_URL_MAX } from '../../src/core/userUrl';

const ok = (raw: string) => {
  const r = normalizeUserUrl(raw);
  if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.reason}`);
  return r.url;
};
const reason = (raw: string) => {
  const r = normalizeUserUrl(raw);
  if (r.ok) throw new Error(`expected failure for ${raw}: ${r.url}`);
  return r.reason;
};

describe('normalizeUserUrl', () => {
  it('accepts explicit http(s) urls', () => {
    expect(ok('https://a.b/c')).toBe('https://a.b/c');
    expect(ok('http://x.y')).toBe('http://x.y/');
    expect(ok('  https://a.b/c  ')).toBe('https://a.b/c');
  });

  it('adds https to bare hosts', () => {
    expect(ok('github.com/o/r')).toBe('https://github.com/o/r');
    expect(ok('example.com?q=1#h')).toBe('https://example.com/?q=1#h');
  });

  it('uses http for localhost and IP literals', () => {
    expect(ok('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(ok('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(ok('[::1]:5173')).toBe('http://[::1]:5173/');
  });

  it('rejects empty input', () => {
    expect(reason('')).toBe('empty');
    expect(reason('   \t')).toBe('empty');
  });

  it('rejects over-long input', () => {
    expect(USER_URL_MAX).toBe(8192);
    expect(reason('https://a.b/' + 'x'.repeat(USER_URL_MAX - 11))).toBe('too-long');
    expect(reason('a'.repeat(USER_URL_MAX + 1))).toBe('too-long');
  });

  it('rejects non-web schemes', () => {
    for (const raw of [
      'javascript:alert(1)',
      'file:///c:/x',
      'data:text/html,x',
      'chrome://settings',
      'about:blank',
    ]) {
      expect(reason(raw)).toBe('scheme');
    }
  });

  it('rejects things that are not urls', () => {
    expect(reason('hello world')).toBe('not-a-url');
    expect(reason('foo')).toBe('not-a-url');
  });
});
