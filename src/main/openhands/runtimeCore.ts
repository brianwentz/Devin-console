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
// A refused list (signed out / key rejected) stretches the next tick x4 per
// consecutive refusal, up to 16 min — the usage service's own backoff ceiling.
const AUTH_BACKOFF_FACTOR = 4;
const AUTH_BACKOFF_MAX_MS = 16 * 60_000;
// At most one list per this window from "the hosted view navigated home".
const SIGN_IN_HINT_MIN_MS = 5_000;

/** Next poll delay after `failures` consecutive refused lists (never below the base). */
export function authBackoffMs(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs;
  return Math.max(baseMs, Math.min(baseMs * AUTH_BACKOFF_FACTOR ** failures, AUTH_BACKOFF_MAX_MS));
}

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
  /** Reset the backoff and fetch now (credentials changed / now authenticated). */
  recover(): void;
}

const authenticated = (c: OpenHandsConnection): boolean => c === 'api-key' || c === 'web-session';
const refused = (c: OpenHandsConnection): boolean => c === 'login-required' || c === 'api-key-rejected';

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
  /** Clock for the sign-in hint rate limit (default Date.now). */
  now?(): number;
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
  // The active source's connection as last seen after a list.
  let lastConnection: OpenHandsConnection = 'idle';
  // Consecutive lists the server refused; drives the poll backoff.
  let authFailures = 0;
  let lastSignInHintAt = -Infinity;
  let hintTimer: unknown = null;

  const clearHintTimer = (): void => {
    if (hintTimer !== null) deps.clearTimer(hintTimer);
    hintTimer = null;
  };

  const clearTimer = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearTimer();
    if (disposed || !active) return;
    const base = deps.pollMs(deps.pollSeconds()) * (deps.focused() ? 1 : BLURRED_FACTOR);
    const ms = authBackoffMs(base, authFailures);
    timer = deps.setTimer(() => void tick(), ms);
  };

  // After every list: a move into an authenticated connection out of a
  // refused one (signed in on the web page, key fixed) lets usage recover at
  // once instead of waiting out its 401/403 backoff. The first answer after
  // the gate opens ('idle' -> …) is not a recovery: usage is starting anyway.
  const noteConnection = (): void => {
    if (!active) return;
    const next = active.source.connection();
    const previous = lastConnection;
    lastConnection = next;
    const failures = refused(next) ? authFailures + 1 : 0;
    const changed = failures !== authFailures;
    authFailures = failures;
    // The armed timer carries the old delay: re-arm at the new one.
    if (changed) schedule();
    if (authenticated(next) && previous !== next && previous !== 'idle') active.usage?.recover();
  };

  const refreshList = async (reason: RefreshReason): Promise<void> => {
    if (!active) return;
    await active.controller.refresh(reason);
    noteConnection();
  };

  const tick = async (): Promise<void> => {
    timer = null;
    // A slow list must not queue a follow-up on top of itself.
    if (!disposed && active && !active.source.isListing()) await refreshList('poll');
    schedule();
  };

  const stopActive = (): Active<U> | null => {
    clearTimer();
    clearHintTimer();
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
    const started = { base, ...deps.build(base) };
    active = started;
    lastConnection = started.source.connection();
    void started.controller.start().then(() => {
      if (active !== started) return;
      noteConnection();
    });
    started.usage?.start();
    schedule();
  };

  const open = (): void => {
    if (opened || disposed || !started) return;
    opened = true;
    local = null;
    startActive();
  };

  /**
   * The active hosted view navigated onto the base origin while the server
   * refuses the list: the user may have just signed in on that page, which
   * no other trigger sees. Drop the backoff and list now (>= 5 s apart).
   */
  function navigatedHome(): void {
    if (disposed || !active || !refused(active.source.connection())) return;
    const at = (deps.now ?? Date.now)();
    const wait = SIGN_IN_HINT_MIN_MS - (at - lastSignInHintAt);
    if (wait > 0) {
      // Inside the window: one trailing hint, so the navigation that
      // actually finished the sign-in is not lost behind an earlier one.
      if (hintTimer === null) {
        hintTimer = deps.setTimer(() => {
          hintTimer = null;
          navigatedHome();
        }, wait);
      }
      return;
    }
    lastSignInHintAt = at;
    authFailures = 0;
    schedule();
    if (active.source.isListing()) return;
    active.source.requestFull();
    void refreshList('focus');
  }

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
      // The user is looking: the next tick is at the normal cadence again.
      if (authFailures > 0) {
        authFailures = 0;
        schedule();
      }
    },
    async onCredentialsChanged(keySet: boolean): Promise<void> {
      if (keySet) open();
      if (!active) return;
      // Usage must not sit out a backoff earned by the old credentials.
      active.usage?.recover();
      active.source.requestFull();
      authFailures = 0;
      await active.controller.refresh('settings');
      // Already recovered for this change: only record the connection.
      if (active) {
        lastConnection = active.source.connection();
        authFailures = refused(lastConnection) ? 1 : 0;
        schedule();
      }
    },
    onViewNavigatedHome: navigatedHome,
    onFocus(): void {
      if (!active) return;
      active.source.requestFull();
      // A refused focus list keeps (and extends) the backoff; a good one clears it.
      void refreshList('focus');
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
      await refreshList('test');
    },
  };
}
