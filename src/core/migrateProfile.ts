// Pure decision layer for the Devin Workspaces → Agent Workspace profile
// move. src/main/migrate.ts performs the fs operations; this module is kept
// free of electron/fs so the branching stays unit-testable.

import { dirname, join } from 'node:path';

export interface MigrationInput {
  userData: string;
  explicitUserData: boolean;
  legacyName: 'devin-workspaces';
  /** %LOCALAPPDATA% on win32; null elsewhere → updater cache is looked up
   * next to the profile. */
  localAppData: string | null;
  /** Test-mode stand-in for the legacy dir (e2e always runs with an explicit
   * userData, which is otherwise never migrated). */
  legacyOverride: string | null;
  exists(path: string): boolean;
}

export type MigrationPlan =
  | { kind: 'skip'; reason: 'explicit' | 'no-legacy' | 'destination-exists' }
  | {
      kind: 'move';
      from: string;
      to: string;
      partitionFrom: string;
      partitionTo: string;
      updaterCacheFrom: string;
    };

export function planProfileMigration(input: MigrationInput): MigrationPlan {
  const from = input.legacyOverride ?? join(dirname(input.userData), input.legacyName);
  if (input.explicitUserData && !input.legacyOverride) {
    return { kind: 'skip', reason: 'explicit' };
  }
  if (!input.exists(from)) return { kind: 'skip', reason: 'no-legacy' };
  if (input.exists(input.userData)) return { kind: 'skip', reason: 'destination-exists' };
  return {
    kind: 'move',
    from,
    to: input.userData,
    partitionFrom: join(input.userData, 'Partitions', 'devin'),
    partitionTo: join(input.userData, 'Partitions', 'cloud'),
    updaterCacheFrom: join(
      input.localAppData ?? dirname(input.userData),
      `${input.legacyName}-updater`,
    ),
  };
}
