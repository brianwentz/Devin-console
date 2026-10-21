// hooks.apply: the same core/hooksApply.ts the app runs for its local config
// dir, against the distro's native <configDir>/settings.json.

import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
  write: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  copy: (from, to) => copyFile(from, to),
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
