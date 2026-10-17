// Shared sidebar drag/drop + section naming. 'pinned'/'participated' are
// system folders: not editable/reorderable, but they ARE move targets.
export const SESSION_MIME = 'application/x-devin-session';
export const FOLDER_MIME = 'application/x-devin-folder';

export const SECTION_LABELS: Record<string, string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  participated: 'Participated',
};

export const isEditableFolder = (name: string) => name !== 'pinned' && name !== 'participated';
export const isMoveTarget = (section: { kind: string }) =>
  section.kind === 'folder' || section.kind === 'recent';
