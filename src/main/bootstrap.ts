// Earliest module in the app: imported FIRST from index.ts (and from log.ts,
// which resolves and mkdirs userData at import time). Applies the explicit
// userData override, then moves the legacy `devin-workspaces` profile into
// the new dir — before anything can create the destination. Never throws.

import { resolve } from 'node:path';
import { app } from 'electron';
import { runProfileMigration, type MigrationResult } from './migrate';

const requestedUserData = process.env.AGENT_WORKSPACE_USER_DATA;
if (requestedUserData) app.setPath('userData', resolve(requestedUserData));

export const migration: MigrationResult = runProfileMigration({
  userData: app.getPath('userData'),
  explicitUserData: Boolean(requestedUserData),
  localAppData: process.env.LOCALAPPDATA ?? null,
  // Test-only stand-in for <dirname(userData)>/devin-workspaces: e2e always
  // runs with an explicit profile, which is otherwise never migrated.
  legacyOverride:
    process.env.AGENT_WORKSPACE_TEST === '1'
      ? (process.env.AGENT_WORKSPACE_TEST_MIGRATE_FROM ?? null)
      : null,
});
