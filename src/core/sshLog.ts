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

const regexCache = new Map<string, { prefixed: RegExp; bare: RegExp }>();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Matchers for the configured aliases, case-insensitive: `ssh:<alias>` in
 * free text, then the bare alias as a whole word. An alias char (or `:` / `#`)
 * before it, or an alias char after it, is not a boundary; a following `.`
 * is (the first label of `box.example.com` is the alias). */
function knownAliasRes(aliases: readonly string[]): { prefixed: RegExp; bare: RegExp } {
  const key = aliases.join(' ');
  let res = regexCache.get(key);
  if (!res) {
    const alt = [...aliases].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    res = {
      prefixed: new RegExp(`(?<![A-Za-z0-9._-])ssh:(${alt})(?![A-Za-z0-9_-])`, 'gi'),
      bare: new RegExp(`(?<![A-Za-z0-9._:#-])(${alt})(?![A-Za-z0-9_-])`, 'gi'),
    };
    if (regexCache.size > 16) regexCache.clear();
    regexCache.set(key, res);
  }
  res.prefixed.lastIndex = 0;
  res.bare.lastIndex = 0;
  return res;
}

/** Detail keys whose values are enums / host ids the soak and tests key on —
 * never rewritten unless they are an ssh id (R40 c). */
const STRUCTURAL_KEYS = new Set(['host', 'state', 'kind', 'op', 'source', 'reason']);
/** Exact host ids other than ssh: never rewritten anywhere. */
const NON_SSH_HOST_ID = /^(local|wsl:\S+)$/;

function scrubFreeText(value: string, aliases: readonly string[], hash: (alias: string) => string): string {
  if (NON_SSH_HOST_ID.test(value)) return value;
  const { prefixed, bare } = knownAliasRes(aliases);
  const to = (alias: string): string => `ssh:#${hash(alias.toLowerCase())}`;
  return value.replace(prefixed, (_m, alias: string) => to(alias)).replace(bare, (m: string) => to(m));
}

/**
 * Free-text leak guard (R39 #6, R40 c): every configured alias appearing as
 * a whole word in a string VALUE at any depth (e.g. `ssh: Could not resolve
 * hostname box`, `box.example.com`, `ssh:box`) becomes `ssh:#<hash>`. Keys,
 * exact non-ssh host ids and the values of STRUCTURAL_KEYS are left alone.
 * Returns `value` itself when nothing changed.
 */
export function scrubKnownAliases<T>(value: T, aliases: readonly string[], hash: (alias: string) => string, depth = 0): T {
  if (aliases.length === 0) return value;
  if (typeof value === 'string') {
    const next = scrubFreeText(value, aliases, hash);
    return (next === value ? value : next) as T;
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
    const structural = STRUCTURAL_KEYS.has(key) && typeof item === 'string' && !item.startsWith('ssh:');
    const next = structural ? item : scrubKnownAliases(item, aliases, hash, depth + 1);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}
