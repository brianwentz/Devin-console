import { describe, expect, it } from 'vitest';
import type { SidebarSession } from '../../src/core/sessionTree';
import {
  defaultWorkspaceLabel,
  migrateLegacyFolders,
  renameWorkspace,
  reorderWorkspaces,
  relativeToWorkspace,
  workspaceDepth,
  workspaceEntries,
  workspaceFor,
  workspaceListData,
  workspaceMatches,
} from '../../src/core/workspaceTree';

const ws1 = 'C:\\ws\\one';
const ws2 = 'C:\\ws\\two';
const unc = '\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\proj';

function session(overrides: Partial<SidebarSession> & { id: string }): SidebarSession {
  return {
    title: `s-${overrides.id}`,
    folder: null,
    parentId: null,
    isPinned: false,
    isArchived: false,
    updatedAt: 0,
    prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 },
    ...overrides,
  };
}

describe('defaultWorkspaceLabel', () => {
  it('is the last non-empty segment for win paths, forward slashes, trailing separators, and UNC', () => {
    expect(defaultWorkspaceLabel(ws1)).toBe('one');
    expect(defaultWorkspaceLabel('C:/ws/two')).toBe('two');
    expect(defaultWorkspaceLabel('C:\\ws\\trail\\')).toBe('trail');
    expect(defaultWorkspaceLabel('/home/u/proj')).toBe('proj');
    expect(defaultWorkspaceLabel(unc)).toBe('proj');
  });
});

describe('workspaceEntries', () => {
  it('defaults the label to the basename and honours overrides', () => {
    const entries = workspaceEntries([ws1, unc], { [unc]: 'mine' });
    expect(entries[0]).toEqual({ path: ws1, label: 'one' });
    expect(entries[1]).toEqual({ path: unc, label: 'mine' });
    // No label → the basename default.
    expect(workspaceEntries([unc], {})[0]!.label).toBe('proj');
  });
});

describe('workspaceListData', () => {
  it('files sessions under their workspace path, unknown → recent-able null folder', () => {
    const entries = workspaceEntries([ws1, ws2], {});
    const data = workspaceListData(entries, [
      session({ id: 'a', folder: ws1 }),
      session({ id: 'b', folder: 'C:\\gone' }),
    ]);
    expect(data.folders).toEqual([ws1, ws2]);
    expect(data.folderTotals).toEqual({});
    // 'b' has no matching workspace: the caller nulls its folder → recent.
    expect(data.sessions[1]!.folder).toBe('C:\\gone');
  });
});

describe('reorderWorkspaces', () => {
  it('accepts a permutation and rejects non-permutations', () => {
    const paths = [ws1, ws2];
    expect(reorderWorkspaces(paths, [ws2, ws1])).toEqual([ws2, ws1]);
    expect(reorderWorkspaces(paths, [ws2])).toBe(paths);
    expect(reorderWorkspaces(paths, [ws2, 'C:\\x'])).toBe(paths);
    expect(reorderWorkspaces(paths, [ws1, ws1])).toBe(paths);
  });
});

describe('renameWorkspace', () => {
  it('stores a custom label and clears it on blank or default', () => {
    let labels = renameWorkspace({}, ws1, 'mine');
    expect(labels).toEqual({ [ws1]: 'mine' });
    labels = renameWorkspace(labels, ws1, '   ');
    expect(labels).toEqual({});
    // Same as the computed basename default → no key.
    expect(renameWorkspace({}, unc, 'proj')).toEqual({});
    expect(renameWorkspace({}, ws1, 'one')).toEqual({});
    // The long form is a *real* label, not the default.
    expect(renameWorkspace({}, unc, 'Ubuntu-22.04 · /home/u/proj')).toEqual({
      [unc]: 'Ubuntu-22.04 · /home/u/proj',
    });
    // Trimmed whitespace around a custom label is stored trimmed.
    expect(renameWorkspace({}, ws1, '  x  ')).toEqual({ [ws1]: 'x' });
  });
});

