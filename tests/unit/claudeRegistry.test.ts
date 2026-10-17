import { describe, expect, it } from 'vitest';
import {
  ClaudeRegistrySchema,
  emptyRegistry,
  folderCreate,
  folderDelete,
  folderRename,
  folderReorder,
  reconcile,
  setArchived,
  setFolder,
  setPinned,
  setRemoved,
  touchOpened,
  type ClaudeRegistry,
  type ClaudeRegistryEntry,
  type ClaudeStoreSession,
} from '../../src/core/claudeRegistry';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

const store = (over: Partial<ClaudeStoreSession> = {}): ClaudeStoreSession => ({
  id: 's1',
  title: 'First session',
  cwd: 'C:\\proj',
  gitBranch: 'main',
  tag: null,
  createdAt: NOW - 10 * DAY,
  lastModified: NOW - DAY,
  fileSize: 1024,
  ...over,
});

const entry = (over: Partial<ClaudeRegistryEntry> = {}): ClaudeRegistryEntry => ({
  id: 's1',
  folder: null,
  pinned: false,
  archived: false,
  archivedAt: null,
  unarchivedAt: null,
  removed: false,
  removedAt: null,
  lastOpenedAt: null,
  prUrls: [],
  ...over,
});

const reg = (over: Partial<ClaudeRegistry> = {}): ClaudeRegistry => ({
  ...emptyRegistry(),
  ...over,
});

describe('ClaudeRegistrySchema', () => {
  it('round-trips a valid registry and drops unknown fields', () => {
    const parsed = ClaudeRegistrySchema.parse(reg({ folders: ['A'] }));
    expect(parsed.folders).toEqual(['A']);
    expect(parsed.version).toBe(1);
    const withExtra = ClaudeRegistrySchema.safeParse({
      version: 1,
      folders: [],
      entries: { s1: { ...entry(), bogus: true } },
      other: 42,
    });
    expect(withExtra.success).toBe(true);
  });
});

describe('reconcile', () => {
  it('emits one row per non-removed store session with defaults', () => {
    const { sessions, changed } = reconcile(reg(), [store()], { now: NOW, autoArchiveDays: 0 });
    expect(changed).toBe(false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 's1',
      title: 'First session',
      cwd: 'C:\\proj',
      folder: null,
      isPinned: false,
      isArchived: false,
      missing: false,
      prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 },
    });
  });

  it('maps entry folder/pin/archive onto the row', () => {
    const r = reg({ entries: { s1: entry({ folder: 'Work', pinned: true, archived: true }) } });
    const { sessions } = reconcile(r, [store()], { now: NOW, autoArchiveDays: 0 });
    expect(sessions[0]).toMatchObject({ folder: 'Work', isPinned: true, isArchived: true });
  });

  it('does not create entries for untouched store sessions (lazy entries)', () => {
    const { registry } = reconcile(reg(), [store(), store({ id: 's2' })], {
      now: NOW,
      autoArchiveDays: 0,
    });
    expect(Object.keys(registry.entries)).toHaveLength(0);
  });

  it('skips removed sessions entirely', () => {
    const r = reg({ entries: { s1: entry({ removed: true, removedAt: NOW }) } });
    const { sessions } = reconcile(r, [store()], { now: NOW, autoArchiveDays: 0 });
    expect(sessions).toHaveLength(0);
  });

  it('un-removes a session whose transcript was modified after removal', () => {
    const r = reg({
      entries: { s1: entry({ removed: true, removedAt: NOW - 2 * DAY }) },
    });
    const { registry, sessions, changed } = reconcile(r, [store()], {
      now: NOW,
      autoArchiveDays: 0,
    });
    expect(changed).toBe(true);
    expect(registry.entries.s1?.removed).toBe(false);
    expect(registry.entries.s1?.removedAt).toBeNull();
    expect(sessions).toHaveLength(1);
  });

  it('keeps a missing session only when pinned or foldered, flagged missing', () => {
    const r = reg({
      entries: {
        gone: entry({ id: 'gone', pinned: true, lastOpenedAt: NOW - 5 * DAY }),
        stray: entry({ id: 'stray' }),
      },
    });
    const { registry, sessions, changed } = reconcile(r, [], { now: NOW, autoArchiveDays: 0 });
    expect(changed).toBe(true);
    expect(registry.entries.stray).toBeUndefined();
    expect(registry.entries.gone).toBeDefined();
    const missingRow = sessions.find((s) => s.id === 'gone');
    expect(missingRow).toMatchObject({
      missing: true,
      title: '(transcript missing)',
      updatedAt: NOW - 5 * DAY,
      isPinned: true,
    });
  });

  it('keeps a missing foldered session too', () => {
    const r = reg({ entries: { gone: entry({ id: 'gone', folder: 'Work' }) } });
    const { sessions } = reconcile(r, [], { now: NOW, autoArchiveDays: 0 });
    expect(sessions.find((s) => s.id === 'gone')).toMatchObject({ missing: true, folder: 'Work' });
  });

  it('auto-archives idle, unpinned, unfoldered sessions when enabled', () => {
    const old = store({ lastModified: NOW - 31 * DAY });
    const { registry, sessions, changed } = reconcile(reg(), [old], {
      now: NOW,
      autoArchiveDays: 30,
    });
    expect(changed).toBe(true);
    expect(registry.entries['s1']).toMatchObject({ archived: true, archivedAt: NOW });
    expect(sessions[0]?.isArchived).toBe(true);
  });

  it('does not auto-archive when autoArchiveDays is 0', () => {
    const old = store({ lastModified: NOW - 365 * DAY });
    const { registry, sessions, changed } = reconcile(reg(), [old], {
      now: NOW,
      autoArchiveDays: 0,
    });
    expect(changed).toBe(false);
    expect(registry.entries['s1']).toBeUndefined();
    expect(sessions[0]?.isArchived).toBe(false);
  });

  it('does not auto-archive pinned or foldered sessions', () => {
    const r = reg({
      entries: {
        s1: entry({ pinned: true }),
        s2: entry({ id: 's2', folder: 'Work' }),
      },
    });
    const { registry } = reconcile(
      r,
      [store({ lastModified: NOW - 90 * DAY }), store({ id: 's2', lastModified: NOW - 90 * DAY })],
      { now: NOW, autoArchiveDays: 30 },
    );
    expect(registry.entries['s1']?.archived).toBe(false);
    expect(registry.entries['s2']?.archived).toBe(false);
  });

  it('suppresses auto-archive after a manual unarchive until the session is modified again', () => {
    const r = reg({
      entries: { s1: entry({ unarchivedAt: NOW - 40 * DAY }) },
    });
    // lastModified before unarchivedAt → suppressed
    const suppressed = reconcile(r, [store({ lastModified: NOW - 45 * DAY })], {
      now: NOW,
      autoArchiveDays: 30,
    });
    expect(suppressed.registry.entries['s1']?.archived).toBe(false);
    // Idle AND modified after unarchivedAt → eligible again
    const eligible = reconcile(r, [store({ lastModified: NOW - 35 * DAY })], {
      now: NOW,
      autoArchiveDays: 30,
    });
    expect(eligible.registry.entries['s1']?.archived).toBe(true);
  });

  it('is idempotent: a second reconcile changes nothing', () => {
    const input = [
      store({ lastModified: NOW - 31 * DAY }),
      store({ id: 's2', lastModified: NOW - DAY }),
    ];
    const r = reg({ entries: { stray: entry({ id: 'stray' }) } });
    const first = reconcile(r, input, { now: NOW, autoArchiveDays: 30 });
    const second = reconcile(first.registry, input, { now: NOW, autoArchiveDays: 30 });
    expect(second.changed).toBe(false);
    expect(second.registry).toBe(first.registry);
  });
});

