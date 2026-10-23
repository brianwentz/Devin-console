// Drag-and-drop of links onto the Linked Context tab row (pure).

// Sidebar row/folder drags (shell `components/sidebar/dnd.ts` re-exports them).
export const SESSION_MIME = 'application/x-devin-session';
export const FOLDER_MIME = 'application/x-devin-folder';
const INTERNAL_TYPES = [SESSION_MIME, FOLDER_MIME];

// Ordered by preference: browsers put the link in text/uri-list, selected text
// in text/plain; `URL` is the legacy IE/Edge name some sources still set.
// `URL` is rarely reachable in Chromium: setData('URL') is normalised to text/uri-list.
const URL_TYPES = ['text/uri-list', 'text/plain', 'URL'];

const MAX_TYPES = 32;
const MAX_TYPE_LENGTH = 128;

function internal(types: readonly string[]): boolean {
  return types.some((type) => INTERNAL_TYPES.includes(type));
}

// Whether a drag (judged on its types — values are unreadable during dragover)
// may be dropped on the tab row.
export function isUrlDrag(types: readonly string[]): boolean {
  return !internal(types) && types.some((type) => URL_TYPES.includes(type));
}

// The raw text to open, or null. Validation is main's job (`normalizeUserUrl`).
export function pickDroppedUrl(
  getData: (type: string) => string,
  types: readonly string[],
): string | null {
  if (internal(types)) return null;
  if (types.includes('text/uri-list')) {
    // RFC 2483: CRLF-separated, `#` lines are comments.
    const line = getData('text/uri-list')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry !== '' && !entry.startsWith('#'));
    if (line) return line;
  }
  for (const type of ['text/plain', 'URL']) {
    if (!types.includes(type)) continue;
    const text = getData(type).trim();
    if (text !== '') return text;
  }
  return null;
}

// MIME type names for the drop diagnostic, bounded like its IPC schema.
export function safeDropTypes(types: readonly unknown[]): string[] {
  return types
    .filter((type): type is string => typeof type === 'string')
    .slice(0, MAX_TYPES)
    .map((type) => type.slice(0, MAX_TYPE_LENGTH));
}
