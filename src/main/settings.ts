import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fractionFromPx } from '../core/layout';
import { mergeSettings, parseSettingsFile } from '../core/settings';
import { SettingsSchema, type Settings } from '../shared/ipc';
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

export class SettingsStore {
  readonly file: string;
  private value: Settings;

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
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const hosts = (raw as Record<string, unknown> | null)?.hosts;
      const migratedHostDistro =
        hosts !== undefined &&
        hosts !== null &&
        typeof hosts === 'object' &&
        (hosts as Record<string, unknown>).defaultWslDistro !== undefined;
      const { settings, dropped } = parseSettingsFile(raw);
      if (dropped.length > 0) {
        log('shell', 'settings-repaired', { detail: { dropped } });
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
    this.value = mergeSettings(this.value, patch);
    this.save();
    return this.value;
  }

  save(): void {
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.value), 'utf8');
      renameSync(temporary, this.file);
    } catch (error) {
      log('shell', 'persist-state-failed', { detail: { error: String(error) } });
    }
  }

  // Sync transient layout/tab state into the store and persist.
  syncFromState(): void {
    this.value = {
      ...this.value,
      pane: { open: state.paneOpen, fraction: state.paneFraction },
      layout: { terminalOpen: state.terminalOpen, terminalHeight: state.terminalHeight },
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
    this.save();
  }
}

export function allowExternalEnabled(): boolean {
  const env = process.env.DEVIN_WORKSPACES_ALLOW_EXTERNAL;
  if (env !== undefined) return env === '1';
  return state.settings?.current.routing.allowExternal ?? true;
}
