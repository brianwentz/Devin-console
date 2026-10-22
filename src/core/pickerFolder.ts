// ux3 S3 — where a folder picker starts (D2: nothing is auto-selected; the
// OS dialog just opens there). Precedence: the configured folder when it is
// set AND still exists → the default WSL distro's home (the pre-S3 default)
// → undefined (the OS decides). A configured folder that is missing is
// skipped, never cleared — `onMissing` fires so callers can log
// `picker-folder-missing`. The distro home comes from the host probe, so it
// is never checked (a check would mean Windows-side fs on a UNC path).
// `exists` is async: callers answer a UNC folder over the host's helper
// channel, a local one with fs/promises; a rejection counts as missing.
export async function pickerStartPath(
  configured: string | null,
  distroHome: string | undefined,
  exists: (path: string) => Promise<boolean>,
  onMissing?: () => void,
): Promise<string | undefined> {
  const folder = configured?.trim() ?? '';
  if (!folder) return distroHome;
  const found = await exists(folder).catch(() => false);
  if (found) return folder;
  onMissing?.();
  return distroHome;
}
