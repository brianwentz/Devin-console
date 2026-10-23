// Read-only loader for Chrome's `Local State` and `<profile>/Bookmarks`. The fs is
// injected (read + stat only — there is no write function to call); the real wiring
// lives in src/main/bookmarks.ts. No electron, no direct fs.

import { join } from 'node:path';
import { parseChromeBookmarks, parseLocalState, type BookmarkNode, type BookmarkTree } from './chromeBookmarks';

export interface ChromeProfile {
  dir: string;
  name: string;
}

export type BookmarksLoadResult = { state: 'ok'; tree: BookmarkTree } | { state: 'missing' } | { state: 'unreadable' };

export interface BookmarksLoadLog {
  ok: boolean;
  count: number;
  ms: number;
  cached: boolean;
}

export interface BookmarksReaderDeps {
  userDataDir(): string | null;
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  profileSetting(): string | null;
  log(event: 'bookmarks-load', detail: BookmarksLoadLog): void;
  now?(): number;
}

export interface BookmarksReader {
  load(): Promise<BookmarksLoadResult>;
  profiles(): Promise<ChromeProfile[]>;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}
interface LocalStateInfo {
  profiles: ChromeProfile[];
  lastUsed: string | null;
}

const LOCAL_STATE = 'Local State';
const BOOKMARKS = 'Bookmarks';

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean => a.mtimeMs === b.mtimeMs && a.size === b.size;

export function countBookmarkUrls(tree: BookmarkTree): number {
  const walk = (nodes: BookmarkNode[]): number =>
    nodes.reduce((sum, n) => sum + (n.kind === 'url' ? 1 : walk(n.children ?? [])), 0);
  return walk(tree.bar) + walk(tree.other) + walk(tree.mobile);
}

// Profile = the setting when Local State lists it, else last_used when listed, else Default.
export function resolveProfileDir(setting: string | null, info: LocalStateInfo): string {
  const listed = (dir: string | null): dir is string => dir !== null && info.profiles.some((p) => p.dir === dir);
  if (listed(setting)) return setting;
  if (listed(info.lastUsed)) return info.lastUsed;
  return 'Default';
}

// win32 %LOCALAPPDATA%\Google\Chrome\User Data, darwin ~/Library/Application Support/Google/Chrome;
// test mode: AGENT_WORKSPACE_TEST_CHROME_USER_DATA wins. null = no known location.
export function chromeUserDataDir(opts: {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  testMode: boolean;
}): string | null {
  const override = opts.testMode ? opts.env.AGENT_WORKSPACE_TEST_CHROME_USER_DATA : undefined;
  if (override) return override;
  if (opts.platform === 'win32') {
    const local = opts.env.LOCALAPPDATA;
    return local ? join(local, 'Google', 'Chrome', 'User Data') : null;
  }
  if (opts.platform === 'darwin') return join(opts.home, 'Library', 'Application Support', 'Google', 'Chrome');
  return null;
}

export function createBookmarksReader(deps: BookmarksReaderDeps): BookmarksReader {
  const now = deps.now ?? (() => Date.now());
  // Keyed by absolute path, so a profile (or user-data dir) switch never reuses another file's cache.
  const localStateCache = new Map<string, { stamp: FileStamp; info: LocalStateInfo }>();
  const bookmarksCache = new Map<string, { stamp: FileStamp; tree: BookmarkTree }>();

  // null = Local State is missing. A read/parse failure falls back to the last good
  // list for that file, else an empty list (profile resolution then picks Default).
  async function readLocalState(dir: string): Promise<LocalStateInfo | null> {
    const path = join(dir, LOCAL_STATE);
    const cached = localStateCache.get(path);
    let stamp: FileStamp;
    try {
      stamp = await deps.stat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      return cached?.info ?? { profiles: [], lastUsed: null };
    }
    if (cached && sameStamp(cached.stamp, stamp)) return cached.info;
    try {
      const info = parseLocalState(JSON.parse(await deps.readFile(path)));
      localStateCache.set(path, { stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size }, info });
      return info;
    } catch (error) {
      if (isMissing(error)) return null;
      return cached?.info ?? { profiles: [], lastUsed: null };
    }
  }

  async function readBookmarks(path: string): Promise<{ result: BookmarksLoadResult; cached: boolean }> {
    const cached = bookmarksCache.get(path);
    const fallback = (): { result: BookmarksLoadResult; cached: boolean } =>
      cached ? { result: { state: 'ok', tree: cached.tree }, cached: true } : { result: { state: 'unreadable' }, cached: false };
    let stamp: FileStamp;
    try {
      stamp = await deps.stat(path);
    } catch (error) {
      if (isMissing(error)) {
        bookmarksCache.delete(path);
        return { result: { state: 'missing' }, cached: false };
      }
      return fallback();
    }
    if (cached && sameStamp(cached.stamp, stamp)) return { result: { state: 'ok', tree: cached.tree }, cached: true };
    let text: string;
    try {
      text = await deps.readFile(path);
    } catch (error) {
      if (isMissing(error)) {
        bookmarksCache.delete(path);
        return { result: { state: 'missing' }, cached: false };
      }
      return fallback();
    }
    let tree: BookmarkTree | null = null;
    try {
      tree = parseChromeBookmarks(JSON.parse(text));
    } catch {
      // Partial write (Chrome rewriting the file) — handled as a parse failure.
    }
    // A failed parse leaves the stamp unrecorded, so the next open re-reads.
    if (!tree) return fallback();
    bookmarksCache.set(path, { stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size }, tree });
    return { result: { state: 'ok', tree }, cached: false };
  }

  async function loadInner(): Promise<{ result: BookmarksLoadResult; cached: boolean }> {
    const dir = deps.userDataDir();
    if (!dir) return { result: { state: 'missing' }, cached: false };
    const info = await readLocalState(dir);
    if (!info) return { result: { state: 'missing' }, cached: false };
    const profile = resolveProfileDir(deps.profileSetting(), info);
    return readBookmarks(join(dir, profile, BOOKMARKS));
  }

  return {
    async load() {
      const started = now();
      const { result, cached } = await loadInner();
      deps.log('bookmarks-load', {
        ok: result.state === 'ok',
        count: result.state === 'ok' ? countBookmarkUrls(result.tree) : 0,
        ms: Math.max(0, Math.round(now() - started)),
        cached,
      });
      return result;
    },
    async profiles() {
      const dir = deps.userDataDir();
      if (!dir) return [];
      const info = await readLocalState(dir);
      return info ? info.profiles.map((p) => ({ ...p })) : [];
    },
  };
}
