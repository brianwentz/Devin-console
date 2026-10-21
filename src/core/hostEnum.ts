// Distro enumeration cache (pure; the runner is injected). Runs are coalesced;
// a failed run keeps the previous rows (a timed-out `wsl -l -v` must not make
// every host vanish) and leaves the cache stale + `failed`. `refreshFresh()`
// waits for a run that STARTED after the call — a gate deciding whether to
// spawn into a distro must never trust a list taken before a `wsl --terminate`.

export class EnumerationCache<R> {
  rows: R[] = [];
  /** Completion time of the last successful run; null = none yet / invalidated. */
  private okAt: number | null = null;
  failed = false;
  completed = false;
  private seq = 0;
  private lastCompletedSeq = 0;
  private inFlight: { seq: number; promise: Promise<void> } | null = null;

  constructor(
    private readonly run: () => Promise<R[]>,
    private readonly now: () => number = Date.now,
    private readonly onSettled?: (ok: boolean) => void,
  ) {}

  /** A successful run completed within `maxAgeMs` and the latest run did not fail. */
  isFresh(maxAgeMs: number): boolean {
    return !this.failed && this.okAt !== null && this.now() - this.okAt < maxAgeMs;
  }

  /** Forget freshness (hosts:refresh) — rows stay until a run replaces them. */
  invalidate(): void {
    this.okAt = null;
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
        this.settle(seq, true);
      },
      () => {
        this.failed = true;
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
    this.onSettled?.(ok);
  }
}
