// hooks.apply: the same core/hooksApply.ts the app runs for its local config
// dir, against the distro's native <configDir>/settings.json.

import { chmod, copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyHooksToSettings, type HooksApplyOptions, type SettingsFileIo } from '../core/hooksApply';
import { bool, int, optStr, safeMessage, str } from './params';

const io: SettingsFileIo = {
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false,
    ),
  read: (path) => readFile(path, 'utf8'),
  mode: (path) =>
    stat(path).then(
      (s) => s.mode & 0o777,
      () => null,
    ),
  // writeFile's `mode` only applies on create — chmod covers a leftover tmp.
  write: async (path, data, mode) => {
    await writeFile(path, data, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) await chmod(path, mode);
  },
  rename: (from, to) => rename(from, to),
  copy: async (from, to, mode) => {
    await copyFile(from, to);
    if (mode !== undefined) await chmod(to, mode);
  },
};

// JSON.parse messages quote the offending input — keep only our own prefix.
const PARSE_PREFIX = 'settings.json is not valid JSON';

function scrub(error: string): string {
  return error.startsWith(PARSE_PREFIX) ? PARSE_PREFIX : safeMessage(error);
}

export async function applyHooks(
  configDir: string,
  opts: HooksApplyOptions,
): Promise<{ installed: boolean; changed: boolean; error: string | null }> {
  const r = await applyHooksToSettings(io, join(configDir, 'settings.json'), opts);
  return { installed: r.installed, changed: r.changed, error: r.error === null ? null : scrub(r.error) };
}

/**
 * `node helper-<hash>.mjs --apply-hooks-off`: the opt-out for a distro whose
 * channel is down (disabled in the app but still running). Same hooksApply
 * path as `hooks.apply`; no stdio protocol, one count line on stderr, exit
 * 0 on success / 1 on failure (the error text can quote the file — never printed).
 */
export async function hooksOffOnce(configDir: string, writeErr: (line: string) => void): Promise<number> {
  const r = await applyHooks(configDir, { enabled: false, port: 1, token: '' });
  if (r.error !== null) {
    writeErr('helper: hooks-off failed\n');
    return 1;
  }
  writeErr(`helper: hooks-off changed=${r.changed ? 1 : 0}\n`);
  return 0;
}

export function hooksHandlers(configDir: string): Record<string, (params: unknown) => unknown> {
  return {
    'hooks.apply': (params) => {
      const addr = optStr(params, 'addr');
      const enabled = bool(params, 'enabled');
      return applyHooks(configDir, {
        enabled,
        port: int(params, 'port', 1, 65535),
        // Removal never writes the token, so only an install requires one.
        token: enabled ? str(params, 'token') : (optStr(params, 'token') ?? ''),
        ...(addr ? { addr } : {}),
      });
    },
  };
}
