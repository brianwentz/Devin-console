import { z } from 'zod';
import { fractionFromPx } from './layout';
import {
  identityArray,
  isPlainObject,
  overlayKnown,
  setPath,
  structural,
  type PreserveSpec,
} from './storePreserve';
import {
  canonicalSshHostEntry,
  SettingsObject,
  SettingsPatchSchema,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from '../shared/ipc';

// ux3 S6: which settings.json blocks are structural (unknown nested keys
// survive a save). Every other field — scalars, arrays, records such as
// `workspaceLabels`, `hosts.overrides`, `windowPlacements` — is replaced
// wholesale. tests/unit/storePreserve.test.ts introspects SettingsObject and
// fails when this drifts from the set of ZodObject fields.
export const SETTINGS_PRESERVE_SPEC: PreserveSpec = structural({
  routing: structural(),
  pane: structural(),
  local: structural(),
  tabs: structural(),
  notifications: structural({ kinds: structural() }),
  prs: structural(),
  favorites: structural(),
  layout: structural(),
  sessions: structural(),
  terminal: structural(),
  analytics: structural(),
  usage: structural(),
  claude: structural(),
  review: structural(),
  openhands: structural(),
  // ssh entries by alias: membership/order from memory, unknown per-entry fields survive.
  hosts: structural({ ssh: identityArray('alias', structural()) }),
});

// F2: `pane.width` (px) was persisted against the 1400 px default window.
const LEGACY_PANE_WINDOW_WIDTH = 1400;

// Migrate pre-P8 payloads: `tabs` used to hold the tab snapshot (now
// `tabSnapshot`), and `discardIdleMinutes` became `tabs.keepAliveHours`
// (non-default values convert: ceil(minutes/60), clamped ≥1; the old default
// of 30 maps to the new default 24). F2: `pane.width` px → `pane.fraction`.
export function migrateSettingsRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...(raw as Record<string, unknown>) };
  if (out.pane && typeof out.pane === 'object') {
    const pane = { ...(out.pane as Record<string, unknown>) };
    if (pane.width !== undefined) {
      if (
        pane.fraction === undefined &&
        typeof pane.width === 'number' &&
        Number.isFinite(pane.width)
      ) {
        pane.fraction = fractionFromPx(pane.width, LEGACY_PANE_WINDOW_WIDTH);
      }
      delete pane.width;
    }
    out.pane = pane;
  }
  const tabs = out.tabs;
  if (tabs && typeof tabs === 'object') {
    const snapshotCandidate = tabs as Record<string, unknown>;
    const looksLikeSnapshot =
      Array.isArray(snapshotCandidate.tabs) || typeof snapshotCandidate.version === 'number';
    if (looksLikeSnapshot) {
      if (out.tabSnapshot === undefined) out.tabSnapshot = tabs;
      delete out.tabs;
    } else {
      // settings.tabs object — already current shape (or invalid; repair drops it)
    }
  }
  // notifications.enabled (pre-P6) → collect
  if (out.notifications && typeof out.notifications === 'object') {
    const n = { ...(out.notifications as Record<string, unknown>) };
    if (n.enabled !== undefined) {
      if (n.collect === undefined) n.collect = n.enabled;
      delete n.enabled;
    }
    out.notifications = n;
  }
  // ux2 P0: hosts.defaultWslDistro split into per-surface keys; copy only where
  // the new value is absent, then drop it.
  if (out.hosts && typeof out.hosts === 'object') {
    const hosts = { ...(out.hosts as Record<string, unknown>) };
    const distro = hosts.defaultWslDistro;
    if (distro !== undefined) {
      if (typeof distro === 'string' && distro !== '') {
        const local =
          out.local && typeof out.local === 'object'
            ? { ...(out.local as Record<string, unknown>) }
            : {};
        if (local.defaultWslDistro === undefined) {
          local.defaultWslDistro = distro;
          out.local = local;
        }
        const claude =
          out.claude && typeof out.claude === 'object'
            ? { ...(out.claude as Record<string, unknown>) }
            : {};
        if (claude.defaultWslDistro === undefined) {
          claude.defaultWslDistro = distro;
          out.claude = claude;
        }
      }
      delete hosts.defaultWslDistro;
      out.hosts = hosts;
    }
  }
  const discardMinutes = out.discardIdleMinutes;
  if (discardMinutes !== undefined) {
    const tabsOut =
      out.tabs && typeof out.tabs === 'object'
        ? { ...(out.tabs as Record<string, unknown>) }
        : {};
    if (tabsOut.keepAliveHours === undefined) {
      const minutes = typeof discardMinutes === 'number' ? discardMinutes : NaN;
      tabsOut.keepAliveHours =
        Number.isFinite(minutes) && minutes !== 30
          ? Math.max(1, Math.min(168, Math.ceil(minutes / 60)))
          : 24;
    }
    out.tabs = tabsOut;
    delete out.discardIdleMinutes;
  }
  return out;
}

