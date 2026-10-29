import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fractionFromPx } from '../core/layout';
import {
  SETTINGS_PRESERVE_SPEC,
  mergeSettings,
  migrateSettingsRaw,
  parseSettingsFile,
  serializeSettingsFile,
  settingsPatchPaths,
} from '../core/settings';
import { getPath, isPlainObject, unknownPaths } from '../core/storePreserve';
import { SettingsPatchSchema, SettingsSchema, type Settings } from '../shared/ipc';
import { log } from './log';
import { state } from './state';

const LegacyStateSchema = z
  .object({
    paneOpen: z.boolean().optional(),
    paneWidth: z.number().optional(),
    surface: z.enum(['cloud', 'local']).optional(),
    tabs: z.unknown().optional(),
  })
  .partial();

// Paths syncFromState rewrites every save (so an invalid raw value at one of
// them is never restored — the live state is authoritative).
const SYNC_STATE_PATHS = ['pane', 'layout', 'sessions.open', 'sessions.width', 'surface', 'tabSnapshot'];

export class SettingsStore {
  readonly file: string;
  private value: Settings;
  // ux3 S6: the file as read (after migrateSettingsRaw) — save() overlays the
  // in-memory value on it so unknown keys survive; replaced by what was written.
  private raw: Record<string, unknown> = {};
  // Raw values of known-but-invalid paths (parseSettingsFile dropped them);
  // written back unless the path was touched in this run.
  private invalid: Record<string, unknown> = {};
  private readonly touched = new Set<string>();

  constructor(userData: string) {
    this.file = join(userData, 'settings.json');
    this.value = this.load();
  }

  get current(): Settings {
    return this.value;
  }

  private load(): Settings {
    if (!existsSync(this.file)) {
      const migrated = this.migrateLegacy();
      if (migrated) return migrated;
      return SettingsSchema.parse({});
    }
    try {
      const json = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const hosts = (json as Record<string, unknown> | null)?.hosts;
      const migratedHostDistro =
        hosts !== undefined &&
        hosts !== null &&
        typeof hosts === 'object' &&
        (hosts as Record<string, unknown>).defaultWslDistro !== undefined;
      // Migrations delete their source keys on the raw object by name — the
      // overlay in save() never deletes, so the file loses exactly those.
      const migrated = migrateSettingsRaw(json);
      this.raw = isPlainObject(migrated) ? migrated : {};
      const { settings, dropped, invalid } = parseSettingsFile(json);
      this.invalid = invalid;
      if (dropped.length > 0) {
        log('shell', 'settings-repaired', { detail: { dropped, preserved: true } });
      }
      const preserved = unknownPaths(this.raw, settings, SETTINGS_PRESERVE_SPEC);
      if (preserved.length > 0) {
        log('shell', 'store-preserved', { detail: { store: 'settings', keys: preserved } });
      }
      if (migratedHostDistro) {
        log('shell', 'settings-migrated', { detail: { from: 'hosts.defaultWslDistro' } });
        this.value = settings;
        this.save();
      }
      return settings;
    } catch {
      return SettingsSchema.parse({});
    }
  }

  private migrateLegacy(): Settings | null {
    const legacyFile = join(this.file, '..', 'spike-state.json');
    if (!existsSync(legacyFile)) return null;
    try {
      const raw = JSON.parse(readFileSync(legacyFile, 'utf8')) as unknown;
      const legacy = LegacyStateSchema.parse(raw);
      const merged = SettingsSchema.parse({
        pane: {
          open: legacy.paneOpen ?? true,
          // Legacy px width was recorded against the 1400 px default window.
          fraction:
            legacy.paneWidth !== undefined ? fractionFromPx(legacy.paneWidth, 1400) : undefined,
        },
        surface: legacy.surface ?? 'cloud',
        tabSnapshot: legacy.tabs,
      });
      this.value = merged;
      this.save();
      try {
        rmSync(legacyFile);
      } catch (error) {
        log('shell', 'settings-migrate-delete-failed', { detail: { error: String(error) } });
      }
      log('shell', 'settings-migrated', { detail: { from: 'spike-state.json' } });
      return merged;
    } catch (error) {
      log('shell', 'settings-migrate-failed', { detail: { error: String(error) } });
      return null;
    }
  }

  merge(patch: unknown): Settings {
    const validated = SettingsPatchSchema.safeParse(patch);
    if (validated.success) for (const path of settingsPatchPaths(validated.data)) this.touched.add(path);
    this.value = mergeSettings(this.value, patch);
    this.save();
    return this.value;
  }

  /**
   * Named removal (ux3 S6 — merge() can't delete): drops `hosts.overrides[id]`
   * when its host is removed (an ssh host the app owns). `hosts.overrides` is a
   * replace-spec record, so only that key leaves the file.
   */
  removeHostOverride(id: string): Settings {
    if (!(id in this.value.hosts.overrides)) return this.value;
    const overrides = { ...this.value.hosts.overrides };
    delete overrides[id];
    this.value = { ...this.value, hosts: { ...this.value.hosts, overrides } };
    this.touched.add('hosts.overrides');
    this.save();
    return this.value;
  }

  save(): void {
    const temporary = `${this.file}.tmp`;
    const out = serializeSettingsFile(this.raw, this.value, this.invalid, this.touched);
    try {
      writeFileSync(temporary, JSON.stringify(out), 'utf8');
      renameSync(temporary, this.file);
      this.raw = out;
    } catch (error) {
      log('shell', 'persist-state-failed', { detail: { error: String(error) } });
    }
  }

  // Sync transient layout/tab state into the store and persist.
  syncFromState(): void {
    const previous = this.value;
    this.value = {
      ...this.value,
      pane: { open: state.paneOpen, fraction: state.paneFraction },
      layout: {
        terminalOpen: state.terminalOpen,
        terminalHeight: state.terminalHeight,
        reviewTerminalHeight: state.reviewTerminalHeight,
      },
      sessions: {
        ...this.value.sessions,
        open: state.sessionsOpen,
        width: state.sessionsWidth,
      },
      surface: state.surface,
      // No TabManager yet (startup init) — keep the loaded snapshot rather
      // than clobbering it with an empty one.
      tabSnapshot: state.tabManager?.persistableState() ?? this.value.tabSnapshot,
    };
    // notifyShell syncs on every state push, so a path counts as touched
    // only once the live state actually differs from what was loaded —
    // otherwise an invalid raw `surface` would be overwritten on first paint.
    for (const path of SYNC_STATE_PATHS) {
      if (this.touched.has(path)) continue;
      if (JSON.stringify(getPath(previous, path)) !== JSON.stringify(getPath(this.value, path))) {
        this.touched.add(path);
      }
    }
    this.save();
  }
}

export function allowExternalEnabled(): boolean {
  const env = process.env.AGENT_WORKSPACE_ALLOW_EXTERNAL;
  if (env !== undefined) return env === '1';
  return state.settings?.current.routing.allowExternal ?? true;
}
