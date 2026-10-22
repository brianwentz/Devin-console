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
  /** `mode` (POSIX permission bits) applies to the written file even when it already existed. */
  write(path: string, data: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string, mode?: number): Promise<void>;
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
  if (!result.changed) return { installed: opts.enabled, changed: false, error: null, legacyBackupMigrated };
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
