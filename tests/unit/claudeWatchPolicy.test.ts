import { describe, expect, it } from 'vitest';
import { LOCAL_HOST, wslHost } from '../../src/core/execHost';
import { dirsChanged, watchAction } from '../../src/core/claudeWatchPolicy';

describe('watchAction', () => {
  it('is history-only for a wsl host with changed files', () => {
    expect(watchAction(wslHost('D', null), ['p/x.jsonl'])).toBe('history-only');
  });
  it('refreshes for a wsl host with no file list', () => {
    expect(watchAction(wslHost('D', null), [])).toBe('refresh');
  });
  it('refreshes for the local host', () => {
    expect(watchAction(LOCAL_HOST, ['p/x.jsonl'])).toBe('refresh');
  });
});

describe('dirsChanged', () => {
  const m = new Map([
    ['a', 1],
    ['b', 2],
  ]);
  it('counts a null prev as changed', () => {
    expect(dirsChanged(null, m)).toBe(true);
  });
  it('is false for equal maps', () => {
    expect(dirsChanged(m, new Map(m))).toBe(false);
  });
  it('detects a changed mtime', () => {
    expect(
      dirsChanged(
        m,
        new Map([
          ['a', 1],
          ['b', 3],
        ]),
      ),
    ).toBe(true);
  });
  it('detects an added key', () => {
    expect(dirsChanged(m, new Map([...m, ['c', 1]]))).toBe(true);
  });
  it('detects a removed key', () => {
    expect(dirsChanged(m, new Map([['a', 1]]))).toBe(true);
  });
});
