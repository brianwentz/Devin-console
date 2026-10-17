// userData/claude-sessions.json persistence: zod-validated load (invalid →
// empty registry + error log), atomic tmp+rename saves debounced at 200 ms
// and flushed on dispose.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeRegistrySchema, emptyRegistry, type ClaudeRegistry } from '../../core/claudeRegistry';
import { log } from '../log';

const SAVE_DEBOUNCE_MS = 200;

export class ClaudeRegistryStore {
  private file: string;
  private registry: ClaudeRegistry = emptyRegistry();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(userData: string) {
    this.file = join(userData, 'claude-sessions.json');
  }

  load(): ClaudeRegistry {
    if (!existsSync(this.file)) return this.registry;
    try {
      const parsed = ClaudeRegistrySchema.safeParse(
        JSON.parse(readFileSync(this.file, 'utf8')),
      );
      if (parsed.success) {
        this.registry = parsed.data;
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
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.registry), 'utf8');
      renameSync(`${this.file}.tmp`, this.file);
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
