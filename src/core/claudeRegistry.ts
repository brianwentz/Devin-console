// Claude session registry (pure): the userData/claude-sessions.json shape
// plus the reconcile that folds the SDK store list into sidebar rows.
// Entries are created lazily — a store session only gains a registry entry
// when a mutation touches it, so the file stays small.

import { z } from 'zod';
import { workspaceFor } from './workspaceTree';
import type { HostId as ExecHostId } from './execHost';
import type { HostId, ClaudeSessionState } from '../shared/ipc';
import type { SessionPrCounts } from './cloudAcp';

export interface ClaudeStoreSession {
  id: string;
  host: HostId;
  title: string;
  cwd: string | null;
  gitBranch: string | null;
  tag: string | null;
  createdAt: number | null;
  lastModified: number;
  fileSize: number | null;
}

export type ClaudePrState = 'open' | 'draft' | 'merged' | 'closed';

export interface ClaudeRegistryPr {
  url: string;
  /** Last state read from the GitHub PR page; null until known (counts as open). */
  state: ClaudePrState | null;
  /** Last time the URL was observed (recordPr touches it on re-detection). */
  seenAt: number;
  /** Set once when the state first flips to merged|closed (notified once). */
  completedAt: number | null;
  source: 'chat' | 'terminal' | 'hook';
}

/** Per-session cap on recorded PRs; recordPr drops completed-oldest first. */
export const MAX_PRS_PER_SESSION = 20;

export interface ClaudeRegistryEntry {
  id: string;
  host: HostId;
  /** ux2 P4b: legacy free-form folder name, in-memory only after load —
   * consumed by the one-shot workspace migration and stripped on save. */
  folder?: string | null;
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
  /** PRs detected for the session (chat links, terminal output, hooks). */
  prs: ClaudeRegistryPr[];
}

export interface ClaudeRegistry {
  version: 1;
  /** Legacy free-form folder names, in-memory only after load (P4b
   * migration consumes them once); never written back to disk. */
  legacyFolders?: string[];
  entries: Record<string, ClaudeRegistryEntry>;
}

export const emptyRegistry = (): ClaudeRegistry => ({
  version: 1,
  entries: {},
});

/** Serialised form: legacy `folder`/`folders` fields are stripped (P4b —
 * workspaces live in settings.claude.workspaces now). */
export function serializeRegistry(reg: ClaudeRegistry): string {
  const entries = Object.fromEntries(
    Object.entries(reg.entries).map(([id, entry]) => {
      const { folder: _folder, ...rest } = entry;
      return [id, rest];
    }),
  );
  return JSON.stringify({ version: reg.version, entries });
}

const PrStateSchema = z.enum(['open', 'draft', 'merged', 'closed']);

const RegistryPrSchema = z.object({
  url: z.string(),
  state: PrStateSchema.nullable(),
  seenAt: z.number(),
  completedAt: z.number().nullable(),
  source: z.enum(['chat', 'terminal', 'hook']),
});

const legacyPr = (url: string): ClaudeRegistryPr => ({
  url,
  state: null,
  seenAt: 0,
  completedAt: null,
  source: 'chat',
});

// Legacy entries carry `prUrls: string[]`; they are migrated
// to `prs` on load (version stays 1). Both keys are optional in the raw shape
// so either generation parses; the output always has `prs`.
const RegistryEntrySchema = z
  .object({
    id: z.string(),
    // Execution host; legacy files lack it and default to 'local'.
    host: z.string().default('local'),
    // Legacy free-form folder (P4b strips it on save); absent in new files.
    folder: z.string().nullable().optional(),
    pinned: z.boolean(),
    archived: z.boolean(),
    archivedAt: z.number().nullable(),
    unarchivedAt: z.number().nullable(),
    removed: z.boolean(),
    removedAt: z.number().nullable(),
    lastOpenedAt: z.number().nullable(),
    prUrls: z.array(z.string()).optional(),
    prs: z.array(RegistryPrSchema).optional(),
  })
  .transform(({ prUrls, prs, folder, ...rest }): ClaudeRegistryEntry => ({
    ...rest,
    ...(folder !== undefined ? { folder } : {}),
    prs: prs ?? (prUrls ?? []).map(legacyPr),
  }));

