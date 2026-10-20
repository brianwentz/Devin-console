import { describe, expect, it } from 'vitest';
import { pickerFolderMissing, pickerStartPath } from '../../src/core/pickerFolder';

const existing = new Set(['C:\\work', '\\\\wsl.localhost\\Ubuntu\\home\\u']);
const exists = (path: string) => existing.has(path);
const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\u';

describe('pickerStartPath', () => {
  it('prefers the configured folder when it exists', () => {
    expect(pickerStartPath('C:\\work', HOME, exists)).toBe('C:\\work');
    expect(pickerStartPath('C:\\work', undefined, exists)).toBe('C:\\work');
  });

  it('accepts a UNC configured folder', () => {
    expect(pickerStartPath(HOME, undefined, exists)).toBe(HOME);
  });

  it('falls back to the distro home when the configured folder is missing', () => {
    expect(pickerStartPath('C:\\gone', HOME, exists)).toBe(HOME);
  });

  it('falls back to the distro home when nothing is configured', () => {
    expect(pickerStartPath(null, HOME, exists)).toBe(HOME);
    expect(pickerStartPath('', HOME, exists)).toBe(HOME);
    expect(pickerStartPath('   ', HOME, exists)).toBe(HOME);
  });

  it('returns undefined when neither is available', () => {
    expect(pickerStartPath(null, undefined, exists)).toBeUndefined();
    expect(pickerStartPath('C:\\gone', undefined, exists)).toBeUndefined();
  });

  it('trims the configured folder before checking it', () => {
    expect(pickerStartPath('  C:\\work  ', HOME, exists)).toBe('C:\\work');
  });
});

describe('pickerFolderMissing', () => {
  it('is true only for a non-blank configured folder that does not exist', () => {
    expect(pickerFolderMissing('C:\\gone', exists)).toBe(true);
    expect(pickerFolderMissing('C:\\work', exists)).toBe(false);
    expect(pickerFolderMissing(null, exists)).toBe(false);
    expect(pickerFolderMissing('', exists)).toBe(false);
    expect(pickerFolderMissing('  ', exists)).toBe(false);
  });
});
