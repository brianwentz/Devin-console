// Claude session registry (pure): the userData/claude-sessions.json shape
// plus the reconcile that folds the SDK store list into sidebar rows.
// Entries are created lazily — a store session only gains a registry entry
// when a mutation touches it, so the file stays small.

import { z } from 'zod';
import type { ClaudeSessionState } from '../shared/ipc';

export interface ClaudeStoreSession {
  id: string;
  title: string;
  cwd: string | null;
  gitBranch: string | null;
  tag: string | null;
  createdAt: number | null;
  lastModified: number;
  fileSize: number | null;
}

export interface ClaudeRegistryEntry {
  id: string;
  folder: string | null;
  pinned: boolean;
  archived: boolean;
  /** Set by auto-archive; null when archived manually or not archived. */
  archivedAt: number | null;
  /** Manual Unarchive timestamp — suppresses auto-archive until
   * lastModified > unarchivedAt. */
  unarchivedAt: number | null;
  removed: boolean;
  removedAt: number | null;
  lastOpenedAt: number | null;
  /** PR urls associated with the session (filled by later phases). */
  prUrls: string[];
}

export interface ClaudeRegistry {
  version: 1;
  folders: string[];
  entries: Record<string, ClaudeRegistryEntry>;
}

export const emptyRegistry = (): ClaudeRegistry => ({
  version: 1,
  folders: [],
  entries: {},
});

export const ClaudeRegistrySchema: z.ZodType<ClaudeRegistry> = z.object({
  version: z.literal(1),
  folders: z.array(z.string()),
  entries: z.record(
    z.string(),
    z.object({
      id: z.string(),
      folder: z.string().nullable(),
      pinned: z.boolean(),
      archived: z.boolean(),
      archivedAt: z.number().nullable(),
      unarchivedAt: z.number().nullable(),
      removed: z.boolean(),
      removedAt: z.number().nullable(),
      lastOpenedAt: z.number().nullable(),
      prUrls: z.array(z.string()),
    }),
  ),
});

const ZERO_PRS = { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 };

const newEntry = (id: string): ClaudeRegistryEntry => ({
  id,
  folder: null,
  pinned: false,
  archived: false,
  archivedAt: null,
  unarchivedAt: null,
  removed: false,
  removedAt: null,
  lastOpenedAt: null,
  prUrls: [],
});

const DAY_MS = 86_400_000;

export function reconcile(
  reg: ClaudeRegistry,
  store: ClaudeStoreSession[],
  opts: { now: number; autoArchiveDays: number },
): { registry: ClaudeRegistry; sessions: ClaudeSessionState[]; changed: boolean } {
  let changed = false;
  const entries: Record<string, ClaudeRegistryEntry> = { ...reg.entries };
  const storeById = new Map(store.map((s) => [s.id, s]));
  const sessions: ClaudeSessionState[] = [];

  // Un-remove: a removed entry whose transcript was modified after removal
  // was resumed elsewhere (a terminal, another device) — bring it back.
  for (const [id, entry] of Object.entries(entries)) {
    const stored = storeById.get(id);
    if (entry.removed && stored && entry.removedAt !== null && stored.lastModified > entry.removedAt) {
      entries[id] = { ...entry, removed: false, removedAt: null };
      changed = true;
    }
  }

  // Emit one row per non-removed store session.
  for (const stored of store) {
    const entry = entries[stored.id];
    if (entry?.removed) continue;
    sessions.push({
      id: stored.id,
      title: stored.title,
      cwd: stored.cwd,
      gitBranch: stored.gitBranch,
      tag: stored.tag,
      createdAt: stored.createdAt,
      updatedAt: stored.lastModified,
      folder: entry?.folder ?? null,
      parentId: null,
      isPinned: entry?.pinned ?? false,
      isArchived: entry?.archived ?? false,
      missing: false,
      agentStatus: null,
      prs: { ...ZERO_PRS },
    });
  }

  // Entries with no store session survive only while pinned or foldered;
  // otherwise they are dropped.
  for (const [id, entry] of Object.entries(entries)) {
    if (storeById.has(id)) continue;
    if (entry.removed) continue;
    if (entry.pinned || entry.folder !== null) {
      sessions.push({
        id,
        title: '(transcript missing)',
        cwd: null,
        gitBranch: null,
        tag: null,
        createdAt: null,
        updatedAt: entry.lastOpenedAt ?? 0,
        folder: entry.folder,
        parentId: null,
        isPinned: entry.pinned,
        isArchived: entry.archived,
        missing: true,
        agentStatus: null,
        prs: { ...ZERO_PRS },
      });
    } else {
      delete entries[id];
      changed = true;
    }
  }

  // Auto-archive: idle sessions that are not pinned, not foldered, and not
  // already archived. autoArchiveDays 0 disables it entirely.
  if (opts.autoArchiveDays > 0) {
    const cutoff = opts.now - opts.autoArchiveDays * DAY_MS;
    for (const stored of store) {
      const entry = entries[stored.id];
      if (entry?.removed) continue;
      const pinned = entry?.pinned ?? false;
      const folder = entry?.folder ?? null;
      const archived = entry?.archived ?? false;
      const unarchivedAt = entry?.unarchivedAt ?? null;
      const eligible =
        !pinned &&
        folder === null &&
        !archived &&
        stored.lastModified < cutoff &&
        (unarchivedAt === null || stored.lastModified > unarchivedAt);
      if (eligible) {
        entries[stored.id] = {
          ...(entry ?? newEntry(stored.id)),
          archived: true,
          archivedAt: opts.now,
        };
        changed = true;
        // Keep the emitted row in sync.
        const row = sessions.find((s) => s.id === stored.id);
        if (row) row.isArchived = true;
      }
    }
  }

  return {
    registry: changed ? { ...reg, entries } : reg,
    sessions,
    changed,
  };
}

