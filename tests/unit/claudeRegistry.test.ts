import { describe, expect, it } from 'vitest';
import {
  ClaudeRegistrySchema,
  MAX_PRS_PER_SESSION,
  emptyRegistry,
  openPrsOf,
  prCountsFor,
  reconcile,
  recordPr,
  setArchived,
  setPinned,
  setPrState,
  setRemoved,
  touchOpened,
  type ClaudeRegistry,
  type ClaudeRegistryEntry,
  type ClaudeRegistryPr,
  type ClaudeStoreSession,
} from '../../src/core/claudeRegistry';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

const store = (over: Partial<ClaudeStoreSession> = {}): ClaudeStoreSession => ({
  id: 's1',
  host: 'local',
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
  host: 'local',
  pinned: false,
  archived: false,
  archivedAt: null,
  unarchivedAt: null,
  removed: false,
  removedAt: null,
  lastOpenedAt: null,
  prs: [],
  ...over,
});

const pr = (over: Partial<ClaudeRegistryPr> = {}): ClaudeRegistryPr => ({
  url: 'https://github.com/o/r/pull/1',
  state: null,
  seenAt: NOW,
  completedAt: null,
  source: 'chat',
  ...over,
});

const reg = (over: Partial<ClaudeRegistry> = {}): ClaudeRegistry => ({
  ...emptyRegistry(),
  ...over,
});

const URL1 = 'https://github.com/o/r/pull/1';
const URL2 = 'https://github.com/o/r/pull/2';

describe('ClaudeRegistrySchema', () => {
  it('round-trips a valid registry and drops unknown fields', () => {
    const parsed = ClaudeRegistrySchema.parse(reg());
    expect(parsed.legacyFolders).toBeUndefined();
    expect(parsed.version).toBe(1);
    const withExtra = ClaudeRegistrySchema.safeParse({
      version: 1,
      folders: [],
      entries: { s1: { ...entry(), bogus: true } },
      other: 42,
    });
    expect(withExtra.success).toBe(true);
    if (withExtra.success) expect('bogus' in withExtra.data.entries['s1']!).toBe(false);
  });

  it('round-trips the prs shape', () => {
    const item = pr({ state: 'merged', completedAt: NOW, source: 'hook' });
    const parsed = ClaudeRegistrySchema.parse(reg({ entries: { s1: entry({ prs: [item] }) } }));
    expect(parsed.entries['s1']?.prs).toEqual([item]);
  });

  it('migrates legacy prUrls into prs items', () => {
    const { prs: _drop, ...legacy } = entry();
    const parsed = ClaudeRegistrySchema.parse({
      version: 1,
      folders: [],
      entries: { s1: { ...legacy, prUrls: [URL1, URL2] }, s2: { ...legacy, id: 's2' } },
    });
    expect(parsed.entries['s1']?.prs).toEqual([
      { url: URL1, state: null, seenAt: 0, completedAt: null, source: 'chat' },
      { url: URL2, state: null, seenAt: 0, completedAt: null, source: 'chat' },
    ]);
    expect(parsed.entries['s1']).not.toHaveProperty('prUrls');
    expect(parsed.entries['s2']?.prs).toEqual([]);
  });

  it('rejects malformed prs items', () => {
    const bad = ClaudeRegistrySchema.safeParse({
      version: 1,
      folders: [],
      entries: { s1: { ...entry(), prs: [{ url: URL1, state: 'weird' }] } },
    });
    expect(bad.success).toBe(false);
  });
});

