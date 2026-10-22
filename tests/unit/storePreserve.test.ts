import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  REGISTRY_PRESERVE_SPEC,
  registryFileObject,
  type ClaudeRegistry,
} from '../../src/core/claudeRegistry';
import {
  SETTINGS_PRESERVE_SPEC,
  innerObjectShape,
  parseSettingsFile,
  pathTouched,
  serializeSettingsFile,
  settingsPatchPaths,
} from '../../src/core/settings';
import {
  getPath,
  identityArray,
  overlayKnown,
  record,
  replace,
  setPath,
  structural,
  unknownPaths,
  type PreserveSpec,
} from '../../src/core/storePreserve';
import { SettingsObject, SettingsSchema } from '../../src/shared/ipc';

describe('overlayKnown', () => {
  const spec = structural({
    block: structural({ nested: structural() }),
    labels: replace,
    entries: record(structural({ prs: identityArray('url', structural()) })),
    items: identityArray('id', structural()),
  });

  it('keeps unknown top-level and nested keys from raw', () => {
    const raw = { future: { x: 1 }, block: { known: 1, futureField: true, nested: { deep: 'y' } } };
    const parsed = { block: { known: 2, nested: {} } };
    expect(overlayKnown(raw, parsed, spec)).toEqual({
      future: { x: 1 },
      block: { known: 2, futureField: true, nested: { deep: 'y' } },
    });
  });

  it('keeps a spec-known key raw has but parsed lacks (nothing to say)', () => {
    const raw = { block: { a: 1 }, labels: { k: 'v' } };
    expect(overlayKnown(raw, { block: { a: 2 } }, spec)).toEqual({ block: { a: 2 }, labels: { k: 'v' } });
    // An explicit undefined is "nothing to say" too (JSON.stringify would drop it).
    expect(overlayKnown(raw, { block: { a: 2 }, labels: undefined }, spec)).toEqual({
      block: { a: 2 },
      labels: { k: 'v' },
    });
  });

  it('replace: parsed wins wholesale for records, arrays and scalars', () => {
    const raw = { labels: { a: '1', b: '2' }, scalar: 'old', list: [1, 2, 3] };
    expect(overlayKnown(raw, { labels: { b: '3' }, scalar: 'new', list: [9] }, spec)).toEqual({
      labels: { b: '3' },
      scalar: 'new',
      list: [9],
    });
  });

  it('record: membership from parsed, unknown per-entry fields survive', () => {
    const raw = {
      entries: {
        keep: { id: 'keep', pinned: false, futureFlag: 1, prs: [{ url: 'u1', state: null, extra: 'e' }] },
        gone: { id: 'gone', pinned: true },
      },
    };
    const parsed = {
      entries: { keep: { id: 'keep', pinned: true, prs: [{ url: 'u1', state: 'merged' }] } },
    };
    expect(overlayKnown(raw, parsed, spec)).toEqual({
      entries: {
        keep: { id: 'keep', pinned: true, futureFlag: 1, prs: [{ url: 'u1', state: 'merged', extra: 'e' }] },
      },
    });
  });

  it('array with identity: order and membership from parsed, items overlaid by identity', () => {
    const raw = { items: [{ id: 'a', v: 1, fx: 'A' }, { id: 'b', v: 2, fx: 'B' }, { id: 'c', v: 3 }] };
    const parsed = { items: [{ id: 'c', v: 30 }, { id: 'a', v: 10 }, { id: 'new', v: 0 }] };
    expect(overlayKnown(raw, parsed, spec)).toEqual({
      items: [{ id: 'c', v: 30 }, { id: 'a', v: 10, fx: 'A' }, { id: 'new', v: 0 }],
    });
  });

  it('replaces when the container shape changed on either side', () => {
    expect(overlayKnown({ block: 'str' }, { block: { a: 1 } }, spec)).toEqual({ block: { a: 1 } });
    expect(overlayKnown({ block: { a: 1, fx: 2 } }, { block: 'str' }, spec)).toEqual({ block: 'str' });
    expect(overlayKnown(undefined, { block: { a: 1 } }, spec)).toEqual({ block: { a: 1 } });
    expect(overlayKnown([1], { block: { a: 1 } }, spec)).toEqual({ block: { a: 1 } });
  });

  it('top-level array stores (notifications) overlay by identity', () => {
    const top = identityArray('id', structural());
    const raw = [{ id: '1', body: 'x', futureField: true }, { id: '2', body: 'y' }];
    expect(overlayKnown(raw, [{ id: '1', body: 'x2' }], top)).toEqual([{ id: '1', body: 'x2', futureField: true }]);
  });

  it('never mutates its inputs', () => {
    const raw = { block: { a: 1, fx: 2 }, items: [{ id: 'a', fx: 1 }] };
    const parsed = { block: { a: 3 }, items: [{ id: 'a' }] };
    const rawCopy = structuredClone(raw);
    const parsedCopy = structuredClone(parsed);
    overlayKnown(raw, parsed, spec);
    expect(raw).toEqual(rawCopy);
    expect(parsed).toEqual(parsedCopy);
  });
});