export const ClaudeRegistrySchema: z.ZodType<ClaudeRegistry, unknown> = z
  .object({
    version: z.literal(1),
    // Legacy: folder names kept for the one-shot migration, then dropped.
    folders: z.array(z.string()).optional(),
    entries: z.record(z.string(), RegistryEntrySchema),
  })
  .transform(({ folders, ...rest }): ClaudeRegistry => ({
    ...rest,
    ...(folders ? { legacyFolders: folders } : {}),
  }));

const newEntry = (id: string, host: HostId = 'local'): ClaudeRegistryEntry => ({
  id,
  host,
  pinned: false,
  archived: false,
  archivedAt: null,
  unarchivedAt: null,
  removed: false,
  removedAt: null,
  lastOpenedAt: null,
  prs: [],
});

const isFinal = (state: ClaudePrState | null): boolean =>
  state === 'merged' || state === 'closed';

/** Sidebar badge counts for an entry: unknown state counts as open, queued is
 * always 0 (Claude PRs have no merge queue signal). */
export function prCountsFor(entry: ClaudeRegistryEntry | undefined): SessionPrCounts {
  const counts: SessionPrCounts = { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 };
  for (const pr of entry?.prs ?? []) counts[pr.state ?? 'open'] += 1;
  return counts;
}

/** PRs still in flight across non-removed entries, newest seenAt first
 * (ties broken by url so the order is stable). */
export function openPrsOf(
  reg: ClaudeRegistry,
): Array<{ sessionId: string; pr: ClaudeRegistryPr }> {
  const out: Array<{ sessionId: string; pr: ClaudeRegistryPr }> = [];
  for (const [sessionId, entry] of Object.entries(reg.entries)) {
    if (entry.removed) continue;
    for (const pr of entry.prs) if (!isFinal(pr.state)) out.push({ sessionId, pr });
  }
  return out.sort(
    (a, b) => b.pr.seenAt - a.pr.seenAt || (a.pr.url < b.pr.url ? -1 : a.pr.url > b.pr.url ? 1 : 0),
  );
}

const DAY_MS = 86_400_000;

