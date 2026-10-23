// Lifecycle of the OpenHands sessions runtime, electron-free so it is unit
// tested with injected timers/build/cache. The module singleton
// (src/main/providers/openhands.ts) is a thin wrapper.
//
// Opt-in gate: the OpenHands host is never contacted for a user who does not
// use OpenHands. Nothing is built, polled or listed until one gate opens —
//   (a) an API key is stored, (b) the openhands surface was entered this run,
//   (c) a cache file for the current tenant exists —
// and once open it stays open for the run.

import { parseCloudCacheValue } from '../../core/cloudCache';
import type { CloudState, OpenHandsConnection } from '../../shared/ipc';
import type { CloudMutation } from '../cloudKit/source';

export type RefreshReason = 'start' | 'poll' | 'focus' | 'full' | 'mutate' | 'settings' | 'test';
const BLURRED_FACTOR = 4;

export interface CoreController {
  start(): Promise<void>;
  stop(): void;
  refresh(reason: RefreshReason): Promise<void>;
  /** Resolves true when the server accepted the mutation. */
  mutate(op: CloudMutation): Promise<boolean>;
  snapshot(): CloudState;
  /** Resolves when queued cache writes have settled. */
  drain(): Promise<void>;
}

export interface CoreSource {
  requestFull(): void;
  isListing(): boolean;
  connection(): OpenHandsConnection;
}

/** Per-base usage poller (src/main/openhands/usage.ts); lives and dies with the active controller. */
export interface CoreUsage {
  start(): void;
  stop(): void;
}

export interface OhSettingsLike {
  openhands: { baseUrl: string; pollSeconds: number };
}

export interface RuntimeCoreDeps<U extends CoreUsage = CoreUsage> {
  /** Effective base URL right now. */
  currentBase(): string;
  /** Effective base URL of a settings object (test override applied). */
  baseOf(settings: OhSettingsLike): string;
  pollSeconds(): number;
  pollMs(seconds: number): number;
  build(base: string): { source: CoreSource; controller: CoreController; usage?: U };
  hasKey(): Promise<boolean>;
  /** A cache file for `base`'s tenant exists. */
  cacheMatches(base: string): Promise<boolean>;
  dropCache(): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  focused(): boolean;
  onChange(): void;
  log(event: string, detail: Record<string, unknown>): void;
}

// Gate (c): the parsed cache belongs to the current tenant.
export function cacheMatchesTenant(raw: unknown, tenantKey: string): boolean {
  return raw !== null && raw !== undefined && parseCloudCacheValue(raw, tenantKey) !== null;
}

interface Active<U extends CoreUsage> {
  base: string;
  source: CoreSource;
  controller: CoreController;
  usage?: U;
}

export function createOpenHandsRuntimeCore<U extends CoreUsage = CoreUsage>(deps: RuntimeCoreDeps<U>) {
  let active: Active<U> | null = null;
  let timer: unknown = null;
  let started = false;
  let disposed = false;
  let opened = false;
  let surfaceEntered = false;
  // start() has evaluated gates (a) and (c).
  let gateSettled = false;
  // Rename/delete asked for while no gate is open: surfaced as lastError.
  let local: { op: 'rename' | 'delete'; message: string } | null = null;

  const clearTimer = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (disposed || !active) return;
    const ms = deps.pollMs(deps.pollSeconds()) * (deps.focused() ? 1 : BLURRED_FACTOR);
    timer = deps.setTimer(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    timer = null;
    // A slow list must not queue a follow-up on top of itself.
    if (!disposed && active && !active.source.isListing()) await active.controller.refresh('poll');
    schedule();
  };

  const stopActive = (): Active<U> | null => {
    clearTimer();
    const old = active;
    active = null;
    if (old) {
      try {
        old.usage?.stop();
      } catch {
        // the sessions controller below still stops
      }
      try {
        old.controller.stop();
      } catch (error) {
        deps.log('openhands-stop-error', { code: error instanceof Error ? error.name : 'unknown' });
      }
    }
    return old;
  };

  const startActive = (): void => {
    const base = deps.currentBase();
    active = { base, ...deps.build(base) };
    void active.controller.start();
    active.usage?.start();
    schedule();
  };

  const open = (): void => {
    if (opened || disposed || !started) return;
    opened = true;
    local = null;
    startActive();
  };

  return {
    // Evaluates gates (a) and (c); (b) may already have been flagged.
    async start(): Promise<void> {
      if (started || disposed) return;
      started = true;
      if (surfaceEntered) {
        gateSettled = true;
        open();
        return;
      }
      let gate = false;
      try {
        gate = (await deps.hasKey()) || (await deps.cacheMatches(deps.currentBase()));
      } catch {
        gate = false;
      }
      gateSettled = true;
      if (gate) open();
    },
    /** 'pending' until start() has evaluated the gates; then 'open' or 'closed'. */
    gate(): 'pending' | 'open' | 'closed' {
      if (opened) return 'open';
      return gateSettled ? 'closed' : 'pending';
    },
    onSurfaceEnter(): void {
      surfaceEntered = true;
      open();
    },
    async onCredentialsChanged(keySet: boolean): Promise<void> {
      if (keySet) open();
      if (!active) return;
      active.source.requestFull();
      await active.controller.refresh('settings');
    },
    onFocus(): void {
      if (!active) return;
      active.source.requestFull();
      void active.controller.refresh('focus');
      schedule();
    },
    async onSettingsChanged(previous: OhSettingsLike, next: OhSettingsLike): Promise<void> {
      if (disposed || !active) return;
      if (deps.baseOf(next) !== active.base) {
        // A different tenant: rows, cursor and cache are not ours any more.
        // Queued writes of the old controller land before the cache is dropped.
        const old = stopActive();
        try {
          await old?.controller.drain();
          await deps.dropCache();
        } catch {
          // best effort; the tenant key also guards a stale file
        }
        if (disposed || active) return;
        startActive();
        deps.onChange();
        return;
      }
      if (previous.openhands.pollSeconds !== next.openhands.pollSeconds) schedule();
    },
    async dispose(): Promise<void> {
      disposed = true;
      stopActive();
    },
    /** Usage poller of the open gate's base URL (null while the gate is closed). */
    usage(): U | null {
      return active?.usage ?? null;
    },
    snapshot(): { state: CloudState; connection: OpenHandsConnection } | null {
      return active ? { state: active.controller.snapshot(), connection: active.source.connection() } : null;
    },
    /** One rename/delete on the active source; true only when the server accepted it. */
    async mutate(op: CloudMutation): Promise<boolean> {
      if (disposed || !active) {
        local = { op: op.op, message: 'not-connected' };
        deps.onChange();
        return false;
      }
      const ok = await active.controller.mutate(op);
      if (ok) local = null;
      return ok;
    },
    /** Error of a mutation refused because no gate is open (null otherwise). */
    localError(): { op: 'rename' | 'delete'; message: string } | null {
      return local;
    },
    /** Test hook: open the gate, force a full list. */
    async forceRefresh(): Promise<void> {
      surfaceEntered = true;
      open();
      if (!active) return;
      active.source.requestFull();
      await active.controller.refresh('test');
    },
  };
}