describe('mutations', () => {
  it('setFolder creates the entry lazily and moves it', () => {
    const r = setFolder(reg(), 's1', 'Work');
    expect(r.entries['s1']).toMatchObject({ folder: 'Work' });
    expect(setFolder(r, 's1', null).entries['s1']?.folder).toBeNull();
  });

  it('setPinned toggles pinned', () => {
    expect(setPinned(reg(), 's1', true).entries['s1']?.pinned).toBe(true);
    expect(setPinned(reg(), 's1', false).entries['s1']?.pinned).toBe(false);
  });

  it('setArchived(true) is manual: no archivedAt marker', () => {
    const r = setArchived(reg(), 's1', true, NOW);
    expect(r.entries['s1']).toMatchObject({ archived: true, archivedAt: null });
  });

  it('setArchived(false) records unarchivedAt for auto-archive suppression', () => {
    const r = setArchived(reg(), 's1', false, NOW);
    expect(r.entries['s1']).toMatchObject({ archived: false, unarchivedAt: NOW });
  });

  it('setRemoved marks removal with a timestamp', () => {
    const r = setRemoved(reg(), 's1', NOW);
    expect(r.entries['s1']).toMatchObject({ removed: true, removedAt: NOW });
  });

  it('touchOpened records lastOpenedAt', () => {
    expect(touchOpened(reg(), 's1', NOW).entries['s1']?.lastOpenedAt).toBe(NOW);
  });
});

describe('folder ops', () => {
  it('folderCreate appends unseen names only', () => {
    const r = folderCreate(reg({ folders: ['A'] }), 'B');
    expect(r.folders).toEqual(['A', 'B']);
    expect(folderCreate(r, 'A').folders).toEqual(['A', 'B']);
  });

  it('folderRename renames the folder and its member entries', () => {
    const r = reg({
      folders: ['A', 'B'],
      entries: { s1: entry({ folder: 'A' }), s2: entry({ id: 's2', folder: 'B' }) },
    });
    const renamed = folderRename(r, 'A', 'Z');
    expect(renamed.folders).toEqual(['Z', 'B']);
    expect(renamed.entries['s1']?.folder).toBe('Z');
    expect(renamed.entries['s2']?.folder).toBe('B');
    expect(folderRename(r, 'nope', 'Z').folders).toEqual(['A', 'B']);
  });

  it('folderDelete removes the folder and unfolders its members', () => {
    const r = reg({
      folders: ['A'],
      entries: { s1: entry({ folder: 'A' }), s2: entry({ id: 's2' }) },
    });
    const deleted = folderDelete(r, 'A');
    expect(deleted.folders).toEqual([]);
    expect(deleted.entries['s1']?.folder).toBeNull();
    expect(deleted.entries['s2']?.folder).toBeNull();
  });

  it('folderReorder keeps unknown names appended', () => {
    const r = reg({ folders: ['A', 'B', 'C'] });
    expect(folderReorder(r, ['C', 'A']).folders).toEqual(['C', 'A', 'B']);
    expect(folderReorder(r, ['Z', 'B']).folders).toEqual(['B', 'A', 'C']);
  });
});
