// Pure parsers for Chrome's `Bookmarks` and `Local State` files and the shaping of a
// bookmark tree into a native-menu description. Pure — no electron, no fs.

import { z } from 'zod';

export interface BookmarkNode {
  kind: 'url' | 'folder';
  name: string;
  url?: string;
  children?: BookmarkNode[];
}
export interface BookmarkTree {
  bar: BookmarkNode[];
  other: BookmarkNode[];
  mobile: BookmarkNode[];
}
export type FavoritesMenuNode =
  | { kind: 'url'; label: string; url: string }
  | { kind: 'folder'; label: string; children: FavoritesMenuNode[] }
  | { kind: 'more'; label: string };

const DEFAULT_MAX_PER_FOLDER = 200;
const DEFAULT_MAX_LABEL = 80;
const MAX_DEPTH = 32;
const UNTITLED_FOLDER = '(untitled folder)';

// Tolerant: every field optional, unknown keys kept; nodes are validated by hand below.
const RawNodeSchema = z
  .object({ type: z.string().optional(), name: z.string().optional(), url: z.string().optional(), children: z.array(z.unknown()).optional() })
  .passthrough();
const BookmarksFileSchema = z.object({ roots: z.object({}).passthrough() }).passthrough();

function convertNodes(raw: unknown[] | undefined, depth: number): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  if (!raw || depth > MAX_DEPTH) return out;
  for (const item of raw) {
    const parsed = RawNodeSchema.safeParse(item);
    if (!parsed.success) continue;
    const n = parsed.data;
    if (n.type === 'url' && typeof n.url === 'string') {
      out.push({ kind: 'url', name: n.name ?? '', url: n.url });
    } else if (n.type === 'folder') {
      out.push({ kind: 'folder', name: n.name ?? '', children: convertNodes(n.children, depth + 1) });
    }
    // Any other node type is skipped, not a parse failure.
  }
  return out;
}

function convertRoot(root: unknown): BookmarkNode[] {
  const parsed = RawNodeSchema.safeParse(root);
  return parsed.success ? convertNodes(parsed.data.children, 0) : [];
}

export function parseChromeBookmarks(json: unknown): BookmarkTree | null {
  const file = BookmarksFileSchema.safeParse(json);
  if (!file.success) return null;
  const roots = file.data.roots as Record<string, unknown>;
  if (!('bookmark_bar' in roots) && !('other' in roots) && !('synced' in roots)) return null;
  return { bar: convertRoot(roots.bookmark_bar), other: convertRoot(roots.other), mobile: convertRoot(roots.synced) };
}

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// Order matters: truncate the raw text first, then double each `&` (Electron treats a
// single `&` as an accelerator marker), so the cap counts what the user sees in the menu
// source text and an escape can never be cut in half.
function menuLabel(raw: string, maxLabel: number): string {
  const text = raw.length > maxLabel ? raw.slice(0, Math.max(0, maxLabel - 1)) + '…' : raw;
  return text.replace(/&/g, '&&');
}

function shapeList(nodes: BookmarkNode[], maxPerFolder: number, maxLabel: number): FavoritesMenuNode[] {
  const items: FavoritesMenuNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'url') {
      const u = n.url ? safeUrl(n.url) : null;
      if (!u) continue;
      const name = n.name.trim() || u.hostname;
      items.push({ kind: 'url', label: menuLabel(name, maxLabel), url: n.url! });
    } else {
      const children = shapeList(n.children ?? [], maxPerFolder, maxLabel);
      if (children.length === 0) continue;
      items.push({ kind: 'folder', label: menuLabel(n.name.trim() || UNTITLED_FOLDER, maxLabel), children });
    }
  }
  return capList(items, maxPerFolder);
}

function capList(items: FavoritesMenuNode[], max: number): FavoritesMenuNode[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), { kind: 'more', label: `… ${items.length - max} more` }];
}

export function buildFavoritesMenu(
  tree: BookmarkTree,
  opts: { maxPerFolder?: number; maxLabel?: number } = {},
): FavoritesMenuNode[] {
  const maxPerFolder = opts.maxPerFolder ?? DEFAULT_MAX_PER_FOLDER;
  const maxLabel = opts.maxLabel ?? DEFAULT_MAX_LABEL;
  const top: BookmarkNode[] = [
    ...tree.bar,
    { kind: 'folder', name: 'Other bookmarks', children: tree.other },
    { kind: 'folder', name: 'Mobile bookmarks', children: tree.mobile },
  ];
  // Shape uncapped, then cap the top level like any other folder.
  const shaped = shapeList(top, Number.MAX_SAFE_INTEGER, maxLabel);
  return capAll(shaped, maxPerFolder);
}

function capAll(items: FavoritesMenuNode[], max: number): FavoritesMenuNode[] {
  return capList(
    items.map((n) => (n.kind === 'folder' ? { ...n, children: capAll(n.children, max) } : n)),
    max,
  );
}

export function isValidProfileDir(dir: string): boolean {
  return dir === 'Default' || /^Profile \d+$/.test(dir);
}

function profileOrder(dir: string): number {
  return dir === 'Default' ? -1 : Number(dir.slice('Profile '.length));
}

const LocalStateSchema = z
  .object({
    profile: z
      .object({
        info_cache: z.record(z.string(), z.unknown()).optional(),
        last_used: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseLocalState(json: unknown): { profiles: { dir: string; name: string }[]; lastUsed: string | null } {
  const parsed = LocalStateSchema.safeParse(json);
  const profile = parsed.success ? parsed.data.profile : undefined;
  if (!profile) return { profiles: [], lastUsed: null };
  const profiles = Object.entries(profile.info_cache ?? {})
    .filter(([dir]) => isValidProfileDir(dir))
    .map(([dir, info]) => {
      const name = (info as { name?: unknown } | null)?.name;
      return { dir, name: typeof name === 'string' && name.trim() ? name : dir };
    })
    .sort((a, b) => profileOrder(a.dir) - profileOrder(b.dir));
  const last = profile.last_used;
  return { profiles, lastUsed: last !== undefined && isValidProfileDir(last) ? last : null };
}
