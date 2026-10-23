import { describe, expect, it } from 'vitest';
import {
  FOLDER_MIME,
  SESSION_MIME,
  isUrlDrag,
  pickDroppedUrl,
  safeDropTypes,
} from '../../src/core/dropUrl';

function drag(data: Record<string, string>) {
  const types = Object.keys(data);
  return { types, getData: (type: string) => data[type] ?? '' };
}

function pick(data: Record<string, string>) {
  const { types, getData } = drag(data);
  return pickDroppedUrl(getData, types);
}

describe('pickDroppedUrl', () => {
  it('takes the first non-comment line of text/uri-list (CRLF, comments, blanks)', () => {
    expect(
      pick({
        'text/uri-list': '# comment\r\n\r\n  https://example.com/a  \r\nhttps://example.com/b\r\n',
        'text/plain': 'https://example.com/plain',
      }),
    ).toBe('https://example.com/a');
    expect(pick({ 'text/uri-list': 'https://example.com/lf\nhttps://x.test/' })).toBe(
      'https://example.com/lf',
    );
  });

  it('falls back to text/plain when the uri-list is empty or only comments', () => {
    expect(pick({ 'text/uri-list': '# only\r\n', 'text/plain': ' example.com/p ' })).toBe(
      'example.com/p',
    );
    expect(pick({ 'text/plain': 'hello world' })).toBe('hello world');
  });

  it('falls back to URL', () => {
    expect(pick({ 'text/plain': '   ', URL: 'https://example.com/url' })).toBe(
      'https://example.com/url',
    );
    expect(pick({ URL: 'https://example.com/only' })).toBe('https://example.com/only');
  });

  it('ignores internal sidebar drags', () => {
    expect(pick({ [SESSION_MIME]: 's1', 'text/plain': 'https://example.com/' })).toBeNull();
    expect(pick({ [FOLDER_MIME]: 'f', 'text/uri-list': 'https://example.com/' })).toBeNull();
  });

  it('returns null for empty drags', () => {
    expect(pick({})).toBeNull();
    expect(pick({ 'text/uri-list': '', 'text/plain': '  \r\n', URL: '' })).toBeNull();
    expect(pick({ Files: '' })).toBeNull();
  });
});

describe('isUrlDrag', () => {
  it('accepts URL-carrying types only', () => {
    expect(isUrlDrag(['text/uri-list'])).toBe(true);
    expect(isUrlDrag(['text/plain', 'text/html'])).toBe(true);
    expect(isUrlDrag(['URL'])).toBe(true);
    expect(isUrlDrag(['Files'])).toBe(false);
    expect(isUrlDrag([])).toBe(false);
  });

  it('refuses internal sidebar drags even when they carry text', () => {
    expect(isUrlDrag([SESSION_MIME, 'text/plain'])).toBe(false);
    expect(isUrlDrag([FOLDER_MIME])).toBe(false);
  });
});

describe('safeDropTypes', () => {
  it('caps count and length and drops non-strings', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(safeDropTypes(many)).toHaveLength(32);
    expect(safeDropTypes(['x'.repeat(300)])[0]).toHaveLength(128);
    expect(safeDropTypes(['a', 3 as unknown as string, 'b'])).toEqual(['a', 'b']);
  });
});
