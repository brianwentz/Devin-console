import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { log } from './log';
import { migrationRan } from './migrate';

// Encrypted-at-rest secret store. Values are encrypted with Electron
// safeStorage (DPAPI on Windows) and written base64-encoded to
// userData/secrets.json. Plaintext is only ever held in main-process memory.
// The async safeStorage API (Electron >= 39) is preferred; the sync API is a
// fallback only when the async functions are absent from the runtime.

const SecretsFileSchema = z.object({
  version: z.literal(1),
  devinPat: z.string().optional(),
});
type SecretsFile = z.infer<typeof SecretsFileSchema>;

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

type AsyncSafeStorage = Electron.SafeStorage & {
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (plainText: string) => Promise<Buffer>;
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
};

export class SecretStore {
  readonly file: string;
  private pat: string | null = null;
  private loaded = false;
  private usingSyncFallback = false;

  constructor(userData: string) {
    this.file = join(userData, 'secrets.json');
  }

  // True when at least one encryption path is usable.
  async encryptionAvailable(): Promise<boolean> {
    const store = safeStorage as AsyncSafeStorage;
    if (typeof store.isAsyncEncryptionAvailable === 'function') {
      try {
        if (await store.isAsyncEncryptionAvailable()) return true;
      } catch (error) {
        log('shell', 'secrets-async-probe-failed', { detail: { message: String(error) } });
      }
    }
    if (typeof store.isEncryptionAvailable === 'function' && store.isEncryptionAvailable()) {
      if (!this.usingSyncFallback) {
        this.usingSyncFallback = true;
        log('shell', 'secrets-sync-fallback', {
          detail: { reason: 'async safeStorage unavailable; using synchronous API' },
        });
      }
      return true;
    }
    return false;
  }

  private async encrypt(plain: string): Promise<Buffer> {
    const store = safeStorage as AsyncSafeStorage;
    if (!this.usingSyncFallback && typeof store.encryptStringAsync === 'function') {
      return store.encryptStringAsync(plain);
    }
    return store.encryptString(plain);
  }

  private async decrypt(buffer: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const store = safeStorage as AsyncSafeStorage;
    if (!this.usingSyncFallback && typeof store.decryptStringAsync === 'function') {
      return store.decryptStringAsync(buffer);
    }
    return { result: store.decryptString(buffer), shouldReEncrypt: false };
  }

  private readFile(): SecretsFile {
    if (!existsSync(this.file)) return { version: 1 };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      const parsed = SecretsFileSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      log('shell', 'secrets-file-invalid', { detail: { reason: 'schema' } });
    } catch (error) {
      log('shell', 'secrets-file-invalid', { detail: { message: String(error) } });
    }
    return { version: 1 };
  }

  private writeFile(value: SecretsFile): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), 'utf8');
    renameSync(temporary, this.file);
  }

  // Decrypt the stored PAT into memory. Idempotent.
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.readFile();
    if (!file.devinPat) return;
    if (!(await this.encryptionAvailable())) {
      log('shell', 'secrets-load-skipped', { detail: { reason: 'encryption unavailable' } });
      return;
    }
    try {
      const { result, shouldReEncrypt } = await this.decrypt(Buffer.from(file.devinPat, 'base64'));
      this.pat = result;
      log('shell', 'secrets-loaded', { detail: { hasPat: true, shouldReEncrypt } });
      if (shouldReEncrypt) await this.persist();
    } catch (error) {
      log('shell', 'secrets-decrypt-failed', { detail: { message: String(error) } });
      // §3.3: on darwin the safeStorage key is keyed by app name, so a
      // migrated profile's secrets.json can never decrypt — drop it. Gated on
      // the migration having run this launch so an ordinary Keychain hiccup
      // deletes nothing.
      if (process.platform === 'darwin' && migrationRan()) {
        try {
          rmSync(this.file, { force: true });
        } catch {
          // best-effort
        }
        log('shell', 'profile-migrated-secrets-reset', { detail: { file: this.file } });
        // Lazy: keeps this store importable without the window/notifications
        // graph (unit tests, early startup).
        void import('./notifications.js').then((m) => m.notifyMigratedSecretsReset());
      }
    }
  }

  hasPat(): boolean {
    return this.pat !== null;
  }

  // Main-process only. Never send the result over IPC or into the log.
  getPat(): string | null {
    return this.pat;
  }

  async setPat(pat: string): Promise<void> {
    if (!(await this.encryptionAvailable())) {
      throw new SecretStoreError('OS encryption is unavailable; token not stored.');
    }
    this.pat = pat;
    await this.persist();
    log('shell', 'secrets-pat-set', { detail: { length: pat.length } });
  }

  async clearPat(): Promise<void> {
    this.pat = null;
    try {
      if (existsSync(this.file)) rmSync(this.file);
    } catch (error) {
      log('shell', 'secrets-clear-failed', { detail: { message: String(error) } });
      throw new SecretStoreError('Could not delete the secrets file.');
    }
    log('shell', 'secrets-pat-cleared');
  }

  private async persist(): Promise<void> {
    const value: SecretsFile = { version: 1 };
    if (this.pat !== null) {
      const encrypted = await this.encrypt(this.pat);
      value.devinPat = encrypted.toString('base64');
    }
    try {
      this.writeFile(value);
    } catch (error) {
      log('shell', 'secrets-write-failed', { detail: { message: String(error) } });
      throw new SecretStoreError('Could not write the secrets file.');
    }
  }
}
