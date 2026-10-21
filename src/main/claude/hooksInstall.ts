// Global opt-in: merge our loopback hook block into
// <configDir>/settings.json (literal token — external terminals have no env
// var) or remove it on disable. One-time backup `settings.json.agent-workspace.bak`
// before the first write; atomic tmp+rename; never throws. Async (fs/promises)
// so a slow UNC config dir can't block the main loop.

import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHooksBlock, mergeHooksIntoSettings, removeHooksFromSettings } from '../../core/claudeHooks';
import { log } from '../log';

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

export async function applyGlobalHooks(
  configDir: string,
  enabled: boolean,
  port: number,
  token: string,
  addr?: string,
): Promise<{ installed: boolean; error: string | null }> {
  const file = join(configDir, 'settings.json');
  const backup = `${file}.agent-workspace.bak`;
  // Carry over the pre-rename one-time backup so it is never taken twice.
  const legacyBackup = `${file}.devin-workspaces.bak`;
  try {
    if ((await exists(legacyBackup)) && !(await exists(backup))) {
      await rename(legacyBackup, backup);
      log('claude', 'claude-hooks-backup-migrated', { detail: { file } });
    }
  } catch {
    // best-effort; a second backup is harmless
  }
  let current: string | null = null;
  try {
    if (await exists(file)) current = await readFile(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('claude', 'claude-hooks-install', { detail: { enabled, changed: false, ok: false } });
    return { installed: false, error: message };
  }
  const result = enabled
    ? mergeHooksIntoSettings(
        current,
        buildHooksBlock({ port, auth: { kind: 'token', token }, ...(addr ? { addr } : {}) }),
      )
    : removeHooksFromSettings(current);
  if ('error' in result) {
    log('claude', 'claude-hooks-install', { detail: { enabled, changed: false, ok: false } });
    return { installed: false, error: result.error };
  }
  if (!result.changed) {
    log('claude', 'claude-hooks-install', { detail: { enabled, changed: false, ok: true } });
    return { installed: enabled, error: null };
  }
  try {
    if ((await exists(file)) && !(await exists(backup))) {
      await copyFile(file, backup);
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, result.json, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('claude', 'claude-hooks-install', { detail: { enabled, changed: true, ok: false } });
    return { installed: false, error: message };
  }
  log('claude', 'claude-hooks-install', { detail: { enabled, changed: true, ok: true } });
  return { installed: enabled, error: null };
}
