import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  matchOrigin,
  migrateCredentialsFile,
  normalizeOrigin,
  SUGGESTED_ORIGINS,
} from '../../src/core/credentials';
import {
  CredentialStore,
  CredentialsUnavailableError,
  type CredentialEncryptor,
} from '../../src/main/credentials';

describe('normalizeOrigin', () => {
  it('normalizes a full URL to its origin', () => {
    expect(normalizeOrigin('https://github.com/org/repo?x=1#y')).toBe('https://github.com');
    expect(normalizeOrigin('https://github.com')).toBe('https://github.com');
  });

  it('rejects http and invalid input', () => {
    expect(normalizeOrigin('http://github.com')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('ftp://github.com')).toBeNull();
  });

  it('honours the insecure allowlist for test origins', () => {
    const allowed = ['http://127.0.0.1:1234'];
    expect(normalizeOrigin('http://127.0.0.1:1234/login', allowed)).toBe(
      'http://127.0.0.1:1234',
    );
    expect(normalizeOrigin('http://127.0.0.1:9999/x', allowed)).toBeNull();
  });
});

describe('matchOrigin', () => {
  const origins = ['https://github.com', 'https://cloudbeds.okta.com'];

  it('matches exact origins', () => {
    expect(matchOrigin('https://github.com/login?x=1', origins)).toBe('https://github.com');
  });

  it('rejects http, subdomains, and different ports', () => {
    expect(matchOrigin('http://github.com/login', origins)).toBeNull();
    expect(matchOrigin('https://a.github.com/login', origins)).toBeNull();
    expect(matchOrigin('https://github.com:8443/login', origins)).toBeNull();
    expect(matchOrigin('https://okta.com', origins)).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(matchOrigin('junk', origins)).toBeNull();
  });

  it('http is still rejected when the allowlist is empty', () => {
    expect(matchOrigin('http://127.0.0.1:1/', ['http://127.0.0.1:1'])).toBeNull();
  });

  it('matches an allowlisted insecure origin', () => {
    expect(
      matchOrigin('http://127.0.0.1:1/login', ['http://127.0.0.1:1'], ['http://127.0.0.1:1']),
    ).toBe('http://127.0.0.1:1');
  });

  it('exposes suggested origins', () => {
    expect(SUGGESTED_ORIGINS).toContain('https://github.com');
    expect(SUGGESTED_ORIGINS).toContain('https://cloudbeds.okta.com');
  });
});

describe('migrateCredentialsFile', () => {
  const ids = (() => {
    let n = 0;
    return () => `id-${++n}`;
  })();

  it('migrates v1 entries and skips malformed ones', () => {
    const raw = {
      entries: [
        { origin: 'https://github.com', username: 'alice', passwordEnc: 'enc1' },
        { origin: 'https://okta.example.com', username: 'bob', passwordEnc: 'enc2' },
        { origin: 'https://broken.example.com' },
        'junk',
      ],
    };
    const migrated = migrateCredentialsFile(raw, 1000, ids);
    expect(migrated).toHaveLength(2);
    expect(migrated[0]).toMatchObject({
      origin: 'https://github.com',
      username: 'alice',
      passwordEnc: 'enc1',
      createdAt: 1000,
      updatedAt: 1000,
      lastUsedAt: null,
    });
    expect(migrated[0]!.id).toBeTruthy();
  });

  it('dedupes v1 entries by origin (last wins)', () => {
    const raw = {
      entries: [
        { origin: 'https://github.com', username: 'alice', passwordEnc: 'enc1' },
        { origin: 'https://github.com', username: 'carol', passwordEnc: 'enc3' },
      ],
    };
    const migrated = migrateCredentialsFile(raw, 5, ids);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.username).toBe('carol');
  });

  it('passes v2 entries through and skips bad ones', () => {
    const raw = {
      version: 2,
      entries: [
        {
          id: 'a',
          origin: 'https://github.com',
          username: 'alice',
          passwordEnc: 'enc1',
          createdAt: 1,
          updatedAt: 2,
          lastUsedAt: 3,
        },
        {
          id: 'a',
          origin: 'https://github.com',
          username: 'dupe',
          passwordEnc: 'enc4',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
        },
        { origin: 'https://noid.example.com', username: 'x', passwordEnc: 'enc5' },
      ],
    };
    const migrated = migrateCredentialsFile(raw, 9, ids);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ id: 'a', username: 'alice', lastUsedAt: 3 });
  });

  it('returns [] for garbage input', () => {
    expect(migrateCredentialsFile(null, 0, ids)).toEqual([]);
    expect(migrateCredentialsFile({ entries: 'nope' }, 0, ids)).toEqual([]);
    expect(migrateCredentialsFile({}, 0, ids)).toEqual([]);
  });
});