describe('workspaceMatches / workspaceFor (P4b host-aware cwd match)', () => {
  it('local: exact match, case-insensitive, trailing separators and forward slashes normalised', () => {
    const sess = { host: 'local' as const, cwd: 'C:\\ws\\one' };
    expect(workspaceMatches('C:\\ws\\one', sess)).toBe(true);
    expect(workspaceMatches('c:\\WS\\ONE\\', sess)).toBe(true);
    expect(workspaceMatches('C:/ws/one/', sess)).toBe(true);
    expect(workspaceMatches('C:\\ws\\one\\', { ...sess, cwd: 'C:\\ws\\one' })).toBe(true);
  });

  it('local: a sub-folder matches on a path-segment boundary, case-insensitively', () => {
    expect(workspaceMatches('C:\\ws\\one', { host: 'local', cwd: 'C:\\ws\\one\\sub' })).toBe(true);
    expect(
      workspaceMatches('C:\\ws\\one', { host: 'local', cwd: 'C:/WS/ONE/sub/deeper/' }),
    ).toBe(true);
  });

  it('local: a shared prefix that is not a segment boundary does NOT match, nor a parent dir', () => {
    expect(workspaceMatches('C:\\ws\\one', { host: 'local', cwd: 'C:\\ws\\onetwo' })).toBe(false);
    expect(workspaceMatches('C:\\ws\\one', { host: 'local', cwd: 'C:\\ws' })).toBe(false);
  });

  it('local: a drive-root workspace matches every cwd on that drive', () => {
    expect(workspaceMatches('C:\\', { host: 'local', cwd: 'C:\\anything\\x' })).toBe(true);
    expect(workspaceMatches('C:\\', { host: 'local', cwd: 'D:\\anything\\x' })).toBe(false);
  });

  it('UNC workspace matches a wsl session by linux cwd; the wsl$ spelling works', () => {
    const sess = { host: 'wsl:Ubuntu-22.04' as const, cwd: '/home/u/proj' };
    expect(workspaceMatches(unc, sess)).toBe(true);
    expect(workspaceMatches('\\\\wsl$\\Ubuntu-22.04\\home\\u\\proj', sess)).toBe(true);
    expect(workspaceMatches(`${unc}\\`, sess)).toBe(true);
    // Case-sensitive on the linux side.
    expect(workspaceMatches(unc, { ...sess, cwd: '/home/u/PROJ' })).toBe(false);
  });

  it('UNC workspace matches a wsl session in a sub-folder; not a prefix sibling or a parent', () => {
    const host = 'wsl:Ubuntu-22.04' as const;
    expect(workspaceMatches(unc, { host, cwd: '/home/u/proj/svc' })).toBe(true);
    expect(workspaceMatches(unc, { host, cwd: '/home/u/project' })).toBe(false);
    expect(workspaceMatches(unc, { host, cwd: '/home/u' })).toBe(false);
  });

  it('UNC distro-root workspace matches every cwd on that distro', () => {
    const host = 'wsl:Ubuntu-22.04' as const;
    expect(workspaceMatches('\\\\wsl.localhost\\Ubuntu-22.04\\', { host, cwd: '/home/u' })).toBe(
      true,
    );
  });

  it('host mismatch: a local workspace never matches a wsl session with the same-looking path', () => {
    expect(
      workspaceMatches('C:\\ws\\one', { host: 'wsl:Ubuntu-22.04', cwd: 'C:\\ws\\one' }),
    ).toBe(false);
    expect(
      workspaceMatches(unc, { host: 'local', cwd: unc }),
    ).toBe(false);
    expect(
      workspaceMatches(unc, { host: 'wsl:Other', cwd: '/home/u/proj' }),
    ).toBe(false);
  });

  it('uncRoot seam: a path under the root counts as the uncHostId distro', () => {
    const opts = { uncRoot: 'C:\\tmp\\unc', uncHostId: 'wsl:Fake' as const };
    const ws = 'C:\\tmp\\unc\\home\\u\\proj';
    expect(workspaceMatches(ws, { host: 'wsl:Fake', cwd: '/home/u/proj' }, opts)).toBe(true);
    expect(workspaceMatches(ws, { host: 'local', cwd: ws }, opts)).toBe(false);
    // Without the seam the same path is local.
    expect(workspaceMatches(ws, { host: 'local', cwd: ws })).toBe(true);
  });

  it('workspaceFor returns the deepest matching workspace, null on no match', () => {
    const sess = { host: 'local' as const, cwd: 'C:\\ws\\one' };
    expect(workspaceFor([ws2, ws1], sess)).toBe(ws1);
    expect(workspaceFor([ws1, 'C:\\WS\\ONE\\'], sess)).toBe(ws1);
    expect(workspaceFor([ws2], sess)).toBeNull();
    expect(workspaceFor([ws1], { host: 'local', cwd: null })).toBeNull();
  });

  it('workspaceFor: a nested workspace wins over its ancestor regardless of array order', () => {
    const sess = { host: 'local' as const, cwd: 'C:\\ws\\one\\x' };
    expect(workspaceFor(['C:\\ws', 'C:\\ws\\one'], sess)).toBe('C:\\ws\\one');
    expect(workspaceFor(['C:\\ws\\one', 'C:\\ws'], sess)).toBe('C:\\ws\\one');
  });

  it('workspaceFor: duplicate-path ties keep array order (first wins)', () => {
    const sess = { host: 'local' as const, cwd: 'C:\\ws\\one' };
    expect(workspaceFor(['C:\\ws\\one', 'c:\\WS\\ONE\\'], sess)).toBe('C:\\ws\\one');
  });

  it('workspaceDepth counts host-side path segments', () => {
    expect(workspaceDepth('C:\\ws')).toBe(2);
    expect(workspaceDepth('C:\\ws\\one')).toBe(3);
    expect(workspaceDepth('C:\\')).toBe(1);
    expect(workspaceDepth(unc)).toBe(3);
    expect(workspaceDepth('\\\\wsl.localhost\\Ubuntu-22.04\\')).toBe(0);
  });

  it('relativeToWorkspace: null without a match, "" on exact match, the remainder otherwise', () => {
    const local = 'local' as const;
    const wsl = 'wsl:Ubuntu-22.04' as const;
    expect(relativeToWorkspace(ws1, { host: local, cwd: 'C:\\ws\\two' })).toBeNull();
    expect(relativeToWorkspace(ws1, { host: local, cwd: null })).toBeNull();
    expect(relativeToWorkspace(ws1, { host: local, cwd: 'C:\\ws\\one' })).toBe('');
    expect(relativeToWorkspace('C:\\ws\\one\\', { host: local, cwd: 'C:\\ws\\one' })).toBe('');
    expect(relativeToWorkspace(ws1, { host: local, cwd: 'C:\\ws\\one\\a\\b' })).toBe('a\\b');
    expect(relativeToWorkspace(unc, { host: wsl, cwd: '/home/u/proj/svc' })).toBe('svc');
    expect(relativeToWorkspace(unc, { host: wsl, cwd: '/home/u/proj/svc/' })).toBe('svc');
  });
});

