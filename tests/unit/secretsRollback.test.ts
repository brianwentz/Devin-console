import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));
vi.mock('../../src/main/log', () => ({ log: () => {} }));
vi.mock('../../src/main/migrate', () => ({ migrationRan: () => false }));

import { SecretStore } from '../../src/main/secrets';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SecretStore OpenHands key rollback', () => {
  it('keeps the previous value when persisting a new key fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-secrets-'));
    dirs.push(dir);
    const store = new SecretStore(dir);
    await store.setOpenHandsApiKey('first');
    expect(await store.getOpenHandsApiKey()).toBe('first');

    // The directory vanishing makes the next write fail.
    rmSync(dir, { recursive: true, force: true });
    await expect(store.setOpenHandsApiKey('second')).rejects.toThrow();
    expect(await store.getOpenHandsApiKey()).toBe('first');
    expect(store.hasOpenHandsApiKey()).toBe(true);
  });

  it('never claims an unsaved key on a fresh store', async () => {
    const dir = join(tmpdir(), `aw-secrets-missing-${Date.now()}`);
    const store = new SecretStore(dir);
    await expect(store.setOpenHandsApiKey('k')).rejects.toThrow();
    expect(store.hasOpenHandsApiKey()).toBe(false);
    expect(await store.getOpenHandsApiKey()).toBeNull();
  });
});
