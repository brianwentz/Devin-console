import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chromeUserDataDir,
  createBookmarksReader,
  type BookmarksLoadLog,
  type BookmarksReaderDeps,
} from '../../src/core/bookmarksReader';

const FIXTURE = join(__dirname, '..', 'fixtures', 'chrome-user-data');
const fixture = (...parts: string[]): string => readFileSync(join(FIXTURE, ...parts), 'utf8');

const ROOT = join('C:', 'fake', 'User Data');
const LOCAL_STATE = join(ROOT, 'Local State');
const DEFAULT_BM = join(ROOT, 'Default', 'Bookmarks');
const WORK_BM = join(ROOT, 'Profile 1', 'Bookmarks');

const ALLOWED_DEPS = new Set(['userDataDir', 'readFile', 'stat', 'profileSetting', 'log', 'now']);

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

function bookmarksJson(urls: string[]): string {
  return JSON.stringify({
    roots: {
      bookmark_bar: { type: 'folder', name: 'Bar', children: urls.map((url, i) => ({ type: 'url', name: `n${i}`, url })) },
      other: { type: 'folder', children: [] },
      synced: { type: 'folder', children: [] },
    },
  });
}

// In-memory fake fs. Every property access on the deps object is recorded, so the
// tests can prove the reader never reaches for anything beyond read + stat.
function fakeFs(initial: Record<string, string>) {
  const files = new Map<string, { text: string; mtimeMs: number; size?: number }>();
  let clock = 1000;
  const put = (path: string, text: string) => files.set(path, { text, mtimeMs: (clock += 1000) });
  for (const [p, t] of Object.entries(initial)) put(p, t);
  const reads: string[] = [];
  const logs: BookmarksLoadLog[] = [];
  const accessed = new Set<string>();
  let dir: string | null = ROOT;
  let setting: string | null = null;
  const deps: BookmarksReaderDeps = {
    userDataDir: () => dir,
    readFile: async (path) => {
      reads.push(path);
      const f = files.get(path);
      if (!f) throw enoent(path);
      return f.text;
    },
    stat: async (path) => {
      const f = files.get(path);
      if (!f) throw enoent(path);
      return { mtimeMs: f.mtimeMs, size: f.size ?? Buffer.byteLength(f.text) };
    },
    profileSetting: () => setting,
    log: (event, detail) => {
      expect(event).toBe('bookmarks-load');
      logs.push(detail);
    },
  };
  const spied = new Proxy(deps, {
    get(target, key, receiver) {
      accessed.add(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    deps: spied,
    put,
    // Same size and mtime as before: Chrome did not touch the file.
    replaceKeepingStamp(path: string, text: string) {
      const f = files.get(path)!;
      files.set(path, { text, mtimeMs: f.mtimeMs, size: f.size ?? Buffer.byteLength(f.text) });
    },
    // Same mtime, new content and its real size (a coarse-mtime filesystem).
    replaceKeepingMtime(path: string, text: string) {
      const f = files.get(path)!;
      files.set(path, { text, mtimeMs: f.mtimeMs, size: Buffer.byteLength(text) });
    },
    remove: (path: string) => files.delete(path),
    reads,
    logs,
    accessed,
    setDir: (d: string | null) => (dir = d),
    setSetting: (s: string | null) => (setting = s),
  };
}

function standardFs() {
  return fakeFs({
    [LOCAL_STATE]: fixture('Local State'),
    [DEFAULT_BM]: fixture('Default', 'Bookmarks'),
    [WORK_BM]: fixture('Profile 1', 'Bookmarks'),
  });
}

const firstBarUrl = (r: Awaited<ReturnType<ReturnType<typeof createBookmarksReader>['load']>>) =>
  r.state === 'ok' ? r.tree.bar[0]?.url : undefined;

describe('createBookmarksReader — profile selection', () => {
  it('uses last_used from Local State when no profile is configured', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    const result = await reader.load();
    expect(result.state).toBe('ok');
    expect(fs.reads).toContain(WORK_BM);
    expect(fs.reads).not.toContain(DEFAULT_BM);
  });

  it('the configured profile wins when Local State lists it', async () => {
    const fs = standardFs();
    fs.setSetting('Default');
    const result = await createBookmarksReader(fs.deps).load();
    expect(firstBarUrl(result)).toBe('https://example.org/default');
    expect(fs.reads).not.toContain(WORK_BM);
  });

  it('a configured profile that is no longer listed falls back to last used (setting untouched)', async () => {
    const fs = standardFs();
    fs.setSetting('Profile 7');
    const reader = createBookmarksReader(fs.deps);
    const result = await reader.load();
    expect(result.state).toBe('ok');
    expect(fs.reads).toContain(WORK_BM);
    expect(fs.reads.some((p) => p.includes('Profile 7'))).toBe(false);
    expect(fs.deps.profileSetting()).toBe('Profile 7');
  });

  it('falls back to Default when last_used is not listed', async () => {
    const state = JSON.parse(fixture('Local State'));
    state.profile.last_used = 'Profile 9';
    const fs = fakeFs({ [LOCAL_STATE]: JSON.stringify(state), [DEFAULT_BM]: fixture('Default', 'Bookmarks') });
    const result = await createBookmarksReader(fs.deps).load();
    expect(firstBarUrl(result)).toBe('https://example.org/default');
  });

  it('profiles() lists Local State profiles (Guest filtered)', async () => {
    const fs = standardFs();
    expect(await createBookmarksReader(fs.deps).profiles()).toEqual([
      { dir: 'Default', name: 'Person 1' },
      { dir: 'Profile 1', name: 'Work' },
    ]);
  });

  it('profiles() is empty when Chrome is not found', async () => {
    const fs = standardFs();
    fs.setDir(null);
    expect(await createBookmarksReader(fs.deps).profiles()).toEqual([]);
    const none = fakeFs({});
    expect(await createBookmarksReader(none.deps).profiles()).toEqual([]);
  });

  it('caches per profile path: switching profiles never serves the other profile’s tree', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    await reader.load();
    fs.setSetting('Default');
    expect(firstBarUrl(await reader.load())).toBe('https://example.org/default');
    fs.setSetting(null);
    const back = await reader.load();
    expect(firstBarUrl(back)).not.toBe('https://example.org/default');
    expect(fs.reads.filter((p) => p === WORK_BM)).toHaveLength(1);
  });
});

describe('createBookmarksReader — cache', () => {
  it('unchanged mtime and size → cached tree, no re-read', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    const first = await reader.load();
    // Content changes but the stamp does not: the reader must not re-read.
    fs.replaceKeepingStamp(WORK_BM, bookmarksJson(['https://example.org/changed']));
    const second = await reader.load();
    expect(second).toEqual(first);
    expect(fs.reads.filter((p) => p === WORK_BM)).toHaveLength(1);
    expect(fs.reads.filter((p) => p === LOCAL_STATE)).toHaveLength(1);
    expect(fs.logs.map((l) => l.cached)).toEqual([false, true]);
  });

  it('a changed stamp re-reads and re-parses', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    await reader.load();
    fs.put(WORK_BM, bookmarksJson(['https://example.org/new']));
    expect(firstBarUrl(await reader.load())).toBe('https://example.org/new');
    expect(fs.reads.filter((p) => p === WORK_BM)).toHaveLength(2);
  });

  it('same mtime but a changed size → re-reads the new content', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    await reader.load();
    const text = bookmarksJson(['https://example.org/resized']);
    expect(Buffer.byteLength(text)).not.toBe(Buffer.byteLength(fixture('Profile 1', 'Bookmarks')));
    fs.replaceKeepingMtime(WORK_BM, text);
    expect(firstBarUrl(await reader.load())).toBe('https://example.org/resized');
    expect(fs.reads.filter((p) => p === WORK_BM)).toHaveLength(2);
  });

  it('partial JSON after a good read → the last good tree is returned', async () => {
    const fs = fakeFs({ [LOCAL_STATE]: fixture('Local State'), [WORK_BM]: bookmarksJson(['https://example.org/good']) });
    const reader = createBookmarksReader(fs.deps);
    expect(firstBarUrl(await reader.load())).toBe('https://example.org/good');
    const full = bookmarksJson(['https://example.org/good', 'https://example.org/next']);
    fs.put(WORK_BM, full.slice(0, Math.floor(full.length / 2)));
    const during = await reader.load();
    expect(firstBarUrl(during)).toBe('https://example.org/good');
    expect(fs.logs.at(-1)).toMatchObject({ ok: true, cached: true, count: 1 });
    // Chrome finishes writing: the next open picks the new file up.
    fs.put(WORK_BM, full);
    const after = await reader.load();
    expect(after.state === 'ok' && after.tree.bar.map((n) => n.url)).toEqual([
      'https://example.org/good',
      'https://example.org/next',
    ]);
  });

  it('a partial Local State after a good read keeps the last good profile list', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    await reader.load();
    fs.put(LOCAL_STATE, fixture('Local State').slice(0, 40));
    expect(await reader.profiles()).toEqual([
      { dir: 'Default', name: 'Person 1' },
      { dir: 'Profile 1', name: 'Work' },
    ]);
    await reader.load();
    expect(fs.reads.at(-1)).toBe(LOCAL_STATE);
    // Still last_used (Profile 1) from the last good Local State; its tree is cached.
    expect(fs.reads.filter((p) => p === WORK_BM)).toHaveLength(1);
  });
});

