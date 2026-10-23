// Pure helpers behind the capability-driven `SessionSidebar`.
import type { SidebarListData, SidebarSession } from '../sessionTree';
import type { CloudSourceCapabilities } from './capabilities';

/**
 * DOM id for a sidebar control: the original id when `prefix` is empty (Devin
 * keeps `sessionNew`, …), else prefix + capitalised id (`openhandsSessionNew`).
 */
export function prefixedId(prefix: string, id: string): string {
  return prefix ? `${prefix}${id.charAt(0).toUpperCase()}${id.slice(1)}` : id;
}

/**
 * The list the sidebar builds its tree from, shaped by the source's
 * capabilities: archived rows are hidden unless `showArchived` (only when the
 * source archives at all); 'derived' folders come from each row's `section`
 * (no server folder order — names sort alphabetically); 'none' drops folders.
 */
export function sidebarListData<
  S extends SidebarSession & { section?: string | undefined },
  D extends SidebarListData<S>,
>(data: D, capabilities: CloudSourceCapabilities, showArchived: boolean): D {
  const visible =
    capabilities.archive && !showArchived
      ? data.sessions.filter((s) => !s.isArchived)
      : data.sessions;
  switch (capabilities.folders) {
    case 'server':
      return { ...data, sessions: visible };
    case 'derived':
      return {
        ...data,
        folders: [],
        sessions: visible.map((s) => ({ ...s, folder: s.section ?? null })),
      };
    case 'none':
      return {
        ...data,
        folders: [],
        sessions: visible.map((s) => (s.folder === null ? s : { ...s, folder: null })),
      };
  }
}
