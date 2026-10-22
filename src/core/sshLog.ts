// SSH aliases never reach the event log (P3): every `ssh:<alias>` host id and
// `ssh://<alias>/…` path inside a log record — values, array items and object
// keys, at any depth — is rewritten to `ssh:#<hash>` / `ssh://#<hash>/…`.
// Pure; the hash function (sha256-8 in main) is injected.

const SSH_ID = /^ssh:([A-Za-z0-9._][A-Za-z0-9._-]*)$/;
const SSH_URI = /ssh:\/\/([A-Za-z0-9._][A-Za-z0-9._-]*)/gi;
const MAX_DEPTH = 8;

function scrubString(value: string, hash: (alias: string) => string): string {
  const id = SSH_ID.exec(value);
  if (id) return `ssh:#${hash(id[1]!.toLowerCase())}`;
  if (!/ssh:\/\//i.test(value)) return value;
  return value.replace(SSH_URI, (_m, alias: string) => `ssh://#${hash(alias.toLowerCase())}`);
}

/** Returns `value` itself when nothing needed rewriting (cheap for the common case). */
export function scrubSshAliases<T>(value: T, hash: (alias: string) => string, depth = 0): T {
  if (typeof value === 'string') return scrubString(value, hash) as T;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = scrubSshAliases(item, hash, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = scrubString(key, hash);
    const next = scrubSshAliases(item, hash, depth + 1);
    if (nextKey !== key || next !== item) changed = true;
    out[nextKey] = next;
  }
  return (changed ? out : value) as T;
}

const regexCache = new Map<string, RegExp>();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** One case-insensitive whole-word matcher for the configured aliases (an alias
 * char on either side, or a `.` followed by one, is not a word boundary). */
function knownAliasRe(aliases: readonly string[]): RegExp {
  const key = aliases.join(' ');
  let re = regexCache.get(key);
  if (!re) {
    const alt = [...aliases].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    re = new RegExp(`(?<![A-Za-z0-9._-])(${alt})(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9_-])`, 'gi');
    if (regexCache.size > 16) regexCache.clear();
    regexCache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

/**
 * Free-text leak guard (R39 #6): every configured alias appearing as a whole
 * word in a string VALUE at any depth (e.g. `ssh: Could not resolve hostname
 * box`) becomes `ssh:#<hash>`. Keys are left alone (host-id keys are handled
 * by scrubSshAliases). Returns `value` itself when nothing changed.
 */
export function scrubKnownAliases<T>(value: T, aliases: readonly string[], hash: (alias: string) => string, depth = 0): T {
  if (aliases.length === 0) return value;
  if (typeof value === 'string') {
    const re = knownAliasRe(aliases);
    if (!re.test(value)) return value;
    return value.replace(knownAliasRe(aliases), (m: string) => `ssh:#${hash(m.toLowerCase())}`) as T;
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = scrubKnownAliases(item, aliases, hash, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = scrubKnownAliases(item, aliases, hash, depth + 1);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}
