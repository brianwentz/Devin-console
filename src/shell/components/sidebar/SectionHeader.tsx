import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { SessionTreeSection } from '../../../core/sessionTree';
import { sessionFolderHeaderClass } from '../sessionRowStyles';
import { FolderNameInput } from './FolderNameInput';
import { FOLDER_MIME, isEditableFolder, isMoveTarget, SECTION_LABELS, SESSION_MIME } from './dnd';

// Collapsible section header with folder drag/drop targets and an optional
// "new in folder" button (Cloud only — Claude folders have no such
// action).
export function SectionHeader({
  section,
  userFolderNames,
  renaming,
  onRenameCommit,
  onRenameCancel,
  onToggle,
  onMenu,
  onMove,
  onReorder,
  onNewInFolder,
  label,
  title,
  leading,
  dataAttrs,
  moveDisabled = false,
  reorderable = true,
}: {
  section: SessionTreeSection;
  userFolderNames: string[];
  renaming: boolean;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onToggle: (name: string) => void;
  onMenu: (name: string, x: number, y: number) => void;
  onMove: (sessionId: string, folder: string | null) => void;
  onReorder: (names: string[]) => void;
  onNewInFolder?: (name: string) => void;
  // Optional display label rendered instead of section.name (e.g. a workspace
  // label while the path stays the section key).
  label?: string;
  // Optional tooltip on the header button (e.g. the long workspace path).
  title?: string;
  // Optional leading node (e.g. an agent status dot) before the label.
  leading?: ReactNode;
  // Extra data-* attributes on the header button (e.g. agent status).
  dataAttrs?: Record<string, string>;
  // ux2 D7: path-bound workspaces are filing only — no session-move drops.
  moveDisabled?: boolean;
  // ux3 S1b: no ghost drag when there is nothing to reorder (one folder).
  reorderable?: boolean;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const [dropBefore, setDropBefore] = useState(false);

  if (renaming) {
    return (
      <div className="px-1 py-1">
        <FolderNameInput
          initial={section.name}
          placeholder="Folder name"
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      </div>
    );
  }

  return (
    <span className="group flex items-center">
      <button
        type="button"
        data-section-kind={section.kind}
        data-section-name={section.name}
        {...(title !== undefined ? { title } : {})}
        {...dataAttrs}
        data-drop-target={dropTarget}
        data-drop-before={dropBefore}
        draggable={
          reorderable && section.kind === 'folder' && isEditableFolder(section.name)
        }
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_MIME, section.name);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (types.includes(SESSION_MIME) && !moveDisabled && isMoveTarget(section)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropTarget(true);
          } else if (
            types.includes(FOLDER_MIME) &&
            section.kind === 'folder' &&
            isEditableFolder(section.name)
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropBefore(true);
          }
        }}
        onDragLeave={() => {
          setDropTarget(false);
          setDropBefore(false);
        }}
        onDrop={(e) => {
          const sessionId = e.dataTransfer.getData(SESSION_MIME);
          const target = !moveDisabled && isMoveTarget(section)
            ? section.kind === 'recent'
              ? null
              : section.name
            : undefined;
          if (sessionId && target !== undefined) {
            e.preventDefault();
            onMove(sessionId, target);
          }
          const folder = e.dataTransfer.getData(FOLDER_MIME);
          if (
            folder &&
            folder !== section.name &&
            section.kind === 'folder' &&
            isEditableFolder(section.name)
          ) {
            e.preventDefault();
            const names = userFolderNames.filter((n) => n !== folder);
            names.splice(names.indexOf(section.name), 0, folder);
            onReorder(names);
          }
          setDropTarget(false);
          setDropBefore(false);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (section.kind === 'folder' && isEditableFolder(section.name)) {
            onMenu(section.name, e.clientX, e.clientY);
          }
        }}
        className={`flex-1 min-w-0 flex items-center gap-1 px-1 py-1 ${sessionFolderHeaderClass} text-[#8b9bb0] hover:text-[#c9d4e3] data-[drop-target=true]:bg-[#1f2f42] data-[drop-before=true]:border-t-2 data-[drop-before=true]:border-t-[#54749c]`}
        onClick={() => onToggle(section.name)}
      >
        {section.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        {leading}
        <span className="flex-1 text-left truncate" data-section-label={label ?? section.name}>
          {label ?? SECTION_LABELS[section.name] ?? section.name}
        </span>
        <span className="text-[11px] leading-[14px] text-[#5c6b80]">
          {section.total !== null
            ? `${section.nodes.length} / ${section.total}`
            : section.nodes.length}
        </span>
      </button>
      {section.kind === 'folder' && isEditableFolder(section.name) && onNewInFolder && (
        <button
          type="button"
          data-folder-new-session={section.name}
          aria-label="New session in folder"
          title="New session in folder"
          className="w-5 h-5 mr-1 shrink-0 flex items-center justify-center rounded text-[#5c6b80] hover:text-[#c9d4e3] hover:bg-[#1a2735] opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onNewInFolder(section.name);
          }}
        >
          <Plus size={12} />
        </button>
      )}
    </span>
  );
}
