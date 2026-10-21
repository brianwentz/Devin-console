import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { safeStorage } from 'electron';
import { migrationRan } from './migrate';
import {
  migrateCredentialsFile,
  normalizeOrigin,
  type CredentialEntry,
  type StoredEntry,
} from '../core/credentials';

export type CredentialLog = (event: string, detail?: Record<string, unknown>) => void;
const noopLog: CredentialLog = () => undefined;

export interface CredentialEncryptor {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

export class CredentialsUnavailableError extends Error {
  constructor() {
    super('OS encryption is not available; credentials were not saved');
    this.name = 'CredentialsUnavailableError';
  }
}

export const safeStorageEncryptor: CredentialEncryptor = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptStringAsync(value),
  decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
};

export class CredentialStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(
    private readonly file: string,
    private readonly encryptor: CredentialEncryptor = safeStorageEncryptor,
    private readonly allowInsecure: readonly string[] = [],
    private readonly log: CredentialLog = noopLog,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number };
      const migrated = migrateCredentialsFile(raw, Date.now(), () => randomUUID());
      for (const entry of migrated) this.entries.set(entry.id, entry);
      if (raw?.version !== 2) this.persist();
    } catch (error) {
      this.log('credentials-load-failed', { error: String(error) });
    }
    // §3.3: on darwin the safeStorage key is keyed by app name, so a migrated
    // profile's entries can never decrypt — probe once and drop the file.
    // Gated on the migration having run this launch so an ordinary Keychain
    // hiccup deletes nothing.
    if (process.platform === 'darwin' && migrationRan() && this.entries.size > 0) {
      void this.resetIfUndecryptable();
    }
  }

  private async resetIfUndecryptable(): Promise<void> {
    const first = this.entries.values().next().value;
    if (!first) return;
    try {
      if (!(await this.encryptor.isAvailable())) return;
      await this.encryptor.decrypt(Buffer.from(first.passwordEnc, 'base64'));
    } catch {
      this.entries.clear();
      this.persist();
      this.log('profile-migrated-secrets-reset', { file: this.file });
      // Lazy: notifications.ts pulls electron-dependent modules that are not
      // importable in unit tests.
      void import('./notifications.js').then((m) => m.notifyMigratedSecretsReset());
    }
  }

  private static publicEntry(entry: StoredEntry): CredentialEntry {
    const { passwordEnc: _passwordEnc, ...rest } = entry;
    return rest;
  }

  private sorted(): StoredEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username),
    );
  }

  list(): CredentialEntry[] {
    return this.sorted().map(CredentialStore.publicEntry);
  }

  get origins(): string[] {
    return [...new Set([...this.entries.values()].map((entry) => entry.origin))];
  }

  forOrigin(origin: string): CredentialEntry[] {
    const normalized = normalizeOrigin(origin, this.allowInsecure) ?? origin;
    return this.sorted()
      .filter((entry) => entry.origin === normalized)
      .map(CredentialStore.publicEntry);
  }

  async add(input: { origin: string; username: string; password: string }): Promise<CredentialEntry> {
    const origin = normalizeOrigin(input.origin, this.allowInsecure);
    if (!origin) throw new Error(`Not a valid https origin: ${input.origin}`);
    if (!(await this.encryptor.isAvailable())) throw new CredentialsUnavailableError();
    const passwordEnc = (await this.encryptor.encrypt(input.password)).toString('base64');
    const now = Date.now();
    const existing = [...this.entries.values()].find(
      (entry) => entry.origin === origin && entry.username === input.username,
    );
    if (existing) {
      existing.passwordEnc = passwordEnc;
      existing.updatedAt = now;
      this.persist();
      this.log('credential-update', { origin });
      return CredentialStore.publicEntry(existing);
    }
    const entry: StoredEntry = {
      id: randomUUID(),
      origin,
      username: input.username,
      passwordEnc,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    this.entries.set(entry.id, entry);
    this.persist();
    // Never log the username — identifiers are semi-sensitive too.
    this.log('credential-add', { origin });
    return CredentialStore.publicEntry(entry);
  }

  async update(
    id: string,
    patch: { username?: string | undefined; password?: string | undefined },
  ): Promise<CredentialEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (patch.username !== undefined && patch.username !== entry.username) {
      const collision = [...this.entries.values()].some(
        (other) =>
          other.id !== id && other.origin === entry.origin && other.username === patch.username,
      );
      if (collision) throw new Error('An entry for that username already exists');
      entry.username = patch.username;
    }
    if (patch.password !== undefined) {
      if (!(await this.encryptor.isAvailable())) throw new CredentialsUnavailableError();
      entry.passwordEnc = (await this.encryptor.encrypt(patch.password)).toString('base64');
    }
    entry.updatedAt = Date.now();
    this.persist();
    this.log('credential-update', { origin: entry.origin });
    return CredentialStore.publicEntry(entry);
  }

  delete(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.persist();
    this.log('credential-delete', { origin: entry.origin });
    return true;
  }

  async reveal(id: string): Promise<string | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (!(await this.encryptor.isAvailable())) return null;
    try {
      const value = await this.encryptor.decrypt(Buffer.from(entry.passwordEnc, 'base64'));
      this.log('credential-reveal', { origin: entry.origin });
      return value;
    } catch {
      return null;
    }
  }

  touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    this.persist();
  }

  private persist(): void {
    const serialized = JSON.stringify({
      version: 2,
      entries: [...this.entries.values()],
    });
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, serialized, 'utf8');
      renameSync(temporary, this.file);
    } catch (error) {
      this.log('credentials-persist-failed', { error: String(error) });
    }
  }
}
