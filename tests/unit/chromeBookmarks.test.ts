import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFavoritesMenu,
  isValidProfileDir,
  parseChromeBookmarks,
  parseLocalState,
  type BookmarkNode,
  type BookmarkTree,
  type FavoritesMenuNode,
} from '../../src/core/chromeBookmarks';

const dir = join(__dirname, '..', 'fixtures', 'chrome-user-data');
const load = (p: string): unknown => JSON.parse(readFileSync(join(dir, p), 'utf8'));
const u = (name: string, url: string): BookmarkNode => ({ kind: 'url', name, url });
const tree = (bar: BookmarkNode[], other: BookmarkNode[] = [], mobile: BookmarkNode[] = []): BookmarkTree => ({
  bar,
  other,
  mobile,
});
const folderOf = (nodes: FavoritesMenuNode[], label: string) => {
  const f = nodes.find((n) => n.kind === 'folder' && n.label === label);
  if (!f || f.kind !== 'folder') throw new Error(`no folder ${label}`);
  return f;
};

describe('parseChromeBookmarks', () => {
  it('parses the fixture and preserves nesting of 3+ levels', () => {
    const t = parseChromeBookmarks(load('Profile 1/Bookmarks'))!;
    expect(t.bar[0]).toEqual({ kind: 'url', name: 'Example', url: 'https://example.com/' });
    const work = t.bar.find((n) => n.name === 'Work')!;
    const projects = work.children!.find((n) => n.name === 'Projects')!;
    const deep = projects.children!.find((n) => n.name === 'Deep')!;
    expect(deep.children![0]).toEqual({ kind: 'url', name: 'Deep link', url: 'https://example.com/deep' });
    expect(t.other).toHaveLength(1);
    expect(t.mobile).toEqual([]);
  });

  it('maps synced to mobile and skips unknown node types', () => {
    const t = parseChromeBookmarks({
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'b',
          children: [
            { type: 'weird', name: 'x' },
            { type: 'url', name: 'a', url: 'https://a.test/' },
          ],
        },
        synced: { type: 'folder', name: 's', children: [{ type: 'url', name: 'm', url: 'https://m.test/' }] },
      },
    })!;
    expect(t.bar).toEqual([{ kind: 'url', name: 'a', url: 'https://a.test/' }]);
    expect(t.mobile).toEqual([{ kind: 'url', name: 'm', url: 'https://m.test/' }]);
    expect(t.other).toEqual([]);
  });

  it('returns null for malformed or partial input', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { roots: null }, { roots: 'x' }, { roots: {} }]) {
      expect(parseChromeBookmarks(bad)).toBeNull();
    }
  });
});

