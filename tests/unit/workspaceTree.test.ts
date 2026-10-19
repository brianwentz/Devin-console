import { describe, expect, it } from 'vitest';
import type { SidebarSession } from '../../src/core/sessionTree';
import {
  defaultWorkspaceLabel,
  renameWorkspace,
  reorderWorkspaces,
  workspaceEntries,
  workspaceListData,
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
