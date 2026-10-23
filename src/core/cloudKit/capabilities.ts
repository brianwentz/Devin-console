// What a cloud session source supports in the shared session sidebar
// (pure — no electron). Read by `SessionSidebar` (which controls to render)
// and the source's main-side context menu (which items to offer).
//
// - `folders`: 'server' = user folders stored by the backend (create/rename/
//   delete/move/reorder); 'derived' = read-only grouping from each row's
//   `section` (e.g. by repository); 'none' = no grouping beyond pinned/recent.
// - `archive`: archive/unarchive items + the "show archived" toggle.
// - `rename` / `delete`: per-session rename / delete actions.
// - `reorder`: manual row order within a section (app-local).
export interface CloudSourceCapabilities {
  folders: 'server' | 'derived' | 'none';
  archive: boolean;
  rename: boolean;
  delete: boolean;
  reorder: boolean;
}

// Devin Cloud as the UI offers it today: server folders, archive/unarchive,
// row reorder; no per-session rename or delete in the sidebar.
export const DEVIN_CLOUD_CAPABILITIES: CloudSourceCapabilities = {
  folders: 'server',
  archive: true,
  rename: false,
  delete: false,
  reorder: true,
};
