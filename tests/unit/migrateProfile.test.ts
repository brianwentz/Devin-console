import { describe, expect, it } from 'vitest';
import { planProfileMigration, type MigrationInput } from '../../src/core/migrateProfile';

// Paths are built with node:path — on Windows join() emits '\', so compare
// normalised.
const norm = (p: string) => p.replaceAll('\\', '/');

const mkInput = (over: Partial<MigrationInput> = {}, existing: string[] = []): MigrationInput => ({
  userData: '/appdata/agent-workspace',
  explicitUserData: false,
  legacyName: 'devin-workspaces',
  localAppData: '/localappdata',
  legacyOverride: null,
  exists: (p) => existing.includes(norm(p)),
  ...over,
});

const LEGACY = '/appdata/devin-workspaces';

describe('planProfileMigration', () => {
  it('skips when userData is explicit', () => {
    expect(planProfileMigration(mkInput({ explicitUserData: true }, [LEGACY]))).toEqual({
      kind: 'skip',
      reason: 'explicit',
    });
  });

  it('skips when the legacy profile is missing', () => {
    expect(planProfileMigration(mkInput())).toEqual({ kind: 'skip', reason: 'no-legacy' });
  });

  it('skips when the destination already exists', () => {
    const input = mkInput({}, [LEGACY, '/appdata/agent-workspace']);
    expect(planProfileMigration(input)).toEqual({ kind: 'skip', reason: 'destination-exists' });
  });

  it('moves the legacy profile onto the new userData dir', () => {
    const plan = planProfileMigration(mkInput({}, [LEGACY]));
    if (plan.kind !== 'move') throw new Error('expected move');
    expect(norm(plan.from)).toBe(LEGACY);
    expect(norm(plan.to)).toBe('/appdata/agent-workspace');
    expect(norm(plan.partitionFrom)).toBe('/appdata/agent-workspace/Partitions/devin');
    expect(norm(plan.partitionTo)).toBe('/appdata/agent-workspace/Partitions/cloud');
    expect(norm(plan.updaterCacheFrom)).toBe('/localappdata/devin-workspaces-updater');
  });

  it('runs despite an explicit userData when legacyOverride is set', () => {
    const input = mkInput(
      { explicitUserData: true, legacyOverride: '/tmp/old-profile' },
      ['/tmp/old-profile'],
    );
    const plan = planProfileMigration(input);
    if (plan.kind !== 'move') throw new Error('expected move');
    expect(norm(plan.from)).toBe('/tmp/old-profile');
  });

  it('falls back to a dir next to the profile when localAppData is null', () => {
    const plan = planProfileMigration(mkInput({ localAppData: null }, [LEGACY]));
    if (plan.kind !== 'move') throw new Error('expected move');
    expect(norm(plan.updaterCacheFrom)).toBe('/appdata/devin-workspaces-updater');
  });
});
