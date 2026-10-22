// Global opt-in: merge our loopback hook block into
// <configDir>/settings.json (literal token — external terminals have no env
// var) or remove it on disable. The write rules (one-time backup, atomic
// tmp+rename, never throws) live in core/hooksApply.ts, shared with the
// in-distro helper. Local config dir only — a WSL host's file is written by
// its helper (hooks.apply over the channel, see hooks.ts).

import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { applyHooksToSettings, createSettingsFileIo, type SettingsFileIo } from '../../core/hooksApply';
import { log } from '../log';

const localIo: SettingsFileIo = createSettingsFileIo(fsPromises);

export async function applyGlobalHooks(
  configDir: string,
  enabled: boolean,
  port: number,
  token: string,
  addr?: string,
): Promise<{ installed: boolean; error: string | null }> {
  const result = await applyHooksToSettings(localIo, join(configDir, 'settings.json'), {
    enabled,
    port,
    token,
    ...(addr ? { addr } : {}),
  });
  if (result.legacyBackupMigrated) log('claude', 'claude-hooks-backup-migrated');
  log('claude', 'claude-hooks-install', { detail: { enabled, changed: result.changed, ok: result.error === null } });
  return { installed: result.installed, error: result.error };
}
