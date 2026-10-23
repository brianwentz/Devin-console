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
  mutate(op: CloudMutation): Promise<void>;
  snapshot(): CloudState;
  /** Resolves when queued cache writes have settled. */
  drain(): Promise<void>;
}

export interface CoreSource {
  requestFull(): void;
  isListing(): boolean;
  connection(): OpenHandsConnection;
}

export interface OhSettingsLike {
  openhands: { baseUrl: string; pollSeconds: number };
}

export interface RuntimeCoreDeps {
  /** Effective base URL right now. */
  currentBase(): string;
  /** Effective base URL of a settings object (test override applied). */
  baseOf(settings: OhSettingsLike): string;
  pollSeconds(): number;
  pollMs(seconds: number): number;
  build(base: string): { source: CoreSource; controller: CoreController };
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

interface Active {
  base: string;
  source: CoreSource;
  controller: CoreController;
}

export function createOpenHandsRuntimeCore(deps: RuntimeCoreDeps) {
  let active: Active | null = null;
  let timer: unknown = null;
  let started = false;
  let disposed = false;
  let opened = false;
  let surfaceEntered = false;

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

  const stopActive = (): Active | null => {
    clearTimer();
    const old = active;
    active = null;
    if (old) {
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
    schedule();
  };

  const open = (): void => {
    if (opened || disposed || !started) return;
    opened = true;
    startActive();
  };

  return {
    // Evaluates gates (a) and (c); (b) may already have been flagged.
    async start(): Promise<void> {
      if (started || disposed) return;
      started = true;
      if (surfaceEntered) {
        open();
        return;
      }
      let gate = false;
      try {
        gate = (await deps.hasKey()) || (await deps.cacheMatches(deps.currentBase()));
      } catch {
        gate = false;
      }
      if (gate) open();
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
    snapshot(): { state: CloudState; connection: OpenHandsConnection } | null {
      return active ? { state: active.controller.snapshot(), connection: active.source.connection() } : null;
    },
    /** One rename/delete on the active source; false when no gate is open. */
    async mutate(op: CloudMutation): Promise<boolean> {
      if (disposed || !active) return false;
      await active.controller.mutate(op);
      return true;
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
