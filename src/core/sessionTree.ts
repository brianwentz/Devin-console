// Lays sidebar sessions out as a tree: pinned section, folder sections in the
// stored order, then an unfoldered 'recent' section. Pure — the renderer and
// tests consume this directly. Generic over SidebarSession: CloudSession and
// ClaudeSessionState both satisfy it; callers keep their full session type.

import type { SessionPrCounts } from './cloudAcp';
import type { CloudSessionState } from '../shared/ipc';

// One row of the session sidebar. A source-specific session type is mapped
// onto this before building the tree.
export interface SidebarSession {
  id: string;
  title: string;
  folder: string | null;
  parentId: string | null;
  isPinned: boolean;
  isArchived: boolean;
  /** ms epoch. */
  updatedAt: number;
  prs: SessionPrCounts;
}

// The list payload the sidebar renders.
export interface SidebarListData<S extends SidebarSession = SidebarSession> {
  sessions: S[];
  folders: string[];
  folderTotals: Record<string, number>;
  /** Folders whose listing is known to be partial; absent = infer from folderTotals. */
  incompleteFolders?: string[];
}

export interface SessionTreeNode<S extends SidebarSession = SidebarSession> {
  session: S;
  children: SessionTreeNode<S>[];
  depth: number;
  current: boolean;
}

export interface SessionTreeSection<S extends SidebarSession = SidebarSession> {
  kind: 'pinned' | 'folder' | 'recent';
  name: string;
  collapsed: boolean;
  /** folderTotals total for this section, null when unknown. */
  total: number | null;
  nodes: SessionTreeNode<S>[];
  hasMore: boolean;
}

export interface SessionTree<S extends SidebarSession = SidebarSession> {
  sections: SessionTreeSection<S>[];
}

const PINNED = 'pinned';

// Manual per-section order (ux3): ids not in the stored list come first,
// newest-first as before, then the stored ids in stored order. Unknown ids
// are skipped; sections without a stored list behave exactly as before.
export function orderRoots<S extends { id: string; updatedAt: number }>(
  sectionRoots: S[],
  stored: string[] | undefined,
  byUpdatedDesc: (a: S, b: S) => number,
): S[] {
  if (!stored) return sectionRoots.sort(byUpdatedDesc);
  const kept = new Set(stored);
  const byId = new Map(sectionRoots.map((s) => [s.id, s]));
  const fresh = sectionRoots.filter((s) => !kept.has(s.id)).sort(byUpdatedDesc);
  const ordered = stored.map((id) => byId.get(id)).filter((s): s is S => s !== undefined);
  return [...fresh, ...ordered];
}

// Full id list of a section's roots after a drop: the dragged row removed and
// re-inserted relative to the target. Drag onto itself returns the same array.
export function reorderSection(
  currentIds: string[],
  draggedId: string,
  targetId: string,
  place: 'before' | 'after',
): string[] {
  if (draggedId === targetId) return currentIds;
  const next = currentIds.filter((id) => id !== draggedId);
  const index = next.indexOf(targetId);
  if (index < 0) return currentIds;
  next.splice(place === 'before' ? index : index + 1, 0, draggedId);
  return next;
}