describe('createBookmarksReader — states', () => {
  it('no user-data dir → missing', async () => {
    const fs = standardFs();
    fs.setDir(null);
    expect(await createBookmarksReader(fs.deps).load()).toEqual({ state: 'missing' });
    expect(fs.logs).toEqual([{ ok: false, count: 0, ms: expect.any(Number), cached: false }]);
  });

  it('no Local State → missing', async () => {
    const fs = fakeFs({ [DEFAULT_BM]: fixture('Default', 'Bookmarks') });
    expect(await createBookmarksReader(fs.deps).load()).toEqual({ state: 'missing' });
  });

  it('profile without a Bookmarks file → missing', async () => {
    const fs = fakeFs({ [LOCAL_STATE]: fixture('Local State') });
    expect(await createBookmarksReader(fs.deps).load()).toEqual({ state: 'missing' });
  });

  it('a deleted Bookmarks file after a good read → missing', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    await reader.load();
    fs.remove(WORK_BM);
    expect(await reader.load()).toEqual({ state: 'missing' });
  });

  it('garbled Bookmarks with no last good tree → unreadable', async () => {
    const fs = fakeFs({ [LOCAL_STATE]: fixture('Local State'), [WORK_BM]: '{"roots": {' });
    expect(await createBookmarksReader(fs.deps).load()).toEqual({ state: 'unreadable' });
    const notBookmarks = fakeFs({ [LOCAL_STATE]: fixture('Local State'), [WORK_BM]: '{"hello":1}' });
    expect(await createBookmarksReader(notBookmarks.deps).load()).toEqual({ state: 'unreadable' });
  });

  it('an empty tree is still ok', async () => {
    const fs = fakeFs({ [LOCAL_STATE]: fixture('Local State'), [WORK_BM]: bookmarksJson([]) });
    const result = await createBookmarksReader(fs.deps).load();
    expect(result).toEqual({ state: 'ok', tree: { bar: [], other: [], mobile: [] } });
    expect(fs.logs[0]).toMatchObject({ ok: true, count: 0 });
  });

  it('logs only ok/count/ms/cached — count is the total url nodes', async () => {
    const fs = standardFs();
    const result = await createBookmarksReader(fs.deps).load();
    expect(result.state).toBe('ok');
    expect(fs.logs).toHaveLength(1);
    expect(Object.keys(fs.logs[0]!).sort()).toEqual(['cached', 'count', 'ms', 'ok']);
    expect(fs.logs[0]!.count).toBeGreaterThan(1);
    const text = JSON.stringify(fs.logs);
    expect(text).not.toMatch(/Profile|Default|Work|http|User Data/);
  });
});

