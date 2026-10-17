import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const INSTALL_GUIDANCE =
  'Claude Code is not installed or was not found on PATH. Install it from https://docs.anthropic.com/en/docs/claude-code or set the path in Settings.';

// Resolve the `claude` executable: explicit override (settings.claude.path —
// must exist), else PATH lookup via `where` (Windows) / `which` (POSIX).
// Returns null when nothing is found.
export function resolveClaudePath(override: string | null | undefined): string | null {
  if (override) return existsSync(override) ? override : null;
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(lookup, ['claude'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}
