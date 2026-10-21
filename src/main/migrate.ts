// Performs the Devin Workspaces → Agent Workspace profile move planned by
// core/migrateProfile. Electron-free so it stays importable in unit tests;
// src/main/bootstrap.ts feeds it real paths and must run before ./log
// (log.ts mkdirs userData at import, which would create the destination and
// defeat the "destination exists" check). Never throws.

import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { planProfileMigration } from '../core/migrateProfile';

export interface MigrationResult {
  migrated: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

export function runProfileMigration(opts: {
  userData: string;
  explicitUserData: boolean;
  localAppData: string | null;
  legacyOverride: string | null;
}): MigrationResult {
  try {
    const plan = planProfileMigration({
      ...opts,
      legacyName: 'devin-workspaces',
      exists: existsSync,
    });
    if (plan.kind === 'skip') return { migrated: false, detail: { reason: plan.reason } };

    let method: 'rename' | 'copy' | 'failed';
    try {
      renameSync(plan.from, plan.to);
      method = 'rename';
    } catch {
      // Cross-volume or a locked entry — copy, then remove the source.
      try {
        cpSync(plan.from, plan.to, { recursive: true });
        rmSync(plan.from, { recursive: true, force: true });
        method = 'copy';
      } catch (error) {
        lastResult = {
          migrated: false,
          detail: { from: plan.from, to: plan.to, method: 'failed' },
          error: String(error),
        };
        return lastResult;
      }
    }

    let partition = false;
    try {
      if (existsSync(plan.partitionFrom) && !existsSync(plan.partitionTo)) {
        renameSync(plan.partitionFrom, plan.partitionTo);
        partition = true;
      }
    } catch {
      // best-effort; a fresh partition is created on demand
    }

    // electron-updater's per-app cache (%LOCALAPPDATA%\devin-workspaces-updater
    // on win32). The just-run installer may still hold it — retried next start.
    let updaterCache = false;
    try {
      rmSync(plan.updaterCacheFrom, { recursive: true, force: true });
      updaterCache = true;
    } catch {
      // locked — next launch retries
    }

    lastResult = {
      migrated: true,
      detail: {
        from: plan.from,
        to: plan.to,
        method,
        partition,
        updaterCache,
      },
    };
    return lastResult;
  } catch (error) {
    lastResult = { migrated: false, detail: { reason: 'error' }, error: String(error) };
    return lastResult;
  }
}

let lastResult: MigrationResult = { migrated: false, detail: {} };

export function migrationRan(): boolean {
  return lastResult.migrated;
}
