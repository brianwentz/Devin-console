import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store's only non-pure dependency is the event log (electron `app`);
// capture its calls instead.
const logged: Array<{ event: string; detail: unknown }> = [];
vi.mock('../../src/main/log', () => ({
  log: (_view: string, event: string, extra?: { detail?: unknown }) => {
    logged.push({ event, detail: extra?.detail });
  },
}));

import { SettingsStore } from '../../src/main/settings';

type Json = Record<string, any>;

describe('SettingsStore round-trip (ux3 S6)', () => {
  let dir: string;
  const file = () => join(dir, 'settings.json');
  const readFile = (): Json => JSON.parse(readFileSync(file(), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devin-workspaces-settings-store-'));
    logged.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps unknown keys and untouched invalid values; touched paths are rewritten', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        future: { x: 1 },
        claude: { futureField: true, model: 123 },
        surface: 'nonsense',
      }),
    );
    const store = new SettingsStore(dir);
    expect(store.current.surface).toBe('cloud');
    expect(store.current.claude.model).toBeNull();
    const repaired = logged.find((e) => e.event === 'settings-repaired');
    expect(repaired?.detail).toEqual({ dropped: ['surface', 'claude.model'], preserved: true });
    const preserved = logged.filter((e) => e.event === 'store-preserved');
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.detail).toEqual({ store: 'settings', keys: ['future', 'claude.futureField'] });

    store.merge({ local: { devinPath: 'x' } });
    let persisted = readFile();
    expect(persisted.future).toEqual({ x: 1 });
    expect(persisted.claude.futureField).toBe(true);
    expect(persisted.claude.model).toBe(123);
    expect(persisted.surface).toBe('nonsense');
    expect(persisted.local.devinPath).toBe('x');

    store.merge({ surface: 'local' });
    persisted = readFile();
    expect(persisted.surface).toBe('local');
    expect(persisted.claude.model).toBe(123);
    expect(persisted.claude.futureField).toBe(true);

    // A second save does not log store-preserved again.
    store.merge({ claude: { showArchived: true } });
    expect(logged.filter((e) => e.event === 'store-preserved')).toHaveLength(1);
    persisted = readFile();
    expect(persisted.claude.showArchived).toBe(true);
    expect(persisted.claude.model).toBe(123);

    // Touching the invalid leaf itself writes memory's value.
    store.merge({ claude: { model: 'opus' } });
    expect(readFile().claude.model).toBe('opus');

    // A fresh store on the written file sees the surviving unknown data.
    const again = new SettingsStore(dir);
    expect(again.current.surface).toBe('local');
    expect(readFile().future).toEqual({ x: 1 });
  });

  it('the hosts.defaultWslDistro migration still deletes its source key from the file', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        hosts: { defaultWslDistro: 'Ubuntu-22.04', wslEnabled: false, futureHost: 1 },
        future: true,
      }),
    );
    const store = new SettingsStore(dir);
    expect(store.current.local.defaultWslDistro).toBe('Ubuntu-22.04');
    expect(logged.some((e) => e.event === 'settings-migrated')).toBe(true);
    // The migration re-saves once at load.
    const persisted = readFile();
    expect(persisted.hosts).not.toHaveProperty('defaultWslDistro');
    expect(persisted.hosts.futureHost).toBe(1);
    expect(persisted.hosts.wslEnabled).toBe(false);
    expect(persisted.local.defaultWslDistro).toBe('Ubuntu-22.04');
    expect(persisted.claude.defaultWslDistro).toBe('Ubuntu-22.04');
    expect(persisted.future).toBe(true);
  });

  it('a valid file round-trips byte-for-byte in content (no key loss, no key gain beyond defaults)', () => {
    const initial = { tenantUrl: 'https://t.example', nested: { deep: [1, 2] }, pane: { open: false, fraction: 0.3, fx: 'y' } };
    writeFileSync(file(), JSON.stringify(initial));
    const store = new SettingsStore(dir);
    expect(logged.filter((e) => e.event === 'settings-repaired')).toHaveLength(0);
    store.merge({ pane: { open: true } });
    const persisted = readFile();
    expect(persisted.nested).toEqual({ deep: [1, 2] });
    expect(persisted.pane).toMatchObject({ open: true, fraction: 0.3, fx: 'y' });
    expect(persisted.tenantUrl).toBe('https://t.example');
  });
});