describe('buildFavoritesMenu', () => {
  it('skips javascript:, chrome:, file:, data: urls and drops emptied folders', () => {
    const t = parseChromeBookmarks(load('Profile 1/Bookmarks'))!;
    const json = JSON.stringify(buildFavoritesMenu(t));
    expect(json).not.toContain('javascript:');
    expect(json).not.toContain('chrome://');
    const menu = buildFavoritesMenu(
      tree([
        u('f', 'file:///etc/passwd'),
        u('d', 'data:text/html,hi'),
        { kind: 'folder', name: 'Bad', children: [u('c', 'chrome://settings')] },
        u('ok', 'https://ok.test/'),
      ]),
    );
    expect(menu).toEqual([{ kind: 'url', label: 'ok', url: 'https://ok.test/' }]);
  });

  it('drops urls carrying a username or password', () => {
    const menu = buildFavoritesMenu(
      tree([
        u('user', 'https://me@example.com/'),
        u('pass', 'https://me:secret@example.com/'),
        u('ok', 'https://ok.test/'),
      ]),
    );
    expect(menu).toEqual([{ kind: 'url', label: 'ok', url: 'https://ok.test/' }]);
  });

  it('keeps the 3-deep link from the fixture', () => {
    const menu = buildFavoritesMenu(parseChromeBookmarks(load('Profile 1/Bookmarks'))!);
    const deep = folderOf(folderOf(folderOf(menu, 'Work').children, 'Projects').children, 'Deep');
    expect(deep.children).toEqual([{ kind: 'url', label: 'Deep link', url: 'https://example.com/deep' }]);
  });

  it('caps a folder at 200 and appends a more node', () => {
    const menu = buildFavoritesMenu(parseChromeBookmarks(load('Profile 1/Bookmarks'))!);
    const many = folderOf(menu, 'Many').children;
    expect(many).toHaveLength(201);
    expect(many[199]).toEqual({ kind: 'url', label: 'Item 200', url: 'https://example.com/many/200' });
    expect(many[200]).toEqual({ kind: 'more', label: '… 50 more' });
  });

  it('caps the top level too', () => {
    const bar = Array.from({ length: 250 }, (_, i) => u(`n${i}`, `https://x.test/${i}`));
    const menu = buildFavoritesMenu(tree(bar));
    expect(menu).toHaveLength(201);
    expect(menu[200]).toEqual({ kind: 'more', label: '… 50 more' });
  });

  it('honours maxPerFolder', () => {
    const menu = buildFavoritesMenu(tree([u('a', 'https://a.test/'), u('b', 'https://b.test/'), u('c', 'https://c.test/')]), {
      maxPerFolder: 2,
    });
    expect(menu.map((n) => n.kind)).toEqual(['url', 'url', 'more']);
    expect(menu[2]).toEqual({ kind: 'more', label: '… 1 more' });
  });

  it('lists bar items, then Other and Mobile bookmarks folders, omitting empty ones', () => {
    const menu = buildFavoritesMenu(tree([u('a', 'https://a.test/')], [u('o', 'https://o.test/')], [u('m', 'https://m.test/')]));
    expect(menu.map((n) => n.label)).toEqual(['a', 'Other bookmarks', 'Mobile bookmarks']);
    expect(buildFavoritesMenu(tree([], [u('o', 'https://o.test/')])).map((n) => n.label)).toEqual(['Other bookmarks']);
    expect(buildFavoritesMenu(tree([], [], []))).toEqual([]);
  });

  it('truncates labels to 80 chars including the ellipsis', () => {
    const label = buildFavoritesMenu(tree([u('x'.repeat(200), 'https://a.test/')]))[0]!.label;
    expect(label).toHaveLength(80);
    expect(label.endsWith('…')).toBe(true);
    expect(buildFavoritesMenu(tree([u('y'.repeat(80), 'https://a.test/')]))[0]!.label).toBe('y'.repeat(80));
    expect(buildFavoritesMenu(tree([u('x'.repeat(30), 'https://a.test/')]), { maxLabel: 10 })[0]!.label).toBe(
      'x'.repeat(9) + '…',
    );
  });

  it('escapes & as && after truncation', () => {
    expect(buildFavoritesMenu(tree([u('Q&A', 'https://a.test/')]))[0]!.label).toBe('Q&&A');
    // Truncation counts raw chars (79 + "…"); each & then doubles.
    expect(buildFavoritesMenu(tree([u('&'.repeat(100), 'https://a.test/')]))[0]!.label).toBe('&&'.repeat(79) + '…');
  });

  it('uses the hostname for an empty or blank url name and a placeholder for folders', () => {
    const menu = buildFavoritesMenu(
      tree([
        u('', 'https://www.example.com/p'),
        u('   ', 'https://b.test/'),
        { kind: 'folder', name: ' ', children: [u('z', 'https://z.test/')] },
      ]),
    );
    expect(menu.map((n) => n.label)).toEqual(['www.example.com', 'b.test', '(untitled folder)']);
  });

  it('shows the Default profile fixture tree', () => {
    const menu = buildFavoritesMenu(parseChromeBookmarks(load('Default/Bookmarks'))!);
    expect(menu).toEqual([{ kind: 'url', label: 'Default link', url: 'https://example.org/default' }]);
  });
});

