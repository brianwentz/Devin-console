// The one implementation of "apply our hook block to a Claude settings.json",
// shared by the app (local config dir, src/main/claude/hooksInstall.ts) and the
// in-distro helper (src/helper/hooks.ts) so both paths write identical files.
// Pure: the file system arrives as an injected SettingsFileIo.

import { buildHooksBlock, mergeHooksIntoSettings, removeHooksFromSettings } from './claudeHooks';

export interface SettingsFileIo {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Permission bits of an existing file; null when absent / not reported (Windows). */
  mode?(path: string): Promise<number | null>;
  /** Creates `path` fresh with `mode` from the first byte (a stale file is removed first, then O_EXCL) — never a window with a looser mode (R36 #4). */
  write(path: string, data: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Same contract as write for `to`: created with `mode` before any content lands. */
  copy(from: string, to: string, mode?: number): Promise<void>;
  /** Tighten an existing file's mode (no-op / absent on Windows). */
  chmod?(path: string, mode: number): Promise<void>;
}

/** The fs/promises calls the real SettingsFileIo needs (injected: core stays node-free). */
export interface SettingsFsPromises {
  stat(path: string): Promise<{ mode: number }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<{ writeFile(data: string, encoding: 'utf8'): Promise<void>; close(): Promise<void> }>;
}

/**
 * The one SettingsFileIo of the app (local) and the helper (remote). Files
 * written with a mode are created O_EXCL with that mode after removing any
 * stale file — the token-bearing content never sits in a looser-mode file,
 * not even briefly (R36 #4).
 */
export function createSettingsFileIo(fs: SettingsFsPromises): SettingsFileIo {
  const create = async (path: string, data: string, mode: number | undefined): Promise<void> => {
    await fs.unlink(path).catch(() => undefined);
    const handle = await fs.open(path, 'wx', mode ?? 0o666);
    try {
      await handle.writeFile(data, 'utf8');
    } finally {
      await handle.close();
    }
  };
  return {
    exists: (path) =>
      fs.stat(path).then(
        () => true,
        () => false,
      ),
    read: (path) => fs.readFile(path, 'utf8'),
    mode: (path) =>
      fs.stat(path).then(
        (s) => s.mode & 0o777,
        () => null,
      ),
    write: (path, data, mode) => create(path, data, mode),
    rename: (from, to) => fs.rename(from, to),
    copy: async (from, to, mode) => create(to, await fs.readFile(from, 'utf8'), mode),
    chmod: (path, mode) => fs.chmod(path, mode),
  };
}

/** settings.json holds the hook bearer token: 0600, or a stricter existing mode (never looser). */
export function secureFileMode(existing: number | null): number {
  return existing === null ? 0o600 : existing & 0o600;
}

export type HooksApplyOptions = { enabled: boolean; port: number; token: string; addr?: string };

export type HooksApplyResult = {
  installed: boolean;
  /** A write was needed (true also when that write then failed). */
  changed: boolean;
  /** Raw error text — callers that cross a process boundary must scrub it. */
  error: string | null;
  legacyBackupMigrated: boolean;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One-time backup `<file>.agent-workspace.bak` before the first write, atomic
 * `<file>.tmp` + rename, an unparseable file → no write + error. Never throws.
 */
export async function applyHooksToSettings(
  io: SettingsFileIo,
  file: string,
  opts: HooksApplyOptions,
): Promise<HooksApplyResult> {
  const backup = `${file}.agent-workspace.bak`;
  // Carry over the pre-rename one-time backup so it is never taken twice.
  const legacyBackup = `${file}.devin-workspaces.bak`;
  let legacyBackupMigrated = false;
  try {
    if ((await io.exists(legacyBackup)) && !(await io.exists(backup))) {
      await io.rename(legacyBackup, backup);
      legacyBackupMigrated = true;
    }
  } catch {
    // best-effort; a second backup is harmless
  }
  const fail = (changed: boolean, error: string): HooksApplyResult => ({
    installed: false,
    changed,
    error,
    legacyBackupMigrated,
  });
  let current: string | null = null;
  try {
    if (await io.exists(file)) current = await io.read(file);
  } catch (error) {
    return fail(false, message(error));
  }
  const result = opts.enabled
    ? mergeHooksIntoSettings(
        current,
        buildHooksBlock({ port: opts.port, auth: { kind: 'token', token: opts.token }, ...(opts.addr ? { addr: opts.addr } : {}) }),
      )
    : removeHooksFromSettings(current);
  if ('error' in result) return fail(false, result.error);
  if (!result.changed) {
    // Our block is already there: a file group/other can read (written by an
    // older build) is tightened once, even though nothing else changes.
    if (opts.enabled && io.chmod) {
      const existing = (await io.mode?.(file).catch(() => null)) ?? null;
      if (existing !== null && (existing & 0o077) !== 0) {
        await io.chmod(file, secureFileMode(existing)).catch(() => undefined);
      }
    }
    return { installed: opts.enabled, changed: false, error: null, legacyBackupMigrated };
  }
  try {
    const mode = secureFileMode((await io.mode?.(file).catch(() => null)) ?? null);
    if ((await io.exists(file)) && !(await io.exists(backup))) await io.copy(file, backup, mode);
    const tmp = `${file}.tmp`;
    await io.write(tmp, result.json, mode);
    await io.rename(tmp, file);
  } catch (error) {
    return fail(true, message(error));
  }
  return { installed: opts.enabled, changed: true, error: null, legacyBackupMigrated };
}