describe('unknownPaths', () => {
  const spec = structural({
    block: structural({ nested: structural() }),
    entries: record(structural()),
    items: identityArray('id', structural()),
  });

  it('lists dotted paths of preserved data, including record entries and array items', () => {
    const raw = {
      future: 1,
      block: { a: 1, fx: 2, nested: { deep: 3 } },
      entries: { e1: { id: 'e1', fx: true }, gone: { id: 'gone' } },
      items: [{ id: 'i1', fx: 'x' }],
      labels: { a: 1 },
    };
    const parsed = {
      block: { a: 1, nested: {} },
      entries: { e1: { id: 'e1' } },
      items: [{ id: 'i1' }],
      labels: {},
    };
    expect(unknownPaths(raw, parsed, spec)).toEqual([
      'future',
      'block.fx',
      'block.nested.deep',
      'entries.e1.fx',
      'items.i1.fx',
    ]);
  });

  it('is empty when nothing is preserved and caps at 50 entries', () => {
    expect(unknownPaths({ block: { a: 1 } }, { block: { a: 1 } }, spec)).toEqual([]);
    const raw = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    expect(unknownPaths(raw, {}, spec)).toHaveLength(50);
  });
});

describe('getPath / setPath', () => {
  it('reads and writes dotted paths', () => {
    const root: Record<string, unknown> = { a: { b: 1 } };
    expect(getPath(root, 'a.b')).toBe(1);
    expect(getPath(root, 'a.c.d')).toBeUndefined();
    setPath(root, 'a.c.d', 2);
    setPath(root, 'x', 'y');
    expect(root).toEqual({ a: { b: 1, c: { d: 2 } }, x: 'y' });
  });
});

describe('SETTINGS_PRESERVE_SPEC tracks the zod schema', () => {
  // Every ZodObject field (after unwrapping default/optional) must be a
  // structural node, and nothing else may be; recursive so `notifications.kinds`
  // is covered and a new nested block cannot slip through.
  const check = (shape: Record<string, z.ZodType>, spec: PreserveSpec, prefix: string): void => {
    expect(spec.kind).toBe('object');
    if (spec.kind !== 'object') return;
    const objectKeys = Object.keys(shape).filter((key) => innerObjectShape(shape[key]!) !== null);
    const structuralKeys = Object.keys(spec.keys).filter((key) => spec.keys[key]!.kind === 'object');
    expect(structuralKeys.sort(), `structural keys at ${prefix || 'root'}`).toEqual(objectKeys.sort());
    for (const key of Object.keys(spec.keys)) {
      expect(key in shape, `spec key ${prefix}${key} exists in schema`).toBe(true);
    }
    for (const key of objectKeys) {
      check(innerObjectShape(shape[key]!)!, spec.keys[key]!, `${prefix}${key}.`);
    }
  };

  it('marks exactly the ZodObject fields as structural', () => {
    check(SettingsObject.shape as Record<string, z.ZodType>, SETTINGS_PRESERVE_SPEC, '');
  });

  it('a settings round-trip through the overlay keeps the file identical for a known file', () => {
    const settings = SettingsSchema.parse({ surface: 'local', claude: { model: 'opus' } });
    const raw = JSON.parse(JSON.stringify(settings));
    expect(overlayKnown(raw, settings, SETTINGS_PRESERVE_SPEC)).toEqual(raw);
  });
});

