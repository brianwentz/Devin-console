import { describe, expect, it, vi } from 'vitest';
import { pickerStartPath } from '../../src/core/pickerFolder';

const existing = new Set(['C:\\work', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj']);
const exists = async (path: string) => existing.has(path);
const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\u';

describe('pickerStartPath', () => {
  it('prefers the configured folder when it exists', async () => {
    expect(await pickerStartPath('C:\\work', HOME, exists)).toBe('C:\\work');
    expect(await pickerStartPath('C:\\work', undefined, exists)).toBe('C:\\work');
  });

  it('accepts a UNC configured folder', async () => {
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj';
    expect(await pickerStartPath(unc, undefined, exists)).toBe(unc);
  });

  it('falls back to the distro home when the configured folder is missing', async () => {
    expect(await pickerStartPath('C:\\gone', HOME, exists)).toBe(HOME);
  });

  it('never checks the distro home (the probe reported it)', async () => {
    const spy = vi.fn(exists);
    expect(await pickerStartPath(null, HOME, spy)).toBe(HOME);
    expect(await pickerStartPath('C:\\gone', HOME, spy)).toBe(HOME);
    expect(spy.mock.calls.map(([p]) => p)).toEqual(['C:\\gone']);
  });

  it('falls back to the distro home when nothing is configured', async () => {
    expect(await pickerStartPath(null, HOME, exists)).toBe(HOME);
    expect(await pickerStartPath('', HOME, exists)).toBe(HOME);
    expect(await pickerStartPath('   ', HOME, exists)).toBe(HOME);
  });

  it('returns undefined when neither is available', async () => {
    expect(await pickerStartPath(null, undefined, exists)).toBeUndefined();
    expect(await pickerStartPath('C:\\gone', undefined, exists)).toBeUndefined();
  });

  it('trims the configured folder before checking it', async () => {
    expect(await pickerStartPath('  C:\\work  ', HOME, exists)).toBe('C:\\work');
  });

  it('a rejecting exists check counts as missing', async () => {
    expect(await pickerStartPath('C:\\work', HOME, () => Promise.reject(new Error('down')))).toBe(HOME);
  });

  it('reports a missing configured folder once, and only then', async () => {
    const onMissing = vi.fn();
    await pickerStartPath('C:\\gone', HOME, exists, onMissing);
    expect(onMissing).toHaveBeenCalledTimes(1);
    for (const configured of ['C:\\work', null, '', '  ']) {
      await pickerStartPath(configured, HOME, exists, onMissing);
    }
    expect(onMissing).toHaveBeenCalledTimes(1);
  });
});
