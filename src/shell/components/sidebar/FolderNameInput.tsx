// Inline folder-name editor shared by create and rename.
export function FolderNameInput({
  initial = '',
  placeholder,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      id="sessionFolderEdit"
      type="text"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      className="w-full h-6 px-1.5 rounded bg-[#141d29] border border-[#54749c] text-xs placeholder-[#5c6b80] focus:outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const name = e.currentTarget.value.trim();
          if (name) onCommit(name);
        } else if (e.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}
