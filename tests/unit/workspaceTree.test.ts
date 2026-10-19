import { describe, expect, it } from 'vitest';
import type { SidebarSession } from '../../src/core/sessionTree';
import {
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

describe('workspaceEntries', () => {
  it('defaults the label to workspaceLabel and honours overrides', () => {
    const entries = workspaceEntries([ws1, unc], { [unc]: 'mine' });
    expect(entries[0]).toEqual({ path: ws1, label: ws1 });
    expect(entries[1]).toEqual({ path: unc, label: 'mine' });
    // No label → the computed display label (UNC shows `<distro> · <linux>`).
    expect(workspaceEntries([unc], {})[1 - 1]!.label).toBe(
      'Ubuntu-22.04 · /home/u/proj',
    );
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
    // Same as the computed default → no key.
    expect(renameWorkspace({}, unc, 'Ubuntu-22.04 · /home/u/proj')).toEqual({});
    // Trimmed whitespace around a custom label is stored trimmed.
    expect(renameWorkspace({}, ws1, '  x  ')).toEqual({ [ws1]: 'x' });
  });
});