// --- mutations ------------------------------------------------------------

const withEntry = (
  reg: ClaudeRegistry,
  id: string,
  patch: Partial<ClaudeRegistryEntry>,
): ClaudeRegistry => ({
  ...reg,
  entries: { ...reg.entries, [id]: { ...(reg.entries[id] ?? newEntry(id)), ...patch } },
});

export function setFolder(
  reg: ClaudeRegistry,
  id: string,
  folder: string | null,
): ClaudeRegistry {
  return withEntry(reg, id, { folder });
}

export function setPinned(
  reg: ClaudeRegistry,
  id: string,
  pinned: boolean,
): ClaudeRegistry {
  return withEntry(reg, id, { pinned });
}

export function setArchived(
  reg: ClaudeRegistry,
  id: string,
  archived: boolean,
  now: number,
): ClaudeRegistry {
  // Manual archive has no archivedAt (that marker means auto-archive).
  // Manual unarchive records unarchivedAt so auto-archive leaves the session
  // alone until it is modified again.
  return withEntry(
    reg,
    id,
    archived
      ? { archived: true, archivedAt: null, unarchivedAt: null }
      : { archived: false, archivedAt: null, unarchivedAt: now },
  );
}

export function setRemoved(
  reg: ClaudeRegistry,
  id: string,
  now: number,
): ClaudeRegistry {
  return withEntry(reg, id, { removed: true, removedAt: now });
}

export function touchOpened(
  reg: ClaudeRegistry,
  id: string,
  now: number,
): ClaudeRegistry {
  return withEntry(reg, id, { lastOpenedAt: now });
}

// Folder ops mirror sessionTree's rules: create appends unseen names, rename
// moves member entries, delete unfolders members, reorder keeps unknown
// names appended.
export function folderCreate(reg: ClaudeRegistry, name: string): ClaudeRegistry {
  if (reg.folders.includes(name)) return reg;
  return { ...reg, folders: [...reg.folders, name] };
}

export function folderRename(
  reg: ClaudeRegistry,
  oldName: string,
  newName: string,
): ClaudeRegistry {
  if (!reg.folders.includes(oldName) || oldName === newName) return reg;
  const entries = { ...reg.entries };
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.folder === oldName) entries[id] = { ...entry, folder: newName };
  }
  return {
    ...reg,
    folders: reg.folders.map((n) => (n === oldName ? newName : n)),
    entries,
  };
}

export function folderDelete(reg: ClaudeRegistry, name: string): ClaudeRegistry {
  if (!reg.folders.includes(name)) return reg;
  const entries = { ...reg.entries };
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.folder === name) entries[id] = { ...entry, folder: null };
  }
  return { ...reg, folders: reg.folders.filter((n) => n !== name), entries };
}

export function folderReorder(reg: ClaudeRegistry, names: string[]): ClaudeRegistry {
  const rest = reg.folders.filter((n) => !names.includes(n));
  return { ...reg, folders: [...names.filter((n) => reg.folders.includes(n)), ...rest] };
}
