// Phase 4 — global opt-in: merge our loopback hook block into
// <configDir>/settings.json (literal token — external terminals have no env
// var) or remove it on disable. One-time backup `settings.json.devin-workspaces.bak`
// before the first write; atomic tmp+rename; never throws.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHooksBlock, mergeHooksIntoSettings, removeHooksFromSettings } from '../../core/claudeHooks';
import { log } from '../log';

export function applyGlobalHooks(
  configDir: string,
  enabled: boolean,
  port: number,
  token: string,
): { installed: boolean; error: string | null } {
  const file = join(configDir, 'settings.json');
  const backup = `${file}.devin-workspaces.bak`;
  let current: string | null = null;
  try {
    if (existsSync(file)) current = readFileSync(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('claude', 'claude-hooks-install', { detail: { enabled, changed: false, ok: false } });
    return { installed: false, error: message };
  }
  const result = enabled
    ? mergeHooksIntoSettings(current, buildHooksBlock({ port, auth: { kind: 'token', token } }))
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
    if (existsSync(file) && !existsSync(backup)) {
      copyFileSync(file, backup);
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, result.json, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('claude', 'claude-hooks-install', { detail: { enabled, changed: true, ok: false } });
    return { installed: false, error: message };
  }
  log('claude', 'claude-hooks-install', { detail: { enabled, changed: true, ok: true } });
  return { installed: enabled, error: null };
}
