// Real-fs wiring of the read-only Chrome bookmarks reader. Only `readFile` and `stat`
// are imported — the reader has no way to write into Chrome's profile.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  chromeUserDataDir,
  createBookmarksReader,
  type BookmarksReader,
} from '../core/bookmarksReader';
import { log } from './log';
import { state, testMode } from './state';

export { createBookmarksReader, type BookmarksReader } from '../core/bookmarksReader';

let instance: BookmarksReader | null = null;

export function bookmarksReader(): BookmarksReader {
  instance ??= createBookmarksReader({
    userDataDir: () =>
      chromeUserDataDir({ platform: process.platform, env: process.env, home: homedir(), testMode }),
    readFile: (path) => readFile(path, 'utf8'),
    stat: async (path) => {
      const s = await stat(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
    profileSetting: () => state.settings?.current.favorites.chromeProfile ?? null,
    log: (event, detail) => log('shell', event, { detail: { ...detail } }),
  });
  return instance;
}
