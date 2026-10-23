import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_ROOT_PREFIX,
  STALE_RUN_ROOT_MS,
  createRunRoot,
  removeDir,
  runRootName,
  sweepStaleRunRoots,
} from '../support/tempRoot';

describe('tempRoot', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'tempRoot-test-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('names run roots with the short prefix, pid and a base-36 timestamp', () => {
    expect(runRootName(4242, 36)).toBe(`${RUN_ROOT_PREFIX}4242-10`);
  });

  it('creates the run root under the base', () => {
    const root = createRunRoot(base, 7, 1000);
    expect(root).toBe(join(base, runRootName(7, 1000)));
    expect(existsSync(root)).toBe(true);
  });

  it('removes a populated dir recursively and reports success; a missing dir is fine', () => {
    const root = createRunRoot(base, 1, 1);
    mkdirSync(join(root, 'aw-e2e-abc', 'deep'), { recursive: true });
    writeFileSync(join(root, 'aw-e2e-abc', 'deep', 'f.txt'), 'x');
    expect(removeDir(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(removeDir(root)).toBe(true);
  });

  it('sweeps only stale run roots', () => {
    const now = Date.now();
    const stale = createRunRoot(base, 1, 1);
    const fresh = createRunRoot(base, 2, 2);
    const other = join(base, 'unrelated-dir');
    mkdirSync(other);
    const old = new Date(now - STALE_RUN_ROOT_MS - 60_000);
    utimesSync(stale, old, old);
    expect(sweepStaleRunRoots(base, now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('sweeping a missing base is a no-op', () => {
    expect(sweepStaleRunRoots(join(base, 'does-not-exist'))).toBe(0);
  });
});
