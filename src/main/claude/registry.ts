// userData/claude-sessions.json persistence: zod-validated load (invalid →
// empty registry + error log), atomic tmp+rename saves debounced at 200 ms
// and flushed on dispose. ux3 S6: the file as read is kept and every save
// overlays the in-memory registry on it (registryFileObject), so fields a
// newer build wrote survive an older build's edits.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClaudeRegistrySchema,
  REGISTRY_PRESERVE_SPEC,
  emptyRegistry,
  registryFileObject,
  type ClaudeRegistry,
} from '../../core/claudeRegistry';
import { unknownPaths } from '../../core/storePreserve';
import { log } from '../log';

const SAVE_DEBOUNCE_MS = 200;

export class ClaudeRegistryStore {
  private file: string;
  private registry: ClaudeRegistry = emptyRegistry();
  private raw: unknown = undefined;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(userData: string) {
    this.file = join(userData, 'claude-sessions.json');
  }

  load(): ClaudeRegistry {
    if (!existsSync(this.file)) return this.registry;
    try {
      const json = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const parsed = ClaudeRegistrySchema.safeParse(json);
      if (parsed.success) {
        this.registry = parsed.data;
        this.raw = json;
        const preserved = unknownPaths(json, parsed.data, REGISTRY_PRESERVE_SPEC).filter(
          // Known legacy keys consumed by the P4b/prUrls migrations are not "unknown".
          (path) => path !== 'folders' && !/\.(folder|prUrls)$/.test(path),
        );
        if (preserved.length > 0) {
          log('claude', 'store-preserved', { detail: { store: 'claude-sessions', keys: preserved } });
        }
      } else {
        log('claude', 'claude-registry-load-error', { detail: { kind: 'schema' } });
      }
    } catch {
      log('claude', 'claude-registry-load-error', { detail: { kind: 'parse' } });
    }
    return this.registry;
  }

  save(reg: ClaudeRegistry): void {
    this.registry = reg;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  // Atomic write: tmp file then rename.
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const out = registryFileObject(this.registry, this.raw);
      writeFileSync(`${this.file}.tmp`, JSON.stringify(out), 'utf8');
      renameSync(`${this.file}.tmp`, this.file);
      this.raw = out;
    } catch {
      log('claude', 'claude-registry-save-error', { detail: {} });
      this.dirty = true;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
