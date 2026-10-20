// ux3 S3 — where a folder picker starts (D2: nothing is auto-selected; the
// OS dialog just opens there). Precedence: the configured folder when it is
// set AND still exists → the default WSL distro's home (the pre-S3 default)
// → undefined (the OS decides). A configured folder that is missing is
// skipped, never cleared — callers log `picker-folder-missing`.
export function pickerStartPath(
  configured: string | null,
  distroHome: string | undefined,
  exists: (path: string) => boolean,
): string | undefined {
  const folder = configured?.trim() ?? '';
  if (folder && exists(folder)) return folder;
  return distroHome;
}

// True when a configured folder was set but skipped (lets callers log once
// without repeating the existence check).
export function pickerFolderMissing(
  configured: string | null,
  exists: (path: string) => boolean,
): boolean {
  const folder = configured?.trim() ?? '';
  return folder !== '' && !exists(folder);
}
