export interface CredentialEntry {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

// The on-disk entry: CredentialEntry plus the encrypted password blob.
export interface StoredEntry extends CredentialEntry {
  passwordEnc: string;
}

export const SUGGESTED_ORIGINS = ['https://cloudbeds.okta.com', 'https://github.com'];

// Origins are https-only by default; allowInsecureOrigins is populated from
// AGENT_WORKSPACE_TEST_GITHUB_ORIGINS in test mode and empty in production.
export function normalizeOrigin(
  input: string,
  allowInsecureOrigins: readonly string[] = [],
): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.origin;
  if (allowInsecureOrigins.includes(url.origin)) return url.origin;
  return null;
}

export function matchOrigin(
  url: string,
  origins: readonly string[],
  allowInsecureOrigins: readonly string[] = [],
): string | null {
  const origin = normalizeOrigin(url, allowInsecureOrigins);
  if (!origin) return null;
  return origins.includes(origin) ? origin : null;
}

// v1 files stored one entry per origin as {origin, username, passwordEnc}
// with (usually) no top-level version. v2 files store id-keyed entries with
// timestamps. Anything else / malformed entries are skipped.
export function migrateCredentialsFile(
  raw: unknown,
  now: number,
  newId: () => string,
): StoredEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const version = (raw as { version?: unknown }).version;
  if (version === 2) {
    const seen = new Set<string>();
    const out: StoredEntry[] = [];
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (
        typeof e.id !== 'string' ||
        typeof e.origin !== 'string' ||
        typeof e.username !== 'string' ||
        typeof e.passwordEnc !== 'string' ||
        seen.has(e.id)
      ) {
        continue;
      }
      seen.add(e.id);
      out.push({
        id: e.id,
        origin: e.origin,
        username: e.username,
        passwordEnc: e.passwordEnc,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : now,
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : now,
        lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : null,
      });
    }
    return out;
  }
  // v1 (or unversioned): last write wins per origin, matching the old Map.
  const byOrigin = new Map<string, StoredEntry>();
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e.origin !== 'string' ||
      typeof e.username !== 'string' ||
      typeof e.passwordEnc !== 'string'
    ) {
      continue;
    }
    byOrigin.set(e.origin, {
      id: newId(),
      origin: e.origin,
      username: e.username,
      passwordEnc: e.passwordEnc,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
  }
  return [...byOrigin.values()];
}