describe('hosts.ssh preservation (P3)', () => {
  it('unknown fields inside an ssh entry survive a save; membership and order come from memory', () => {
    const raw = {
      hosts: {
        wslEnabled: true,
        ssh: [
          { alias: 'box', enabled: true, futurePort: 2222 },
          { alias: 'gone', enabled: true, note: 'x' },
        ],
      },
    };
    const { settings, invalid } = parseSettingsFile(raw);
    const next = { ...settings, hosts: { ...settings.hosts, ssh: [{ alias: 'new', enabled: true }, { alias: 'box', enabled: false }] } };
    const out = serializeSettingsFile(raw, next, invalid, new Set(['hosts.ssh']));
    expect((out.hosts as Record<string, unknown>).ssh).toEqual([
      { alias: 'new', enabled: true },
      { alias: 'box', enabled: false, futurePort: 2222 },
    ]);
  });

  it('an untouched invalid ssh list is written back raw', () => {
    const raw = { hosts: { ssh: [{ alias: 'Bad Alias', enabled: true, extra: 1 }] } };
    const { settings, invalid } = parseSettingsFile(raw);
    const out = serializeSettingsFile(raw, settings, invalid, new Set());
    expect((out.hosts as Record<string, unknown>).ssh).toEqual(raw.hosts.ssh);
  });
});

describe('parseSettingsFile — leaf-granular repair with invalid map', () => {
  it('drops only the failing leaf of a structural block and remembers its raw value', () => {
    const { settings, dropped, invalid } = parseSettingsFile({
      claude: { futureField: true, model: 123, showArchived: true },
      surface: 'nonsense',
    });
    expect(dropped).toEqual(['surface', 'claude.model']);
    expect(invalid).toEqual({ surface: 'nonsense', 'claude.model': 123 });
    expect(settings.claude.model).toBeNull();
    expect(settings.claude.showArchived).toBe(true);
    expect(settings.surface).toBe('cloud');
  });

  it('drops a whole block when it is not an object', () => {
    const { settings, dropped, invalid } = parseSettingsFile({ layout: 'nope' });
    expect(dropped).toEqual(['layout']);
    expect(invalid).toEqual({ layout: 'nope' });
    expect(settings.layout.terminalHeight).toBe(280);
  });
});

describe('settingsPatchPaths / pathTouched', () => {
  it('derives block.key for structural blocks and key for the rest', () => {
    expect(
      settingsPatchPaths({
        surface: 'local',
        local: { devinPath: 'x', pickerFolder: undefined },
        notifications: { kinds: { update: false } },
        hosts: { overrides: { 'wsl:U': { home: '/h' } } },
        windowPlacements: {},
      }),
    ).toEqual(['surface', 'local.devinPath', 'notifications.kinds', 'hosts.overrides', 'windowPlacements']);
  });

  it('matches exact, parent and child paths', () => {
    const touched = new Set(['pane', 'claude.model', 'layout.terminalOpen']);
    expect(pathTouched('pane.fraction', touched)).toBe(true);
    expect(pathTouched('claude.model', touched)).toBe(true);
    expect(pathTouched('claude.path', touched)).toBe(false);
    expect(pathTouched('layout', touched)).toBe(true);
    expect(pathTouched('surface', touched)).toBe(false);
  });
});

