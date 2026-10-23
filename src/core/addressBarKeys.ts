// Linked Context address bar shortcuts: T = new tab, L = edit the active
// tab's address. macOS uses Cmd only — plain Ctrl+T / Ctrl+L keep their
// terminal/readline meaning there; elsewhere Ctrl (without Meta).
export interface AddressBarKeyInput {
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export function addressBarShortcut(
  input: AddressBarKeyInput,
  platform: string,
): 'new' | 'current' | null {
  if (input.shift || input.alt) return null;
  const modifier = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!modifier) return null;
  const key = input.key.toLowerCase();
  if (key === 't') return 'new';
  if (key === 'l') return 'current';
  return null;
}
