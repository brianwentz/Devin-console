import { hostIdForPath } from './execHost';

// Leaf module: shared by shared/ipc.ts (schema) and settingsDraft.ts (draft) —
// import nothing from either to keep the graph acyclic.

/** Literal placeholder replaced by the canonical PR URL in the review command. */
export const REVIEW_URL_TOKEN = '{github-url}';

export const DEFAULT_REVIEW_COMMAND = `/cb:review ${REVIEW_URL_TOKEN}`;

export const MAX_REVIEW_COMMAND_LENGTH = 500;

/** Devin CLI `--permission-mode` values (devin 3000.11.3). */
export const DEVIN_CLI_PERMISSION_MODES = [
  { id: 'auto', name: 'Auto' },
  { id: 'accept-edits', name: 'Accept edits' },
  { id: 'smart', name: 'Smart' },
  { id: 'dangerous', name: 'Dangerous' },
] as const;

export type DevinCliPermissionMode = (typeof DEVIN_CLI_PERMISSION_MODES)[number]['id'];

/** 1..500 chars, contains the URL token, single line. */
export function isValidReviewCommand(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= MAX_REVIEW_COMMAND_LENGTH &&
    value.includes(REVIEW_URL_TOKEN) &&
    !/[\r\n]/.test(value)
  );
}

/**
 * Whether a review working directory is in the path family of the review host:
 * `local` takes a drive or non-WSL UNC path (win32) or a POSIX path (darwin) and
 * never a WSL UNC path; `wsl:` takes a POSIX-absolute path.
 */
export function reviewCwdMatchesHost(cwd: string, host: string): boolean {
  if (host.startsWith('wsl:')) return cwd.startsWith('/');
  if (hostIdForPath(cwd) !== 'local') return false;
  return /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') || cwd.startsWith('/');
}