describe('serializeSettingsFile', () => {
  it('restores untouched invalid leaves and writes touched ones from memory', () => {
    const raw = {
      future: { x: 1 },
      claude: { futureField: true, model: 123 },
      surface: 'nonsense',
    };
    const { settings, invalid } = parseSettingsFile(raw);
    const untouched = serializeSettingsFile(raw, settings, invalid, new Set());
    expect(untouched.future).toEqual({ x: 1 });
    expect((untouched.claude as Record<string, unknown>).futureField).toBe(true);
    expect((untouched.claude as Record<string, unknown>).model).toBe(123);
    expect(untouched.surface).toBe('nonsense');

    const switched = serializeSettingsFile(
      raw,
      { ...settings, surface: 'local' },
      invalid,
      new Set(['surface']),
    );
    expect(switched.surface).toBe('local');
    expect((switched.claude as Record<string, unknown>).model).toBe(123);
  });

  it('migrated source keys stay deleted (hosts.defaultWslDistro)', () => {
    const file = { hosts: { defaultWslDistro: 'Ubuntu', wslEnabled: true }, future: 1 };
    // The store overlays on the migrated raw, so the deleted key never returns.
    const { settings, invalid } = parseSettingsFile(file);
    const migratedRaw = JSON.parse(
      JSON.stringify({ ...file, hosts: { wslEnabled: true } }),
    ) as Record<string, unknown>;
    const out = serializeSettingsFile(migratedRaw, settings, invalid, new Set());
    expect('defaultWslDistro' in (out.hosts as Record<string, unknown>)).toBe(false);
    expect((out.local as Record<string, unknown>).defaultWslDistro).toBe('Ubuntu');
    expect(out.future).toBe(1);
  });
});

describe('registryFileObject', () => {
  const entry = (id: string): ClaudeRegistry['entries'][string] => ({
    id,
    host: 'local',
    pinned: false,
    archived: false,
    archivedAt: null,
    unarchivedAt: null,
    removed: false,
    removedAt: null,
    lastOpenedAt: null,
    prs: [],
  });

  it('keeps unknown root/per-entry/per-pr fields, drops absent entries', () => {
    const raw = {
      version: 1,
      futureRoot: true,
      entries: {
        a: { ...entry('a'), futureField: 7, prs: [{ url: 'u', state: null, seenAt: 0, completedAt: null, source: 'chat', fx: 1 }] },
        b: { ...entry('b') },
      },
    };
    const reg: ClaudeRegistry = {
      version: 1,
      entries: {
        a: { ...entry('a'), pinned: true, prs: [{ url: 'u', state: 'merged', seenAt: 5, completedAt: 5, source: 'chat' }] },
      },
    };
    const out = registryFileObject(reg, raw);
    expect(out.futureRoot).toBe(true);
    const entries = out.entries as Record<string, Record<string, unknown>>;
    expect(Object.keys(entries)).toEqual(['a']);
    expect(entries.a!.pinned).toBe(true);
    expect(entries.a!.futureField).toBe(7);
    expect(entries.a!.prs).toEqual([
      { url: 'u', state: 'merged', seenAt: 5, completedAt: 5, source: 'chat', fx: 1 },
    ]);
    expect(unknownPaths(raw, reg, REGISTRY_PRESERVE_SPEC).sort()).toEqual([
      'entries.a.futureField',
      'entries.a.prs.u.fx',
      'futureRoot',
    ]);
  });

  it('P4b: folders/folder/prUrls are deleted by name once consumed, kept while pending', () => {
    const raw = {
      version: 1,
      folders: ['Alpha'],
      entries: { a: { ...entry('a'), folder: 'Alpha', prUrls: ['u'] } },
    };
    const pending: ClaudeRegistry = {
      version: 1,
      legacyFolders: ['Alpha'],
      entries: { a: { ...entry('a'), folder: 'Alpha', prs: [] } },
    };
    const kept = registryFileObject(pending, raw);
    expect(kept.folders).toEqual(['Alpha']);
    expect(kept).not.toHaveProperty('legacyFolders');
    expect((kept.entries as Record<string, Record<string, unknown>>).a!.folder).toBe('Alpha');
    expect((kept.entries as Record<string, Record<string, unknown>>).a).not.toHaveProperty('prUrls');

    const stripped: ClaudeRegistry = { version: 1, entries: { a: entry('a') } };
    const out = registryFileObject(stripped, raw);
    expect(out).not.toHaveProperty('folders');
    expect((out.entries as Record<string, Record<string, unknown>>).a).not.toHaveProperty('folder');
  });
});
