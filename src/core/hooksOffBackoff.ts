// Per-host backoff for the hooks opt-out one-shot (`--apply-hooks-off`): a
// distro whose run keeps failing (unparseable settings.json, no node, …)
// must not get a `wsl -l -v` + wsl.exe run on every host status change.
// 60 s after the first failure, doubling to 1 h; the caller drops the entry
// on success or when the hooks setting changes.

export const HOOKS_OFF_BACKOFF_MS = 60_000;
export const HOOKS_OFF_BACKOFF_MAX_MS = 3_600_000;

export type HooksOffBackoff = { failures: number; nextAt: number };

export function hooksOffDue(b: HooksOffBackoff | undefined, now: number): boolean {
  return b === undefined || now >= b.nextAt;
}

/** Records one more consecutive failure at `now`; `baseMs` scales the whole ladder (tests). */
export function hooksOffFailed(
  b: HooksOffBackoff | undefined,
  now: number,
  baseMs: number = HOOKS_OFF_BACKOFF_MS,
): HooksOffBackoff {
  const failures = (b?.failures ?? 0) + 1;
  const max = HOOKS_OFF_BACKOFF_MAX_MS * (baseMs / HOOKS_OFF_BACKOFF_MS);
  const delay = Math.min(baseMs * 2 ** Math.min(failures - 1, 30), max);
  return { failures, nextAt: now + delay };
}

/** Settings-visible text when an opt-out cannot reach a distro whose helper
 * is degraded: our block stays in its settings.json until the channel is back. */
export const HOOKS_OFF_HELPER_UNAVAILABLE = "Couldn't remove hooks: helper unavailable";

/** Opt-out on a listed distro whose channel isn't ready: a degraded helper
 * (breaker open) is reported — the caller leaves the apply key unrecorded so
 * the ready transition retries; any other state is a (re)start that will
 * re-run the apply on its own (null = skip quietly). */
export function hooksOffChannelDown(state: string | null | undefined): string | null {
  return state === 'degraded' ? HOOKS_OFF_HELPER_UNAVAILABLE : null;
}

/** A rejected `--apply-hooks-off` spawn → fixed Settings text: the raw message
 * can carry the wsl.exe path, so only a plain errno code survives. */
export function hooksOffSpawnError(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code)
    ? `hooks removal failed (spawn ${code})`
    : 'hooks removal failed (spawn)';
}