describe('migrateLegacyFolders (D8)', () => {
  const toWindows = (host: string, cwd: string): string =>
    host === 'local' ? cwd : ('\\\\wsl.localhost\\${host.slice(4)}\\home' + cwd.replaceAll('/', '\\'));

  const cand = (id: string, cwd: string | null, folder: string | null) => ({
    id,
    host: 'local' as const,
    cwd,
    folder,
  });

  it('converts a folder with cwd candidates, drops one without', () => {
    const result = migrateLegacyFolders(
      ['Work', 'Loose'],
      [cand('a', 'C:\\ws\\one', 'Work'), cand('b', 'C:\\ws\\one', 'Work'), cand('c', 'C:\\ws\\one', 'Work'), cand('d', null, 'Loose')],
      toWindows,
    );
    expect(result).toMatchObject({ workspaces: ['C:\\ws\\one'], converted: 1, dropped: 1 });
    // 'Work' != basename 'one' → the label survives.
    expect(result.labels).toEqual({ 'C:\\ws\\one': 'Work' });
  });

  it('picks the most common cwd, ties broken by first seen', () => {
    const result = migrateLegacyFolders(
      ['F'],
      [
        cand('a', 'C:\\ws\\one', 'F'),
        cand('b', 'C:\\ws\\two', 'F'),
        cand('c', 'C:\\ws\\one', 'F'),
      ],
      toWindows,
    );
    expect(result.workspaces).toEqual(['C:\\ws\\one']);
    const tie = migrateLegacyFolders(
      ['F'],
      [cand('a', 'C:\\ws\\one', 'F'), cand('b', 'C:\\ws\\two', 'F')],
      toWindows,
    );
    expect(tie.workspaces).toEqual(['C:\\ws\\one']);
  });

  it('stores no label when the folder name equals the basename', () => {
    const result = migrateLegacyFolders(['one'], [cand('a', 'C:\\ws\\one', 'one')], toWindows);
    expect(result.workspaces).toEqual(['C:\\ws\\one']);
    expect(result.labels).toEqual({});
  });

  it('drops a folder whose only members live on an unknown host (toWindows null)', () => {
    const result = migrateLegacyFolders(
      ['Wsl folder'],
      [{ id: 'w1', host: 'wsl:Gone', cwd: '/home/u/x', folder: 'Wsl folder' }],
      () => null,
    );
    expect(result.workspaces).toEqual([]);
    expect(result.labels).toEqual({});
    expect(result).toMatchObject({ converted: 0, dropped: 1 });
  });

  it('drops the second folder when both resolve to the same path', () => {
    const result = migrateLegacyFolders(
      ['A', 'B'],
      [cand('a', 'C:\\ws\\one', 'A'), cand('b', 'C:\\ws\\one', 'B')],
      toWindows,
    );
    expect(result.workspaces).toEqual(['C:\\ws\\one']);
    expect(result).toMatchObject({ converted: 1, dropped: 1 });
    expect(result.labels).toEqual({ 'C:\\ws\\one': 'A' });
  });
});
