// Shared sidebar drag/drop + section naming. 'pinned'/'participated' are
// system folders: not editable/reorderable, but they ARE move targets.
export { FOLDER_MIME, SESSION_MIME } from '../../../core/dropUrl';

export const SECTION_LABELS: Record<string, string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  participated: 'Participated',
};

export const isEditableFolder = (name: string) => name !== 'pinned' && name !== 'participated';
export const isMoveTarget = (section: { kind: string }) =>
  section.kind === 'folder' || section.kind === 'recent';

// The SESSION_MIME payload is unreadable during dragover, so a bubbling
// dragstart on the ReorderableRow wrapper records the drag here; cleared on
// dragend. Cross-section row drags are refused by comparing `section`.
export const dragState: { current: { id: string; section: string } | null } = {
  current: null,
};
