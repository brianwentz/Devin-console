// Store passthrough (ux3 S6 / D5): a build may only rewrite what it
// understands in a persisted user-data store; everything else in the file
// comes back out exactly as it went in — across upgrades and downgrades.
//
// `overlayKnown(raw, parsed, spec)` lays the in-memory value (`parsed`,
// what this build knows) over the file as read (`raw`) along a PreserveSpec
// that says which parts are *structural*:
//   - object: unknown keys in `raw` survive; known keys recurse or replace.
//   - record: membership comes from `parsed` (an absent key is a deletion);
//     unknown fields inside a matched entry survive via `item`.
//   - array (with `identity`): order and membership come from `parsed`; each
//     item is overlaid on the raw item carrying the same identity value.
//   - replace: `parsed` wins wholesale (scalars, plain arrays, records whose
//     absence means deletion — e.g. `workspaceLabels`, `windowPlacements`).
// The helper never deletes on its own: intentional migrations delete their
// source keys by name on the raw object before the overlay.

export type PreserveSpec =
  | { kind: 'object'; keys: Record<string, PreserveSpec> }
  | { kind: 'record'; item: PreserveSpec }
  | { kind: 'array'; identity: string; item: PreserveSpec }
  | { kind: 'replace' };

export const replace: PreserveSpec = { kind: 'replace' };
export const structural = (keys: Record<string, PreserveSpec> = {}): PreserveSpec => ({
  kind: 'object',
  keys,
});
export const record = (item: PreserveSpec): PreserveSpec => ({ kind: 'record', item });
export const identityArray = (identity: string, item: PreserveSpec): PreserveSpec => ({
  kind: 'array',
  identity,
  item,
});

const MAX_UNKNOWN_PATHS = 50;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Both sides must have the container shape the sub-spec expects; otherwise
// the parsed value replaces the raw one (a type change is a rewrite).
function compatible(raw: unknown, parsed: unknown, spec: PreserveSpec): boolean {
  switch (spec.kind) {
    case 'object':
    case 'record':
      return isPlainObject(raw) && isPlainObject(parsed);
    case 'array':
      return Array.isArray(raw) && Array.isArray(parsed);
    case 'replace':
      return false;
  }
}

function identityOf(item: unknown, identity: string): unknown {
  return isPlainObject(item) ? item[identity] : undefined;
}

function rawItemFor(raw: unknown[], item: unknown, identity: string): unknown {
  const id = identityOf(item, identity);
  if (id === undefined) return undefined;
  return raw.find((candidate) => identityOf(candidate, identity) === id);
}

export function overlayKnown(raw: unknown, parsed: unknown, spec: PreserveSpec): unknown {
  switch (spec.kind) {
    case 'replace':
      return parsed;
    case 'object': {
      if (!isPlainObject(parsed)) return parsed;
      // Unknown keys of `raw` (not in `parsed`) are kept. Keys the spec names
      // but `parsed` lacks are kept too: the schema knows them, this build
      // just has nothing to say (e.g. an optional field undefined in memory).
      const out: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined) continue;
        const sub = spec.keys[key];
        out[key] =
          sub && compatible(out[key], value, sub) ? overlayKnown(out[key], value, sub) : value;
      }
      return out;
    }
    case 'record': {
      if (!isPlainObject(parsed)) return parsed;
      const rawRecord = isPlainObject(raw) ? raw : {};
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined) continue;
        out[key] = compatible(rawRecord[key], value, spec.item)
          ? overlayKnown(rawRecord[key], value, spec.item)
          : value;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(parsed)) return parsed;
      const rawItems = Array.isArray(raw) ? raw : [];
      return parsed.map((item) => {
        const match = rawItemFor(rawItems, item, spec.identity);
        return compatible(match, item, spec.item) ? overlayKnown(match, item, spec.item) : item;
      });
    }
  }
}

// Dotted paths of data `overlayKnown` would carry over from `raw` that
// `parsed` did not contain (for the one-shot `store-preserved` log).
export function unknownPaths(raw: unknown, parsed: unknown, spec: PreserveSpec): string[] {
  const out: string[] = [];
  const push = (path: string): boolean => {
    if (out.length >= MAX_UNKNOWN_PATHS) return false;
    out.push(path);
    return true;
  };
  const walk = (rawValue: unknown, parsedValue: unknown, node: PreserveSpec, prefix: string): void => {
    if (out.length >= MAX_UNKNOWN_PATHS) return;
    const at = (key: string | number): string => (prefix ? `${prefix}.${key}` : String(key));
    switch (node.kind) {
      case 'replace':
        return;
      case 'object': {
        if (!isPlainObject(rawValue) || !isPlainObject(parsedValue)) return;
        for (const key of Object.keys(rawValue)) {
          const value = parsedValue[key];
          if (value === undefined) {
            if (!push(at(key))) return;
            continue;
          }
          const sub = node.keys[key];
          if (sub && compatible(rawValue[key], value, sub)) walk(rawValue[key], value, sub, at(key));
        }
        return;
      }
      case 'record': {
        if (!isPlainObject(rawValue) || !isPlainObject(parsedValue)) return;
        for (const [key, value] of Object.entries(parsedValue)) {
          if (compatible(rawValue[key], value, node.item)) walk(rawValue[key], value, node.item, at(key));
        }
        return;
      }
      case 'array': {
        if (!Array.isArray(rawValue) || !Array.isArray(parsedValue)) return;
        parsedValue.forEach((item, index) => {
          const match = rawItemFor(rawValue, item, node.identity);
          if (compatible(match, item, node.item)) {
            const id = identityOf(item, node.identity);
            walk(match, item, node.item, at(typeof id === 'string' ? id : index));
          }
        });
        return;
      }
    }
  };
  walk(raw, parsed, spec, '');
  return out;
}

// Read a dotted path from a plain-object tree (undefined when any step is
// missing or not an object).
export function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

// Write a dotted path into a plain-object tree, creating intermediate
// objects; a non-object intermediate is replaced.
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = root;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (isPlainObject(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  node[keys[keys.length - 1]!] = value;
}
