import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  DEVIN_CLOUD_CAPABILITIES,
  type CloudSourceCapabilities,
} from '../../src/core/cloudKit/capabilities';
import { prefixedId, sidebarListData } from '../../src/core/cloudKit/sidebar';
import { buildSessionTree, type SidebarSession } from '../../src/core/sessionTree';
import { CloudSourceCapabilitiesSchema } from '../../src/shared/ipc';

type Row = SidebarSession & { section?: string };

function row(partial: Partial<Row> & { id: string }): Row {
  return {
    title: `s-${partial.id}`,
    folder: null,
    parentId: null,
    isPinned: false,
    isArchived: false,
    updatedAt: 0,
    prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 },
    ...partial,
  };
}

const DERIVED: CloudSourceCapabilities = {
  folders: 'derived',
  archive: false,
  rename: true,
  delete: true,
  reorder: true,
};

describe('CloudSourceCapabilitiesSchema', () => {
  it('accepts the Devin capabilities and matches the core type both ways', () => {
    // Mutual assignability: a field added to either side fails typecheck.
    type Parsed = z.infer<typeof CloudSourceCapabilitiesSchema>;
    const toCore: CloudSourceCapabilities = {} as Parsed;
    const toSchema: Parsed = {} as CloudSourceCapabilities;
    void [toCore, toSchema];
    const parsed = CloudSourceCapabilitiesSchema.parse(DEVIN_CLOUD_CAPABILITIES);
    expect(parsed).toEqual(DEVIN_CLOUD_CAPABILITIES);
    expect(CloudSourceCapabilitiesSchema.safeParse({ ...DERIVED, folders: 'x' }).success).toBe(
      false,
    );
  });
});

describe('prefixedId', () => {
  it('keeps the original id for an empty prefix', () => {
    expect(prefixedId('', 'sessionNew')).toBe('sessionNew');
    expect(prefixedId('', 'sessionsPanel')).toBe('sessionsPanel');
  });
  it('camel-cases prefix + capitalised id', () => {
    expect(prefixedId('openhands', 'sessionNew')).toBe('openhandsSessionNew');
    expect(prefixedId('openhands', 'cloudRefresh')).toBe('openhandsCloudRefresh');
  });
});

describe('sidebarListData', () => {
  const data = {
    sessions: [
      row({ id: 'a', folder: 'Work', updatedAt: 3 }),
      row({ id: 'b', isArchived: true, updatedAt: 2 }),
      row({ id: 'c', updatedAt: 1 }),
    ],
    folders: ['Work'],
    folderTotals: { Work: 1 },
  };

  it('server folders: unchanged apart from hiding archived rows', () => {
    const out = sidebarListData(data, DEVIN_CLOUD_CAPABILITIES, false);
    expect(out.folders).toEqual(['Work']);
    expect(out.folderTotals).toEqual({ Work: 1 });
    expect(out.sessions.map((s) => [s.id, s.folder])).toEqual([
      ['a', 'Work'],
      ['c', null],
    ]);
  });

  it('passes incompleteFolders through for every folders mode', () => {
    const withInc = { ...data, incompleteFolders: ['Work'] };
    expect(sidebarListData(withInc, DEVIN_CLOUD_CAPABILITIES, false).incompleteFolders).toEqual([
      'Work',
    ]);
    expect(
      sidebarListData(withInc, { ...DEVIN_CLOUD_CAPABILITIES, folders: 'none' }, false)
        .incompleteFolders,
    ).toEqual(['Work']);
    expect(
      (sidebarListData(data, DEVIN_CLOUD_CAPABILITIES, false) as { incompleteFolders?: string[] })
        .incompleteFolders,
    ).toBeUndefined();
  });

  it('server folders: showArchived keeps archived rows', () => {
    const out = sidebarListData(data, DEVIN_CLOUD_CAPABILITIES, true);
    expect(out.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('archive:false never filters archived rows', () => {
    const out = sidebarListData(data, { ...DEVIN_CLOUD_CAPABILITIES, archive: false }, false);
    expect(out.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('derived folders: sections come from each row `section`, not the server folder', () => {
    const derived = {
      sessions: [
        row({ id: 'x', section: 'org/zeta', folder: 'Ignored', updatedAt: 4 }),
        row({ id: 'y', section: 'org/alpha', updatedAt: 3 }),
        row({ id: 'z', section: 'org/zeta', updatedAt: 2 }),
        row({ id: 'w', updatedAt: 1 }),
      ],
      folders: ['Ignored'],
      folderTotals: {},
    };
    const out = sidebarListData(derived, DERIVED, false);
    expect(out.folders).toEqual([]);
    const tree = buildSessionTree(out, { collapsedFolders: ['org/alpha'], currentSessionId: null });
    expect(tree.sections.map((s) => [s.kind, s.name, s.collapsed])).toEqual([
      ['folder', 'org/alpha', true],
      ['folder', 'org/zeta', false],
      ['recent', 'recent', false],
    ]);
    expect(tree.sections[1]!.nodes.map((n) => n.session.id)).toEqual(['x', 'z']);
    expect(tree.sections[2]!.nodes.map((n) => n.session.id)).toEqual(['w']);
  });

  it('derived folders: manual row order applies within a derived section', () => {
    const derived = {
      sessions: [
        row({ id: 'x', section: 'repo', updatedAt: 2 }),
        row({ id: 'z', section: 'repo', updatedAt: 1 }),
      ],
      folders: [],
      folderTotals: {},
    };
    const tree = buildSessionTree(sidebarListData(derived, DERIVED, false), {
      collapsedFolders: [],
      currentSessionId: null,
      sectionOrder: { repo: ['z', 'x'] },
    });
    expect(tree.sections[0]!.nodes.map((n) => n.session.id)).toEqual(['z', 'x']);
  });

  it('derived folders: an empty section string does not create a blank folder', () => {
    const derived = {
      sessions: [row({ id: 'e', section: '', updatedAt: 2 }), row({ id: 'r', section: 'repo', updatedAt: 1 })],
      folders: [],
      folderTotals: {},
    };
    const out = sidebarListData(derived, DERIVED, false);
    expect(out.sessions.find((s) => s.id === 'e')!.folder).toBeNull();
    const tree = buildSessionTree(out, { collapsedFolders: [], currentSessionId: null });
    expect(tree.sections.map((s) => s.name)).toEqual(['repo', 'recent']);
  });

  it('no folders: every row lands in recent', () => {
    const out = sidebarListData(data, { ...DERIVED, folders: 'none' }, false);
    expect(out.folders).toEqual([]);
    expect(out.sessions.every((s) => s.folder === null)).toBe(true);
    const tree = buildSessionTree(out, { collapsedFolders: [], currentSessionId: null });
    expect(tree.sections.map((s) => s.name)).toEqual(['recent']);
  });
});