describe('parseLocalState', () => {
  it('returns valid profiles sorted with lastUsed', () => {
    expect(parseLocalState(load('Local State'))).toEqual({
      profiles: [
        { dir: 'Default', name: 'Person 1' },
        { dir: 'Profile 1', name: 'Work' },
      ],
      lastUsed: 'Profile 1',
    });
  });

  it('sorts Profile N numerically and nulls an invalid last_used', () => {
    const r = parseLocalState({
      profile: {
        info_cache: { 'Profile 10': { name: 'ten' }, 'Profile 2': { name: 'two' }, Default: { name: 'd' } },
        last_used: 'Guest Profile',
      },
    });
    expect(r.profiles.map((p) => p.dir)).toEqual(['Default', 'Profile 2', 'Profile 10']);
    expect(r.lastUsed).toBeNull();
  });

  it('falls back to the dir for a missing name and tolerates garbage', () => {
    expect(parseLocalState({ profile: { info_cache: { Default: {} } } }).profiles).toEqual([
      { dir: 'Default', name: 'Default' },
    ]);
    for (const bad of [null, 'x', [], {}, { profile: 3 }]) {
      expect(parseLocalState(bad)).toEqual({ profiles: [], lastUsed: null });
    }
  });
});

describe('tolerance and edge cases', () => {
  it('keeps valid profiles when last_used is the wrong type', () => {
    const r = parseLocalState({ profile: { info_cache: { Default: { name: 'A' } }, last_used: 5 } });
    expect(r).toEqual({ profiles: [{ dir: 'Default', name: 'A' }], lastUsed: null });
  });

  it('survives a non-object profile and a non-object info_cache', () => {
    expect(parseLocalState({ profile: 'x' })).toEqual({ profiles: [], lastUsed: null });
    expect(parseLocalState({ profile: [] })).toEqual({ profiles: [], lastUsed: null });
    // lastUsed is returned whenever it is a valid profile dir, even if not listed.
    expect(parseLocalState({ profile: { info_cache: [], last_used: 'Profile 2' } })).toEqual({
      profiles: [],
      lastUsed: 'Profile 2',
    });
    expect(parseLocalState({ profile: { info_cache: 'x', last_used: 'Default' } }).profiles).toEqual([]);
  });

  it('does not split a surrogate pair when truncating', () => {
    const label = buildFavoritesMenu(tree([u('a'.repeat(8) + '😀'.repeat(5), 'https://a.test/')]), { maxLabel: 10 })[0]!.label;
    expect(label).toBe('a'.repeat(8) + '😀' + '…');
    expect(Array.from(label)).toHaveLength(10);
  });

  it('drops nesting beyond the depth guard without throwing', () => {
    let node: Record<string, unknown> = { type: 'url', name: 'deepest', url: 'https://d.test/' };
    for (let i = 0; i < 40; i++) node = { type: 'folder', name: `f${i}`, children: [node] };
    const t = parseChromeBookmarks({ roots: { bookmark_bar: { type: 'folder', name: 'b', children: [node] } } })!;
    expect(JSON.stringify(t)).not.toContain('deepest');
    expect(t.bar).toHaveLength(1);
  });

  it('applies the cap after filtering', () => {
    const items: BookmarkNode[] = [];
    for (let i = 0; i < 250; i++) {
      items.push(u(`i${i}`, i % 10 === 0 ? 'javascript:void(0)' : i % 10 === 1 ? 'chrome://x' : `https://x.test/${i}`));
    }
    // 50 filtered out leaves exactly 200 valid: no "more"; 7 extra valid -> "… 7 more".
    const exact = folderOf(buildFavoritesMenu(tree([{ kind: 'folder', name: 'F', children: items }])), 'F').children;
    expect(exact).toHaveLength(200);
    expect(exact.some((n) => n.kind === 'more')).toBe(false);
    const extra = Array.from({ length: 7 }, (_, i) => u(`e${i}`, `https://e.test/${i}`));
    const over = folderOf(buildFavoritesMenu(tree([{ kind: 'folder', name: 'F', children: [...items, ...extra] }])), 'F').children;
    expect(over).toHaveLength(201);
    expect(over[200]).toEqual({ kind: 'more', label: '… 7 more' });
  });
});

describe('isValidProfileDir', () => {
  it('accepts Default and Profile N only', () => {
    for (const ok of ['Default', 'Profile 1', 'Profile 12']) expect(isValidProfileDir(ok)).toBe(true);
    for (const bad of ['Profile 0', 'Profile 007', 'Profile 1234567','Guest Profile', 'System Profile', '../x', 'Profile x', 'Profile ', 'profile 1', 'Default/..', '']) {
      expect(isValidProfileDir(bad)).toBe(false);
    }
  });
});