export function reconcile(
  reg: ClaudeRegistry,
  store: ClaudeStoreSession[],
  opts: {
    now: number;
    autoArchiveDays: number;
    /** Path-bound workspaces (settings.claude.workspaces) — a session's folder
     * is derived by exact (host,cwd) match, never stored (ux2 D8). */
    workspaces: string[];
    uncRoot?: string | undefined;
    uncHostId?: ExecHostId | undefined;
  },
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
    // Entries created lazily by a mutation default to 'local' — stamp the
    // host the store row actually came from.
    if (entry && entry.host !== stored.host) {
      entries[stored.id] = { ...entry, host: stored.host };
      changed = true;
    }
    sessions.push({
      id: stored.id,
      host: stored.host,
      title: stored.title,
      cwd: stored.cwd,
      gitBranch: stored.gitBranch,
      tag: stored.tag,
      createdAt: stored.createdAt,
      updatedAt: stored.lastModified,
      folder: workspaceFor(opts.workspaces, { host: stored.host as ExecHostId, cwd: stored.cwd }, {
        uncRoot: opts.uncRoot,
        uncHostId: opts.uncHostId,
      }),
      parentId: null,
      isPinned: entry?.pinned ?? false,
      isArchived: entry?.archived ?? false,
      missing: false,
      agentStatus: null,
      activity: null,
      subagents: null,
      prs: prCountsFor(entry),
    });
  }

  // Entries with no store session survive only while pinned; otherwise they
  // are dropped. (ux2 P4b: a legacy `folder` no longer keeps them — with no
  // transcript there is no cwd to file under anyway.)
  for (const [id, entry] of Object.entries(entries)) {
    if (storeById.has(id)) continue;
    if (entry.removed) continue;
    if (entry.pinned) {
      sessions.push({
        id,
        host: entry.host,
        title: '(transcript missing)',
        cwd: null,
        gitBranch: null,
        tag: null,
        createdAt: null,
        updatedAt: entry.lastOpenedAt ?? 0,
        folder: null,
        parentId: null,
        isPinned: entry.pinned,
        isArchived: entry.archived,
        missing: true,
        agentStatus: null,
        activity: null,
        subagents: null,
        prs: prCountsFor(entry),
      });
    } else {
      delete entries[id];
      changed = true;
    }
  }

  // Auto-archive: idle sessions that are not pinned, not in any workspace
  // (derived), and not already archived. autoArchiveDays 0 disables it.
  if (opts.autoArchiveDays > 0) {
    const cutoff = opts.now - opts.autoArchiveDays * DAY_MS;
    for (const stored of store) {
      const entry = entries[stored.id];
      if (entry?.removed) continue;
      const pinned = entry?.pinned ?? false;
      const folder = workspaceFor(opts.workspaces, { host: stored.host as ExecHostId, cwd: stored.cwd }, {
        uncRoot: opts.uncRoot,
        uncHostId: opts.uncHostId,
      });
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
          ...(entry ?? newEntry(stored.id, stored.host)),
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

/** Record a detected PR URL on a session (entry created lazily). A URL
 * already present only gets its seenAt touched (`added: false`). Over
 * MAX_PRS_PER_SESSION the oldest completed PR is dropped first, then the
 * oldest overall. */
export function recordPr(
  reg: ClaudeRegistry,
  id: string,
  url: string,
  source: ClaudeRegistryPr['source'],
  now: number,
): { registry: ClaudeRegistry; added: boolean } {
  const entry = reg.entries[id] ?? newEntry(id);
  const idx = entry.prs.findIndex((p) => p.url === url);
  if (idx !== -1) {
    const prs = entry.prs.map((p, i) => (i === idx ? { ...p, seenAt: now } : p));
    return { registry: withEntry(reg, id, { prs }), added: false };
  }
  const prs = [...entry.prs, { url, state: null, seenAt: now, completedAt: null, source }];
  while (prs.length > MAX_PRS_PER_SESSION) {
    const pool = prs.some((p) => p.completedAt !== null)
      ? prs.filter((p) => p.completedAt !== null)
      : prs;
    const oldest = pool.reduce((a, b) => (b.seenAt < a.seenAt ? b : a));
    prs.splice(prs.indexOf(oldest), 1);
  }
  return { registry: withEntry(reg, id, { prs }), added: true };
}

/** Update a recorded PR's state. `completed` is true exactly once: when the
 * state becomes merged|closed and completedAt was still null. Returns the
 * same registry object when nothing changes. */
export function setPrState(
  reg: ClaudeRegistry,
  id: string,
  url: string,
  state: ClaudePrState | null,
  now: number,
): { registry: ClaudeRegistry; completed: boolean } {
  const entry = reg.entries[id];
  const idx = entry?.prs.findIndex((p) => p.url === url) ?? -1;
  if (!entry || idx === -1) return { registry: reg, completed: false };
  const pr = entry.prs[idx]!;
  if (pr.state === state) return { registry: reg, completed: false };
  const completed = isFinal(state) && pr.completedAt === null;
  const next: ClaudeRegistryPr = { ...pr, state, completedAt: completed ? now : pr.completedAt };
  const prs = entry.prs.map((p, i) => (i === idx ? next : p));
  return { registry: withEntry(reg, id, { prs }), completed };
}

// (P4b deleted the free-form folder reducers — workspaces are settings.)
// names appended.