describe('read-only guarantee', () => {
  it('the reader touches nothing on its deps beyond read/stat/setting/log', async () => {
    const fs = standardFs();
    const reader = createBookmarksReader(fs.deps);
    await reader.load();
    await reader.profiles();
    fs.put(WORK_BM, '{');
    await reader.load();
    for (const key of fs.accessed) expect(ALLOWED_DEPS.has(key), `unexpected dep access: ${key}`).toBe(true);
  });

  it('the core reader imports no fs at all', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'core', 'bookmarksReader.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
    expect(src).not.toMatch(/require\(/);
  });

  it('the real-fs wiring imports only readFile and stat from fs/promises', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'bookmarks.ts'), 'utf8');
    const fsImports = [...src.matchAll(/import\s+(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/g)];
    expect(fsImports).toHaveLength(1);
    expect(fsImports[0]![1]!.split(',').map((s) => s.trim()).filter(Boolean).sort()).toEqual(['readFile', 'stat']);
    expect(src).toMatch(/from ['"]node:fs\/promises['"]/);
    expect(src).not.toMatch(/\b(writeFile|appendFile|mkdir|rmdir|unlink|rename|copyFile|createWriteStream|truncate|chmod|utimes)\b/);
    expect(src).not.toMatch(/require\(/);
  });
});

describe('chromeUserDataDir', () => {
  it('win32 uses LOCALAPPDATA', () => {
    expect(chromeUserDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\H', testMode: false })).toBe(
      join('C:\\L', 'Google', 'Chrome', 'User Data'),
    );
    expect(chromeUserDataDir({ platform: 'win32', env: {}, home: 'C:\\H', testMode: false })).toBeNull();
  });
  it('darwin uses ~/Library/Application Support', () => {
    expect(chromeUserDataDir({ platform: 'darwin', env: {}, home: '/Users/u', testMode: false })).toBe(
      join('/Users/u', 'Library', 'Application Support', 'Google', 'Chrome'),
    );
  });
  it('other platforms → null', () => {
    expect(chromeUserDataDir({ platform: 'linux', env: {}, home: '/home/u', testMode: false })).toBeNull();
  });
  it('the test override applies in test mode only', () => {
    const env = { AGENT_WORKSPACE_TEST_CHROME_USER_DATA: 'X:\\fixture', LOCALAPPDATA: 'C:\\L' };
    expect(chromeUserDataDir({ platform: 'win32', env, home: '', testMode: true })).toBe('X:\\fixture');
    expect(chromeUserDataDir({ platform: 'win32', env, home: '', testMode: false })).toBe(
      join('C:\\L', 'Google', 'Chrome', 'User Data'),
    );
  });
});
