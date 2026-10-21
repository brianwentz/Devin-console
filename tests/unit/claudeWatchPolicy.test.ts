import { describe, expect, it } from 'vitest';
import { LOCAL_HOST, wslHost } from '../../src/core/execHost';
import {
  appendsChanged,
  dirsChanged,
  hotIdsForHost,
  mergeRefreshHosts,
  missFresh,
  newestTranscripts,
  projectDirName,
  throttleDue,
  watchAction,
} from '../../src/core/claudeWatchPolicy';

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

describe('hotIdsForHost', () => {
  const sessions = [
    { id: 'l1', host: 'local', terminalOwned: true },
    { id: 'l2', terminalOwned: true },
    { id: 'w1', host: 'wsl:D', cwd: '/home/u/p', terminalOwned: true },
    { id: 'w2', host: 'wsl:D', terminalOwned: false },
    { id: 'o1', host: 'wsl:Other', terminalOwned: true },
  ];
  it('keeps only terminal-owned sessions of the given host', () => {
    expect(hotIdsForHost(sessions, 'wsl:D')).toEqual([{ id: 'w1', cwd: '/home/u/p' }]);
  });
  it('treats a missing host as local', () => {
    expect(hotIdsForHost(sessions, 'local').map((s) => s.id)).toEqual(['l1', 'l2']);
  });
  it('maps an empty cwd to null', () => {
    expect(hotIdsForHost([{ id: 'x', cwd: '', terminalOwned: true }], 'local')).toEqual([
      { id: 'x', cwd: null },
    ]);
  });
});

describe('missFresh', () => {
  it('is false for an id that never missed', () => {
    expect(missFresh(undefined, 1_000, 300_000)).toBe(false);
  });
  it('is true within the ttl of the last miss', () => {
    expect(missFresh(1_000, 1_000 + 299_999, 300_000)).toBe(true);
  });
  it('expires after the ttl', () => {
    expect(missFresh(1_000, 1_000 + 300_000, 300_000)).toBe(false);
  });
});

describe('throttleDue', () => {
  it('is due when never run', () => {
    expect(throttleDue(null, 5, 60_000)).toBe(true);
  });
  it('is not due within the window', () => {
    expect(throttleDue(1_000, 60_999, 60_000)).toBe(false);
  });
  it('is due once the window elapsed', () => {
    expect(throttleDue(1_000, 61_000, 60_000)).toBe(true);
  });
});

describe('mergeRefreshHosts', () => {
  it('null (all hosts) absorbs any filter', () => {
    expect(mergeRefreshHosts(null, new Set(['local']))).toBeNull();
    expect(mergeRefreshHosts(new Set(['local']), null)).toBeNull();
  });
  it('unions two filters', () => {
    expect([...mergeRefreshHosts(new Set(['local']), new Set(['wsl:D']))!].sort()).toEqual([
      'local',
      'wsl:D',
    ]);
  });
});

describe('projectDirName', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(projectDirName('/home/u/my.proj')).toBe('-home-u-my-proj');
    expect(projectDirName('C:\\work\\alpha')).toBe('C--work-alpha');
  });
});

describe('newestTranscripts', () => {
  it('returns the n most recently modified rows that have a cwd', () => {
    const rows = [
      { id: 'a', cwd: '/x', lastModified: 1 },
      { id: 'b', cwd: null, lastModified: 9 },
      { id: 'c', cwd: '/y', lastModified: 5 },
      { id: 'd', cwd: '/z', lastModified: 3 },
    ];
    expect(newestTranscripts(rows, 2)).toEqual([
      { id: 'c', cwd: '/y' },
      { id: 'd', cwd: '/z' },
    ]);
  });
});

describe('appendsChanged', () => {
  it('is false without a previous snapshot', () => {
    expect(appendsChanged(null, new Map([['p/a.jsonl', 1]]))).toBe(false);
  });
  it('ignores keys present on one side only (the watched set moved)', () => {
    expect(appendsChanged(new Map([['p/a.jsonl', 1]]), new Map([['p/b.jsonl', 2]]))).toBe(false);
  });
  it('detects a changed mtime on a key present in both', () => {
    expect(appendsChanged(new Map([['p/a.jsonl', 1]]), new Map([['p/a.jsonl', 2]]))).toBe(true);
  });
});
