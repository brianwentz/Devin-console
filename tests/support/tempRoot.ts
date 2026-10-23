// Per-run temp root for the test runners. The suites create hundreds of
// mkdtemp profiles/fixtures per run (~1.5k dirs, ~9 GB for a full e2e run) and
// most never remove them. Instead of cleaning up at every call site, a runner
// points TEMP/TMP/TMPDIR at one run-owned directory and deletes it afterwards.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Short on purpose: macOS unix-socket paths are length-limited.
export const RUN_ROOT_PREFIX = 'aw-run-';
export const STALE_RUN_ROOT_MS = 2 * 60 * 60 * 1000;

export function runRootName(pid: number, now: number): string {
  return `${RUN_ROOT_PREFIX}${pid}-${now.toString(36)}`;
}

export function createRunRoot(base: string, pid = process.pid, now = Date.now()): string {
  const dir = join(base, runRootName(pid, now));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir: string): boolean {
  try {
    // An orphaned child (Electron, pty) can briefly hold handles on Windows.
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

// Run roots left behind by a killed run (SIGKILL, power loss, CI cancel).
export function sweepStaleRunRoots(base: string, now = Date.now(), maxAgeMs = STALE_RUN_ROOT_MS): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) continue;
    const full = join(base, name);
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue;
    } catch {
      continue;
    }
    if (removeDir(full)) removed++;
  }
  return removed;
}