// Unwrap `.default()` / `.optional()` wrappers down to the field schema.
export function unwrapSchema(schema: z.ZodType): z.ZodType {
  let node: z.ZodType = schema;
  for (;;) {
    const def = node.def as { type: string; innerType?: z.ZodType };
    if ((def.type === 'default' || def.type === 'optional') && def.innerType) node = def.innerType;
    else return node;
  }
}

export function innerObjectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const inner = unwrapSchema(schema);
  return inner instanceof z.ZodObject ? (inner.shape as Record<string, z.ZodType>) : null;
}

export interface ParsedSettingsFile {
  settings: Settings;
  /** Dotted paths whose value failed validation (`surface`, `claude.model`). */
  dropped: string[];
  /** Raw values of the dropped paths — written back by the store unless the
   * path is changed in this run (ux3 S6: invalid-but-known is preserved). */
  invalid: Record<string, unknown>;
}

// Parse a raw settings.json payload. On whole-object failure, keep each
// individually valid field; a structural block that fails is repaired at
// leaf granularity (only the failing leaves fall back to their defaults).
// Dropped paths are reported so the caller can log a repair event.
export function parseSettingsFile(raw: unknown): ParsedSettingsFile {
  const migrated = migrateSettingsRaw(raw);
  const parsed = SettingsSchema.safeParse(migrated);
  if (parsed.success) return { settings: parsed.data, dropped: [], invalid: {} };
  const dropped: string[] = [];
  const invalid: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  if (isPlainObject(migrated)) {
    for (const key of Object.keys(SettingsObject.shape)) {
      const field = SettingsObject.shape[key as keyof typeof SettingsObject.shape];
      const value = migrated[key];
      if (value === undefined) continue;
      const result = field.safeParse(value);
      if (result.success) {
        kept[key] = result.data;
        continue;
      }
      const shape = innerObjectShape(field);
      if (!shape || !isPlainObject(value)) {
        dropped.push(key);
        invalid[key] = value;
        continue;
      }
      const block: Record<string, unknown> = {};
      for (const [leaf, leafSchema] of Object.entries(shape)) {
        const leafValue = value[leaf];
        if (leafValue === undefined) continue;
        const leafResult = leafSchema.safeParse(leafValue);
        if (leafResult.success) block[leaf] = leafResult.data;
        else {
          dropped.push(`${key}.${leaf}`);
          invalid[`${key}.${leaf}`] = leafValue;
        }
      }
      kept[key] = block;
    }
  }
  return { settings: SettingsSchema.parse(kept), dropped, invalid };
}

// Dotted paths a validated patch writes: `key` for top-level fields,
// `block.key` for leaves of structural blocks (two levels — a
// `notifications.kinds.x` change counts as `notifications.kinds`).
export function settingsPatchPaths(patch: SettingsPatch): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const sub = SETTINGS_PRESERVE_SPEC.kind === 'object' ? SETTINGS_PRESERVE_SPEC.keys[key] : undefined;
    if (sub?.kind === 'object' && isPlainObject(value)) {
      for (const [leaf, leafValue] of Object.entries(value)) {
        if (leafValue !== undefined) paths.push(`${key}.${leaf}`);
      }
    } else {
      paths.push(key);
    }
  }
  return paths;
}

// A dropped path counts as touched when it, a parent or a child of it was
// written this run (`pane` touched covers `pane.fraction`; `layout.terminalOpen`
// touched covers a whole-block `layout` drop).
export function pathTouched(path: string, touched: ReadonlySet<string>): boolean {
  for (const t of touched) {
    if (t === path || t.startsWith(`${path}.`) || path.startsWith(`${t}.`)) return true;
  }
  return false;
}

// The object written to settings.json: the in-memory value overlaid on the
// file as read (unknown keys survive), then every untouched invalid leaf
// restored to its raw value.
export function serializeSettingsFile(
  raw: Record<string, unknown>,
  value: Settings,
  invalid: Record<string, unknown>,
  touched: ReadonlySet<string>,
): Record<string, unknown> {
  const out = overlayKnown(raw, value, SETTINGS_PRESERVE_SPEC) as Record<string, unknown>;
  for (const [path, rawValue] of Object.entries(invalid)) {
    if (!pathTouched(path, touched)) setPath(out, path, rawValue);
  }
  keepMalformedSshEntries(raw, out);
  return out;
}