describe('CredentialStore', () => {
  const dirs: string[] = [];
  const stubEncryptor = (): CredentialEncryptor => ({
    isAvailable: async () => true,
    encrypt: async (value) => Buffer.from(`enc:${value}`),
    decrypt: async (value) => value.toString().replace(/^enc:/, ''),
  });
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-workspace-creds-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('saves, lists, and deletes credentials without exposing secrets', async () => {
    const dir = makeDir();
    const store = new CredentialStore(join(dir, 'credentials.json'), stubEncryptor());
    const entry = await store.add({
      origin: 'https://github.com/x',
      username: 'alice',
      password: 's3cret',
    });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: entry.id,
      origin: 'https://github.com',
      username: 'alice',
      lastUsedAt: null,
    });
    expect(JSON.stringify(list)).not.toContain('s3cret');
    const onDisk = readFileSync(join(dir, 'credentials.json'), 'utf8');
    expect(onDisk).not.toContain('s3cret');
    const parsed = JSON.parse(onDisk);
    expect(parsed.version).toBe(2);
    expect(parsed.entries[0].passwordEnc).toBe(
      Buffer.from('enc:s3cret').toString('base64'),
    );
    expect(store.delete(entry.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('round-trips through a reload', async () => {
    const dir = makeDir();
    const file = join(dir, 'credentials.json');
    const first = new CredentialStore(file, stubEncryptor());
    await first.add({ origin: 'https://github.com', username: 'alice', password: 'pw' });
    const second = new CredentialStore(file, stubEncryptor());
    expect(second.list()).toHaveLength(1);
    expect(second.list()[0]).toMatchObject({
      origin: 'https://github.com',
      username: 'alice',
    });
  });

  it('migrates a v1 file on load and persists v2', async () => {
    const dir = makeDir();
    const file = join(dir, 'credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          {
            origin: 'https://github.com',
            username: 'alice',
            passwordEnc: Buffer.from('enc:pw').toString('base64'),
          },
        ],
      }),
      'utf8',
    );
    const store = new CredentialStore(file, stubEncryptor());
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ origin: 'https://github.com', username: 'alice' });
    expect(list[0]!.id).toBeTruthy();
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2);
    expect(await store.reveal(list[0]!.id)).toBe('pw');
  });

  it('supports multiple accounts per origin', async () => {
    const dir = makeDir();
    const store = new CredentialStore(join(dir, 'credentials.json'), stubEncryptor());
    const first = await store.add({
      origin: 'https://github.com',
      username: 'bob',
      password: 'p1',
    });
    await store.add({ origin: 'https://github.com', username: 'alice', password: 'p2' });
    await store.add({ origin: 'https://okta.example.com', username: 'zed', password: 'p3' });
    const forOrigin = store.forOrigin('https://github.com/login');
    expect(forOrigin.map((entry) => entry.username)).toEqual(['alice', 'bob']);
    // add with the same origin+username updates in place (same id)
    const updated = await store.add({
      origin: 'https://github.com',
      username: 'bob',
      password: 'p9',
    });
    expect(updated.id).toBe(first.id);
    expect(store.list()).toHaveLength(3);
    expect(await store.reveal(first.id)).toBe('p9');
  });

  it('update patches fields, sets updatedAt, and rejects username collisions', async () => {
    const dir = makeDir();
    const store = new CredentialStore(join(dir, 'credentials.json'), stubEncryptor());
    const first = await store.add({
      origin: 'https://github.com',
      username: 'alice',
      password: 'p1',
    });
    await store.add({ origin: 'https://github.com', username: 'bob', password: 'p2' });
    await expect(store.update(first.id, { username: 'bob' })).rejects.toThrow(
      'An entry for that username already exists',
    );
    const patched = await store.update(first.id, { username: 'alice2', password: 'n3w' });
    expect(patched).toMatchObject({ id: first.id, username: 'alice2' });
    expect(patched!.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(await store.reveal(first.id)).toBe('n3w');
    expect(await store.update('missing-id', { password: 'x' })).toBeNull();
  });

  it('touch sets lastUsedAt and persists it', async () => {
    const dir = makeDir();
    const file = join(dir, 'credentials.json');
    const store = new CredentialStore(file, stubEncryptor());
    const entry = await store.add({
      origin: 'https://github.com',
      username: 'alice',
      password: 'pw',
    });
    expect(store.list()[0]!.lastUsedAt).toBeNull();
    store.touch(entry.id);
    expect(store.list()[0]!.lastUsedAt).not.toBeNull();
    const reloaded = new CredentialStore(file, stubEncryptor());
    expect(reloaded.list()[0]!.lastUsedAt).toBe(store.list()[0]!.lastUsedAt);
  });

  it('throws CredentialsUnavailableError and writes nothing when encryption is unavailable', async () => {
    const dir = makeDir();
    const unavailable: CredentialEncryptor = {
      isAvailable: async () => false,
      encrypt: async () => Buffer.from(''),
      decrypt: async () => '',
    };
    const file = join(dir, 'credentials.json');
    const store = new CredentialStore(file, unavailable);
    await expect(
      store.add({ origin: 'https://github.com', username: 'a', password: 'p' }),
    ).rejects.toBeInstanceOf(CredentialsUnavailableError);
    expect(existsSync(file)).toBe(false);
  });

  it('rejects non-https origins', async () => {
    const dir = makeDir();
    const store = new CredentialStore(join(dir, 'credentials.json'), stubEncryptor());
    await expect(
      store.add({ origin: 'http://github.com', username: 'a', password: 'p' }),
    ).rejects.toThrow();
  });
});
