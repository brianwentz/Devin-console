import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READDIR_MAX_ENTRIES, readDirs } from '../../../src/helper/main';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helper-readdir-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('helper fs.readdir (RemoteFolderInput)', () => {
  it('lists directories only, sorted by name', async () => {
    mkdirSync(join(root, 'zeta'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'file.txt'), 'x');
    expect(await readDirs(root)).toEqual({
      entries: [
        { name: '.hidden', dir: true },
        { name: 'alpha', dir: true },
        { name: 'zeta', dir: true },
      ],
      truncated: false,
    });
  });

  it('follows a symlink to a directory', async () => {
    mkdirSync(join(root, 'real'));
    try {
      symlinkSync(join(root, 'real'), join(root, 'link'), 'junction');
    } catch {
      return; // no symlink privilege on this runner
    }
    expect((await readDirs(root)).entries.map((e) => e.name)).toEqual(['link', 'real']);
  });

  it('caps the entry count and says so', async () => {
    for (let i = 0; i < READDIR_MAX_ENTRIES + 5; i++) mkdirSync(join(root, `d${String(i).padStart(4, '0')}`));
    const result = await readDirs(root);
    expect(result.entries).toHaveLength(READDIR_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it('refuses relative paths; a missing directory is an empty list', async () => {
    await expect(readDirs('relative/x')).rejects.toMatchObject({ code: 'bad-params' });
    expect(await readDirs(join(root, 'gone'))).toEqual({ entries: [], truncated: false });
  });
});
