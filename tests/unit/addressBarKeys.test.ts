import { describe, expect, it } from 'vitest';
import { addressBarShortcut } from '../../src/core/addressBarKeys';

const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});

describe('addressBarShortcut', () => {
  it('maps Ctrl+T / Ctrl+L on Windows and Linux', () => {
    expect(addressBarShortcut(key('t', { control: true }), 'win32')).toBe('new');
    expect(addressBarShortcut(key('L', { control: true }), 'linux')).toBe('current');
    expect(addressBarShortcut(key('t', { meta: true }), 'win32')).toBeNull();
    expect(addressBarShortcut(key('t', { control: true, meta: true }), 'win32')).toBeNull();
  });

  it('requires Cmd on macOS — plain Ctrl+T / Ctrl+L stay terminal keys', () => {
    expect(addressBarShortcut(key('t', { meta: true }), 'darwin')).toBe('new');
    expect(addressBarShortcut(key('l', { meta: true }), 'darwin')).toBe('current');
    expect(addressBarShortcut(key('t', { control: true }), 'darwin')).toBeNull();
    expect(addressBarShortcut(key('l', { control: true }), 'darwin')).toBeNull();
  });

  it('ignores Shift/Alt combos, bare keys and other letters', () => {
    expect(addressBarShortcut(key('t', { control: true, shift: true }), 'win32')).toBeNull();
    expect(addressBarShortcut(key('l', { control: true, alt: true }), 'win32')).toBeNull();
    expect(addressBarShortcut(key('t'), 'win32')).toBeNull();
    expect(addressBarShortcut(key('n', { control: true }), 'win32')).toBeNull();
  });
});