// M4: hosts.ssh entries the schema dropped as malformed (sanitizeSshHostList)
// are not in memory, so the identity overlay would delete them — append them
// back raw (ux3 S6: a build never deletes data it does not understand).
// R40 L1: memory holds canonical (lower-case) aliases, so a hand-edited
// `MyBox` never matches the overlay's identity — each kept entry is laid over
// its first raw entry with the same canonical alias (raw alias form and
// unknown fields survive; memory's `enabled` wins), and a later raw duplicate
// of a host that is still configured is appended back raw. A removed host's
// raw entries (duplicates included) go with it.
function keepMalformedSshEntries(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const rawSsh = isPlainObject(raw.hosts) ? raw.hosts.ssh : undefined;
  if (!Array.isArray(rawSsh) || !isPlainObject(out.hosts) || !Array.isArray(out.hosts.ssh)) return;
  const kept = out.hosts.ssh as unknown[];
  const canonical = rawSsh.map((entry) => canonicalSshHostEntry(entry)?.alias ?? null);
  const used = new Set<number>();
  const merged = kept.map((entry) => {
    const alias = isPlainObject(entry) && typeof entry.alias === 'string' ? entry.alias : null;
    const index = alias === null ? -1 : canonical.findIndex((c, i) => c === alias && !used.has(i));
    if (index < 0) return entry;
    used.add(index);
    const rawEntry = rawSsh[index] as Record<string, unknown>;
    return { ...rawEntry, ...(entry as Record<string, unknown>), alias: rawEntry.alias };
  });
  const keptAliases = new Set(kept.map((e) => (isPlainObject(e) ? e.alias : undefined)));
  const extra = rawSsh.filter(
    (entry, i) => !used.has(i) && !kept.includes(entry) && (canonical[i] === null || keptAliases.has(canonical[i])),
  );
  const changed = extra.length > 0 || merged.some((e, i) => JSON.stringify(e) !== JSON.stringify(kept[i]));
  if (changed) out.hosts = { ...out.hosts, ssh: [...merged, ...extra] };
}

// exactOptionalPropertyTypes: spreading a Partial can write explicit
// `undefined` over a required field — drop undefined entries first.
function mergeDefined<T extends object>(base: T, patch: { [K in keyof T]?: T[K] | undefined } | undefined): T {
  if (!patch) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// Apply a SettingsPatchSchema-shaped partial to current settings. Absent keys
// are left untouched; routing/pane merge shallowly. Returns current unchanged
// when the patch is invalid.
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const parsed = SettingsPatchSchema.safeParse(patch);
  if (!parsed.success) return current;
  const {
    routing,
    pane,
    notifications,
    prs,
    favorites,
    local,
    tabs,
    layout,
    terminal,
    sessions,
    claude,
    openhands,
    hosts,
    ...rest
  } = parsed.data;
  const topLevel = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  );
  return {
    ...current,
    ...topLevel,
    routing: mergeDefined(current.routing, routing),
    pane: mergeDefined(current.pane, pane),
    tabs: mergeDefined(current.tabs, tabs),
    notifications: notifications
      ? {
          ...mergeDefined(current.notifications, { ...notifications, kinds: undefined }),
          kinds: mergeDefined(current.notifications.kinds, notifications.kinds),
        }
      : current.notifications,
    prs: mergeDefined(current.prs, prs),
    favorites: mergeDefined(current.favorites, favorites),
    local: mergeDefined(current.local, local),
    layout: mergeDefined(current.layout, layout),
    terminal: mergeDefined(current.terminal, terminal),
    sessions: mergeDefined(current.sessions, sessions),
    claude: mergeDefined(current.claude, claude),
    openhands: mergeDefined(current.openhands, openhands),
    hosts: hosts
      ? {
          ...mergeDefined(current.hosts, { ...hosts, overrides: undefined }),
          // Per-host and per-field merge: patching 'wsl:X'.home keeps its paths.
          overrides: hosts.overrides
            ? Object.fromEntries(
                Object.keys({ ...current.hosts.overrides, ...hosts.overrides }).map((id) => [
                  id,
                  mergeDefined(
                    current.hosts.overrides[id] ?? {},
                    hosts.overrides?.[id],
                  ),
                ]),
              )
            : current.hosts.overrides,
        }
      : current.hosts,
  };
}