describe('reconcile', () => {
  it('emits one row per non-removed store session with defaults', () => {
    const { sessions, changed } = reconcile(reg(), [store()], { now: NOW, autoArchiveDays: 0, workspaces: [] });
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

  it('derives the workspace folder from host+cwd and maps pin/archive', () => {
    const r = reg({ entries: { s1: entry({ pinned: true, archived: true }) } });
    const { sessions } = reconcile(r, [store()], {
      now: NOW,
      autoArchiveDays: 0,
      workspaces: ['C:\\proj'],
    });
    expect(sessions[0]).toMatchObject({ folder: 'C:\\proj', isPinned: true, isArchived: true });
  });

  it('does not create entries for untouched store sessions (lazy entries)', () => {
    const { registry } = reconcile(reg(), [store(), store({ id: 's2' })], {
      now: NOW,
      autoArchiveDays: 0,
    workspaces: [],
    });
    expect(Object.keys(registry.entries)).toHaveLength(0);
  });

  it('skips removed sessions entirely', () => {
    const r = reg({ entries: { s1: entry({ removed: true, removedAt: NOW }) } });
    const { sessions } = reconcile(r, [store()], { now: NOW, autoArchiveDays: 0, workspaces: [] });
    expect(sessions).toHaveLength(0);
  });

  it('un-removes a session whose transcript was modified after removal', () => {
    const r = reg({
      entries: { s1: entry({ removed: true, removedAt: NOW - 2 * DAY }) },
    });
    const { registry, sessions, changed } = reconcile(r, [store()], {
      now: NOW,
      autoArchiveDays: 0,
    workspaces: [],
    });
    expect(changed).toBe(true);
    expect(registry.entries.s1?.removed).toBe(false);
    expect(registry.entries.s1?.removedAt).toBeNull();
    expect(sessions).toHaveLength(1);
  });

  it('keeps a missing session only when pinned, flagged missing', () => {
    const r = reg({
      entries: {
        gone: entry({ id: 'gone', pinned: true, lastOpenedAt: NOW - 5 * DAY }),
        stray: entry({ id: 'stray' }),
      },
    });
    const { registry, sessions, changed } = reconcile(r, [], { now: NOW, autoArchiveDays: 0, workspaces: [] });
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

  it('drops a missing session whose legacy folder cannot be derived (no cwd)', () => {
    const r = reg({ entries: { gone: entry({ id: 'gone', folder: 'Work' }) } });
    const { registry, sessions, changed } = reconcile(r, [], {
      now: NOW,
      autoArchiveDays: 0,
      workspaces: [],
    });
    expect(changed).toBe(true);
    expect(sessions.find((s) => s.id === 'gone')).toBeUndefined();
    expect(registry.entries.gone).toBeUndefined();
  });

  it('auto-archives idle, unpinned, unfoldered sessions when enabled', () => {
    const old = store({ lastModified: NOW - 31 * DAY });
    const { registry, sessions, changed } = reconcile(reg(), [old], {
      now: NOW,
      autoArchiveDays: 30,
    workspaces: [],
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
    workspaces: [],
    });
    expect(changed).toBe(false);
    expect(registry.entries['s1']).toBeUndefined();
    expect(sessions[0]?.isArchived).toBe(false);
  });

  it('does not auto-archive pinned or workspace-member sessions', () => {
    const r = reg({ entries: { s1: entry({ pinned: true }) } });
    const { registry } = reconcile(
      r,
      [
        store({ lastModified: NOW - 90 * DAY }),
        store({ id: 's2', cwd: 'C:\\ws', lastModified: NOW - 90 * DAY }),
      ],
      { now: NOW, autoArchiveDays: 30, workspaces: ['C:\\ws'] },
    );
    expect(registry.entries['s1']?.archived).toBe(false);
    // s2 is exempt via workspace membership — the lazy entry is never even
    // created (nothing else touched it).
    expect(registry.entries['s2']?.archived).toBeFalsy();
  });

  it('a session in a workspace sub-folder files under the workspace and is auto-archive exempt', () => {
    const { registry, sessions } = reconcile(
      reg(),
      [store({ cwd: 'C:\\ws\\one\\sub', lastModified: NOW - 90 * DAY })],
      { now: NOW, autoArchiveDays: 30, workspaces: ['C:\\ws\\one'] },
    );
    expect(sessions[0]?.folder).toBe('C:\\ws\\one');
    expect(registry.entries['s1']?.archived).toBeFalsy();
  });

  it('suppresses auto-archive after a manual unarchive until the session is modified again', () => {
    const r = reg({
      entries: { s1: entry({ unarchivedAt: NOW - 40 * DAY }) },
    });
    // lastModified before unarchivedAt → suppressed
    const suppressed = reconcile(r, [store({ lastModified: NOW - 45 * DAY })], {
      now: NOW,
      autoArchiveDays: 30,
    workspaces: [],
    });
    expect(suppressed.registry.entries['s1']?.archived).toBe(false);
    // Idle AND modified after unarchivedAt → eligible again
    const eligible = reconcile(r, [store({ lastModified: NOW - 35 * DAY })], {
      now: NOW,
      autoArchiveDays: 30,
    workspaces: [],
    });
    expect(eligible.registry.entries['s1']?.archived).toBe(true);
  });

  it('carries PR counts from the entry onto listed and missing rows', () => {
    const prs = [
      pr({ url: URL1 }),
      pr({ url: URL2, state: 'merged', completedAt: NOW }),
      pr({ url: 'https://github.com/o/r/pull/3', state: 'draft' }),
    ];
    const r = reg({
      entries: {
        s1: entry({ prs }),
        gone: entry({ id: 'gone', pinned: true, prs: [pr({ state: 'closed', completedAt: NOW })] }),
      },
    });
    const { sessions } = reconcile(r, [store()], { now: NOW, autoArchiveDays: 0, workspaces: [] });
    expect(sessions.find((s) => s.id === 's1')?.prs).toEqual({
      open: 1,
      queued: 0,
      draft: 1,
      merged: 1,
      closed: 0,
    });
    expect(sessions.find((s) => s.id === 'gone')).toMatchObject({
      missing: true,
      prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 1 },
    });
  });

  it('is idempotent: a second reconcile changes nothing', () => {
    const input = [
      store({ lastModified: NOW - 31 * DAY }),
      store({ id: 's2', lastModified: NOW - DAY }),
    ];
    const r = reg({ entries: { stray: entry({ id: 'stray' }) } });
    const first = reconcile(r, input, { now: NOW, autoArchiveDays: 30, workspaces: [] });
    const second = reconcile(first.registry, input, { now: NOW, autoArchiveDays: 30, workspaces: [] });
    expect(second.changed).toBe(false);
    expect(second.registry).toBe(first.registry);
  });
});

describe('mutations', () => {
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

describe('recordPr', () => {
  it('creates the entry lazily and appends a null-state PR', () => {
    const { registry, added } = recordPr(reg(), 's1', URL1, 'terminal', NOW);
    expect(added).toBe(true);
    expect(registry.entries['s1']).toMatchObject({ id: 's1', removed: false });
    expect(registry.entries['s1']?.prs).toEqual([
      { url: URL1, state: null, seenAt: NOW, completedAt: null, source: 'terminal' },
    ]);
  });

  it('dedupes by URL and only touches seenAt on a repeat', () => {
    const first = recordPr(reg(), 's1', URL1, 'chat', NOW).registry;
    const withState = setPrState(first, 's1', URL1, 'draft', NOW).registry;
    const { registry, added } = recordPr(withState, 's1', URL1, 'hook', NOW + 5);
    expect(added).toBe(false);
    expect(registry.entries['s1']?.prs).toEqual([
      { url: URL1, state: 'draft', seenAt: NOW + 5, completedAt: null, source: 'chat' },
    ]);
    expect(recordPr(registry, 's1', URL2, 'chat', NOW + 6).registry.entries['s1']?.prs).toHaveLength(2);
  });

  it('caps at MAX_PRS_PER_SESSION, dropping the oldest completed PR first', () => {
    let r = reg();
    for (let i = 0; i < MAX_PRS_PER_SESSION; i++) {
      r = recordPr(r, 's1', `https://github.com/o/r/pull/${i}`, 'chat', NOW + i).registry;
    }
    // Mark #5 and #9 completed; #5 is the oldest completed one.
    r = setPrState(r, 's1', 'https://github.com/o/r/pull/9', 'merged', NOW + 100).registry;
    r = setPrState(r, 's1', 'https://github.com/o/r/pull/5', 'closed', NOW + 100).registry;
    const { registry, added } = recordPr(r, 's1', 'https://github.com/o/r/pull/new', 'chat', NOW + 200);
    expect(added).toBe(true);
    const urls = registry.entries['s1']!.prs.map((p) => p.url);
    expect(urls).toHaveLength(MAX_PRS_PER_SESSION);
    expect(urls).not.toContain('https://github.com/o/r/pull/5');
    expect(urls).toContain('https://github.com/o/r/pull/0');
    expect(urls).toContain('https://github.com/o/r/pull/9');
    expect(urls).toContain('https://github.com/o/r/pull/new');
  });

  it('caps at MAX_PRS_PER_SESSION, dropping the oldest overall when none are completed', () => {
    let r = reg();
    for (let i = 0; i < MAX_PRS_PER_SESSION; i++) {
      r = recordPr(r, 's1', `https://github.com/o/r/pull/${i}`, 'chat', NOW + i).registry;
    }
    // Re-seeing #0 makes it the newest, so #1 becomes the oldest.
    r = recordPr(r, 's1', 'https://github.com/o/r/pull/0', 'chat', NOW + 50).registry;
    const { registry } = recordPr(r, 's1', 'https://github.com/o/r/pull/new', 'chat', NOW + 60);
    const urls = registry.entries['s1']!.prs.map((p) => p.url);
    expect(urls).toHaveLength(MAX_PRS_PER_SESSION);
    expect(urls).not.toContain('https://github.com/o/r/pull/1');
    expect(urls).toContain('https://github.com/o/r/pull/0');
    expect(urls).toContain('https://github.com/o/r/pull/new');
  });
});

describe('setPrState', () => {
  it('returns the same registry when the entry or PR is unknown', () => {
    const r = recordPr(reg(), 's1', URL1, 'chat', NOW).registry;
    expect(setPrState(reg(), 's1', URL1, 'open', NOW)).toEqual({ registry: reg(), completed: false });
    expect(setPrState(r, 's1', URL2, 'open', NOW).registry).toBe(r);
    expect(setPrState(r, 's2', URL1, 'open', NOW).registry).toBe(r);
  });

  it('sets the state without completing for open/draft', () => {
    const r = recordPr(reg(), 's1', URL1, 'chat', NOW).registry;
    const { registry, completed } = setPrState(r, 's1', URL1, 'draft', NOW + 1);
    expect(completed).toBe(false);
    expect(registry.entries['s1']?.prs[0]).toMatchObject({ state: 'draft', completedAt: null });
  });

  it('returns the same registry object when the state is unchanged', () => {
    const r = setPrState(recordPr(reg(), 's1', URL1, 'chat', NOW).registry, 's1', URL1, 'open', NOW).registry;
    expect(setPrState(r, 's1', URL1, 'open', NOW + 1).registry).toBe(r);
    const fresh = recordPr(reg(), 's1', URL1, 'chat', NOW).registry;
    expect(setPrState(fresh, 's1', URL1, null, NOW).registry).toBe(fresh);
  });

  it('reports completed exactly once when the state becomes merged|closed', () => {
    const r = recordPr(reg(), 's1', URL1, 'chat', NOW).registry;
    const merged = setPrState(r, 's1', URL1, 'merged', NOW + 1);
    expect(merged.completed).toBe(true);
    expect(merged.registry.entries['s1']?.prs[0]).toMatchObject({ state: 'merged', completedAt: NOW + 1 });
    // merged → closed is a state change but not a second completion
    const closed = setPrState(merged.registry, 's1', URL1, 'closed', NOW + 2);
    expect(closed.completed).toBe(false);
    expect(closed.registry.entries['s1']?.prs[0]).toMatchObject({ state: 'closed', completedAt: NOW + 1 });
    // reopened then merged again: completedAt already set → no second notification
    const reopened = setPrState(closed.registry, 's1', URL1, 'open', NOW + 3);
    expect(reopened.completed).toBe(false);
    expect(setPrState(reopened.registry, 's1', URL1, 'merged', NOW + 4).completed).toBe(false);
  });

  it('does not touch sibling PRs or other entries', () => {
    let r = recordPr(reg(), 's1', URL1, 'chat', NOW).registry;
    r = recordPr(r, 's1', URL2, 'chat', NOW + 1).registry;
    r = recordPr(r, 's2', URL1, 'chat', NOW + 2).registry;
    const { registry } = setPrState(r, 's1', URL1, 'closed', NOW + 3);
    expect(registry.entries['s1']?.prs[1]).toEqual(r.entries['s1']?.prs[1]);
    expect(registry.entries['s2']).toBe(r.entries['s2']);
  });
});

describe('prCountsFor', () => {
  it('maps states to badge counts with unknown as open and queued 0', () => {
    expect(prCountsFor(undefined)).toEqual({ open: 0, queued: 0, draft: 0, merged: 0, closed: 0 });
    expect(prCountsFor(entry())).toEqual({ open: 0, queued: 0, draft: 0, merged: 0, closed: 0 });
    const e = entry({
      prs: [
        pr({ url: 'a', state: null }),
        pr({ url: 'b', state: 'open' }),
        pr({ url: 'c', state: 'draft' }),
        pr({ url: 'd', state: 'merged' }),
        pr({ url: 'e', state: 'merged' }),
        pr({ url: 'f', state: 'closed' }),
      ],
    });
    expect(prCountsFor(e)).toEqual({ open: 2, queued: 0, draft: 1, merged: 2, closed: 1 });
  });
});

describe('openPrsOf', () => {
  it('lists in-flight PRs of non-removed entries, newest seenAt first', () => {
    const r = reg({
      entries: {
        s1: entry({
          prs: [
            pr({ url: 'a', state: null, seenAt: NOW + 1 }),
            pr({ url: 'b', state: 'merged', seenAt: NOW + 9, completedAt: NOW + 9 }),
            pr({ url: 'c', state: 'draft', seenAt: NOW + 3 }),
          ],
        }),
        s2: entry({
          id: 's2',
          archived: true,
          prs: [pr({ url: 'd', state: 'open', seenAt: NOW + 2 }), pr({ url: 'e', state: 'closed', seenAt: NOW + 8 })],
        }),
        s3: entry({
          id: 's3',
          removed: true,
          removedAt: NOW,
          prs: [pr({ url: 'f', state: 'open', seenAt: NOW + 10 })],
        }),
      },
    });
    expect(openPrsOf(r).map((x) => [x.sessionId, x.pr.url])).toEqual([
      ['s1', 'c'],
      ['s2', 'd'],
      ['s1', 'a'],
    ]);
  });

  it('breaks seenAt ties by url for a stable order', () => {
    const r = reg({
      entries: {
        s1: entry({ prs: [pr({ url: 'z', seenAt: NOW })] }),
        s2: entry({ id: 's2', prs: [pr({ url: 'a', seenAt: NOW })] }),
      },
    });
    expect(openPrsOf(r).map((x) => x.pr.url)).toEqual(['a', 'z']);
    expect(openPrsOf(reg())).toEqual([]);
  });
});

describe('host', () => {
  it('legacy registry entries without host parse as local', () => {
    const raw = {
      version: 1,
      folders: [],
      entries: {
        s1: {
          id: 's1',
          folder: null,
          pinned: false,
          archived: false,
          archivedAt: null,
          unarchivedAt: null,
          removed: false,
          removedAt: null,
          lastOpenedAt: null,
          prs: [],
        },
      },
    };
    const parsed = ClaudeRegistrySchema.parse(raw);
    expect(parsed.entries['s1']?.host).toBe('local');
  });

  it('reconcile carries the store row host into the session row', () => {
    const { sessions } = reconcile(emptyRegistry(), [store({ host: 'wsl:Ubuntu-22.04' })], {
      now: NOW,
      autoArchiveDays: 0,
    workspaces: [],
    });
    expect(sessions[0]?.host).toBe('wsl:Ubuntu-22.04');
  });

  it('missing pinned rows carry the entry host', () => {
    const r = reg({ entries: { s1: entry({ host: 'wsl:Ubuntu-22.04', pinned: true }) } });
    const { sessions } = reconcile(r, [], { now: NOW, autoArchiveDays: 0, workspaces: [] });
    expect(sessions[0]?.host).toBe('wsl:Ubuntu-22.04');
  });
});