export function buildSessionTree<S extends SidebarSession>(
  result: SidebarListData<S>,
  opts: {
    collapsedFolders: string[];
    currentSessionId: string | null;
    sectionOrder?: Record<string, string[]>;
  },
): SessionTree<S> {
  const collapsed = new Set(opts.collapsedFolders);
  const byId = new Map(result.sessions.map((s) => [s.id, s]));

  // Children attach to their parent anywhere in the list; a child whose
  // parent is absent (or pinned — pinned sessions lift to the pinned section,
  // which is the only place a pinned session appears) becomes a root.
  const childrenOf = new Map<string, S[]>();
  const roots: S[] = [];
  for (const session of result.sessions) {
    const parent =
      session.parentId && !session.isPinned ? byId.get(session.parentId) : undefined;
    if (parent) {
      const list = childrenOf.get(parent.id) ?? [];
      list.push(session);
      childrenOf.set(parent.id, list);
    } else {
      roots.push(session);
    }
  }

  const byUpdatedDesc = (a: S, b: S) => b.updatedAt - a.updatedAt;

  const toNode = (session: S, depth: number): SessionTreeNode<S> => ({
    session,
    children: (childrenOf.get(session.id) ?? [])
      .sort(byUpdatedDesc)
      .map((child) => toNode(child, depth + 1)),
    depth,
    current: session.id === opts.currentSessionId,
  });

  const makeSection = (
    kind: SessionTreeSection<S>['kind'],
    name: string,
    sectionRoots: S[],
    keepEmpty: boolean,
  ): SessionTreeSection<S> | null => {
    if (!keepEmpty && sectionRoots.length === 0) return null;
    const total = result.folderTotals[name] ?? null;
    return {
      kind,
      name,
      collapsed: collapsed.has(name),
      total,
      nodes: orderRoots(sectionRoots, opts.sectionOrder?.[name], byUpdatedDesc).map((s) =>
        toNode(s, 0),
      ),
      hasMore: result.incompleteFolders
        ? result.incompleteFolders.includes(name)
        : total !== null && total > sectionRoots.length,
    };
  };

  const pinnedRoots = roots.filter((s) => s.isPinned);
  const unpinned = roots.filter((s) => !s.isPinned);

  const sections: SessionTreeSection<S>[] = [];
  const pinnedSection = makeSection('pinned', PINNED, pinnedRoots, false);
  if (pinnedSection) sections.push(pinnedSection);

  // Folder sections in server order ('pinned' excluded — it is a section, not
  // a folder here); names seen on sessions but absent from the order list are
  // appended alphabetically.
  const seenNames = new Set(
    unpinned.map((s) => s.folder).filter((f): f is string => f !== null),
  );
  const ordered = result.folders.filter((name) => name !== PINNED);
  const extra = [...seenNames].filter((name) => !ordered.includes(name)).sort();
  for (const name of [...ordered, ...extra]) {
    const section = makeSection(
      'folder',
      name,
      unpinned.filter((s) => s.folder === name),
      true,
    );
    if (section) sections.push(section);
  }

  const recent = makeSection(
    'recent',
    'recent',
    unpinned.filter((s) => s.folder === null),
    false,
  );
  if (recent) sections.push(recent);

  return { sections };
}

// --- optimistic sidebar mutations ----------------------------------------
// Applied to a local copy while the REST call is in flight; the next
// cloud.list (success or recorded error) replaces them.

export type CloudListData = SidebarListData<CloudSessionState>;

const withoutSessions = <S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  patch: (s: S) => S,
): D => ({
  ...data,
  sessions: data.sessions.map(patch),
});

export function moveSession<S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  id: string,
  folder: string | null,
): D {
  return withoutSessions(data, (s) =>
    s.id === id ? { ...s, folder, isPinned: folder === PINNED } : s,
  );
}

export function reorderFolders<S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  names: string[],
): D {
  const next = names.filter((name) => name !== PINNED);
  const missing = data.folders.filter((name) => name !== PINNED && !next.includes(name));
  return { ...data, folders: [...next, ...missing] };
}

export function addFolder<S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  name: string,
): D {
  if (data.folders.includes(name)) return data;
  return { ...data, folders: [...data.folders, name] };
}

export function renameFolder<S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  oldName: string,
  newName: string,
): D {
  if (oldName === newName) return data;
  const totals = { ...data.folderTotals };
  if (oldName in totals) {
    totals[newName] = totals[oldName]!;
    delete totals[oldName];
  }
  return {
    ...data,
    folders: data.folders.map((f) => (f === oldName ? newName : f)),
    folderTotals: totals,
    ...(data.incompleteFolders
      ? { incompleteFolders: data.incompleteFolders.map((f) => (f === oldName ? newName : f)) }
      : {}),
    sessions: data.sessions.map((s) => (s.folder === oldName ? { ...s, folder: newName } : s)),
  };
}

export function removeFolder<S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  name: string,
): D {
  const totals = { ...data.folderTotals };
  delete totals[name];
  return {
    ...data,
    folders: data.folders.filter((f) => f !== name),
    folderTotals: totals,
    ...(data.incompleteFolders
      ? { incompleteFolders: data.incompleteFolders.filter((f) => f !== name) }
      : {}),
    sessions: data.sessions.map((s) => (s.folder === name ? { ...s, folder: null } : s)),
  };
}

export function setArchived<S extends SidebarSession, D extends SidebarListData<S>>(
  data: D,
  id: string,
  archived: boolean,
): D {
  return withoutSessions(data, (s) => (s.id === id ? { ...s, isArchived: archived } : s));
}
