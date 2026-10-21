// Distro enumeration cache (pure; the runner is injected). Runs are coalesced;
// a failed run keeps the previous rows (a timed-out `wsl -l -v` must not make
// every host vanish) and sets `failed`. Failures back off: the cache counts as
// fresh (no focus/backgroundReady re-run) for 60 s doubling to 5 min, reset on
// success. `refreshFresh()` waits for a run that STARTED after the call — a
// gate deciding whether to spawn into a distro must never trust a list taken
// before a `wsl --terminate`.

export const ENUM_FAILURE_BACKOFF_MS = 60_000;
export const ENUM_FAILURE_BACKOFF_MAX_MS = 300_000;

/** Backoff after the n-th consecutive failed list (n ≥ 1). */
export function failureBackoffMs(n: number, baseMs = ENUM_FAILURE_BACKOFF_MS): number {
  const max = Math.max(baseMs, ENUM_FAILURE_BACKOFF_MAX_MS * (baseMs / ENUM_FAILURE_BACKOFF_MS));
  return Math.min(baseMs * 2 ** Math.max(0, n - 1), max);
}

/**
 * `wsl -l -v` exit classification. Only a timeout/kill (no exit code) is a
 * failure; any prompt exit — including non-zero, which wsl.exe returns for
 * "no installed distributions" and the inbox stub returns without the WSL
 * feature — is a list (empty when non-zero). Output text is never parsed
 * (it is localized).
 */
export function enumOutcome(code: number | null): 'ok' | 'empty' | 'failed' {
  if (code === null) return 'failed';
  return code === 0 ? 'ok' : 'empty';
}

export class EnumerationCache<R> {
  rows: R[] = [];
  /** Completion time of the last successful run; null = none yet / invalidated. */
  private okAt: number | null = null;
  private failAt: number | null = null;
  private failures = 0;
  failed = false;
  completed = false;
  private seq = 0;
  private lastCompletedSeq = 0;
  private inFlight: { seq: number; promise: Promise<void> } | null = null;

  constructor(
    private readonly run: () => Promise<R[]>,
    private readonly now: () => number = Date.now,
    private readonly onSettled?: (ok: boolean) => void,
    private readonly backoffBaseMs: number = ENUM_FAILURE_BACKOFF_MS,
  ) {}

  /** No re-run due: a success within `maxAgeMs`, or a failure still inside its backoff. */
  isFresh(maxAgeMs: number): boolean {
    if (this.failed) {
      return this.failAt !== null && this.now() - this.failAt < failureBackoffMs(this.failures, this.backoffBaseMs);
    }
    return this.okAt !== null && this.now() - this.okAt < maxAgeMs;
  }

  /** Forget freshness and the failure backoff (hosts:refresh) — rows stay. */
  invalidate(): void {
    this.okAt = null;
    this.failAt = null;
  }

  /** Runs an enumeration, or joins the one in flight. Never rejects. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight.promise;
    const seq = ++this.seq;
    const promise = this.run().then(
      (rows) => {
        this.rows = rows;
        this.okAt = this.now();
        this.failed = false;
        this.failures = 0;
        this.failAt = null;
        this.settle(seq, true);
      },
      () => {
        this.failed = true;
        this.failures++;
        this.failAt = this.now();
        this.settle(seq, false);
      },
    );
    this.inFlight = { seq, promise };
    return promise;
  }

  /** Resolves once a run that started after this call has completed. */
  async refreshFresh(): Promise<void> {
    const need = this.seq + 1;
    for (;;) {
      if (this.lastCompletedSeq >= need) return;
      const current = this.inFlight;
      if (current && current.seq >= need) {
        await current.promise;
        return;
      }
      if (current) {
        await current.promise;
        continue;
      }
      await this.refresh();
      return;
    }
  }

  private settle(seq: number, ok: boolean): void {
    this.inFlight = null;
    this.lastCompletedSeq = seq;
    this.completed = true;
    try {
      this.onSettled?.(ok);
    } catch {
      // a listener bug must not turn refresh() into a rejection
    }
  }
}
