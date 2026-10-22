// Per-host helper channel (main): owns one long-lived `wsl.exe … node helper
// --stdio` child and speaks NDJSON JSON-RPC (core/hostRpc) to it. Lifecycle is
// built so a wedged VM (alive but silent, or hello-then-die) is never hammered:
// silence watchdog → kill, failed starts back off 60 s → 120 s, the third opens
// the breaker (`degraded`) until reset(). Exit 86 (bundle file missing) is a
// redeploy, not a failure. No electron import — hosts.ts injects spawn + log.

import type { ChildProcess } from 'node:child_process';
import {
  FrameTooLarge,
  HELLO_DEADLINE_MS,
  HELPER_PROTOCOL,
  LineDecoder,
  MAX_FRAME_BYTES,
  SILENCE_KILL_MS,
  SILENCE_PING_MS,
  encodeFrame,
  isCrashLoop,
  livenessTick,
  onExit,
  onReady,
  onStartFailed,
  onTick,
  requestTimeoutMs,
  resetBreaker,
  type BreakerState,
  type Hello,
} from '../core/hostRpc';
import { HELPER_MISSING_EXIT, type ExecHost } from '../core/execHost';
import type { HostStatus } from '../shared/ipc';

export type HelperStatus = NonNullable<HostStatus['helper']>;
export type HelperChannelState = HelperStatus['state'];

/** Typed rejection for every channel request: `code` is the helper's error
 * code, or one of `not-ready` | `timeout` | `exited`. */
export class HostRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostRpcError';
  }
}

export interface HostChannelOptions {
  silenceMs?: number;
  killMs?: number;
  helloMs?: number;
  /** Test override: replaces every BACKOFF_MS step. */
  backoffMs?: number | null;
  tickMs?: number;
  /** stop(): stdin EOF first, kill after this long. */
  stopGraceMs?: number;
  maxFrameBytes?: number;
  /** Exit 86 / hello hash mismatch: put the bundle back; resolves true when the file is deployed. */
  redeploy?: () => Promise<boolean>;
  /** Checked before EVERY spawn (start, backoff timer, immediate respawn,
   * post-redeploy, reset) and before every redeploy: false = the distro is
   * gone — the channel stops instead of a `wsl.exe -d D` that would boot it
   * again. */
  canSpawn?: () => Promise<boolean>;
  /** The deployed bundle's hash; a hello carrying another one is a stale helper. */
  expectedHash?: string;
  /** True when the probe found the bundle already on disk (no deploy this run):
   * a child that exits before hello may be running a truncated file — the
   * first such exit redeploys once per run before counting failures. */
  bundlePreexisting?: () => boolean;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** `host-helper` reason enum. */
type Reason =
  | 'spawn'
  | 'hello'
  | 'exit'
  | 'spawn-error'
  | 'hello-timeout'
  | 'silence'
  | 'protocol'
  | 'redeploy'
  | 'redeploy-failed'
  | 'stopped'
  | 'reset'
  | 'breaker'
  | 'distro-unavailable'
  | 'hash-mismatch'
  | 'crash-loop';

const methodTag = (method: string): string => method.slice(0, 64);

export class HostChannel {
  private stateValue: HelperChannelState = 'absent';
  private stateReason: Reason | null = null;
  private watchModeValue: HelperStatus['watchMode'] = null;
  private child: ChildProcess | null = null;
  private helloInfo: Hello | null = null;
  private decoder: LineDecoder;
  private breaker: BreakerState = resetBreaker();
  private attempt = 0;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private lastFrameAt = 0;
  private lastTickAt: number | null = null;
  private pingOutstanding = false;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private exitFallback: ReturnType<typeof setTimeout> | null = null;
  private endReason: Reason | null = null;
  private exitCode: number | null = null;
  private stopped = true;
  private redeploying = false;
  /** The current attempt is the respawn right after a redeploy. */
  private afterRedeploy = false;
  /** canSpawn() in flight; the sequence number cancels a stale gate. */
  private gating = false;
  private gateSeq = 0;
  /** hello hash mismatch: redeploy once per run, then degraded. */
  private hashRedeployUsed = false;
  private hashRedeployPending = false;
  /** Pre-existing bundle died before hello: redeploy once per run. */
  private earlyRedeployUsed = false;
  /** Children stop() ended stdin on that have not exited yet (quit kills them). */
  private stopping = new Set<ChildProcess>();
  private notificationFns = new Map<string, Set<(params: unknown) => void>>();
  private stateFns = new Set<(s: HelperStatus) => void>();
  private readonly silenceMs: number;
  private readonly killMs: number;
  private readonly helloMs: number;
  private readonly tickMs: number;
  private readonly stopGraceMs: number;
  private readonly maxFrameBytes: number;

  constructor(
    private readonly host: ExecHost,
    private readonly spawnFn: () => ChildProcess,
    private readonly opts: HostChannelOptions = {},
  ) {
    this.silenceMs = opts.silenceMs ?? SILENCE_PING_MS;
    this.killMs = opts.killMs ?? SILENCE_KILL_MS;
    this.helloMs = opts.helloMs ?? HELLO_DEADLINE_MS;
    this.tickMs = opts.tickMs ?? Math.max(20, Math.min(1_000, Math.floor(this.silenceMs / 5)));
    this.stopGraceMs = opts.stopGraceMs ?? 1_000;
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.decoder = new LineDecoder(this.maxFrameBytes);
  }

  get state(): HelperChannelState {
    return this.stateValue;
  }

  get status(): HelperStatus {
    return { state: this.stateValue, watchMode: this.watchModeValue };
  }

  get hello(): Hello | null {
    return this.helloInfo;
  }

  /** A child is up or a respawn is scheduled — the channel owns HostStatus.helper. */
  get running(): boolean {
    return !this.stopped && (this.child !== null || this.respawnTimer !== null || this.redeploying || this.gating);
  }

  /** Test seam / diagnostics (no ids beyond counts). */
  info(): { state: HelperChannelState; watchMode: HelperStatus['watchMode']; failures: number; open: boolean; pending: number; running: boolean } {
    return {
      state: this.stateValue,
      watchMode: this.watchModeValue,
      failures: this.breaker.failures,
      open: this.breaker.open,
      pending: this.pending.size,
      running: this.running,
    };
  }

  start(): void {
    this.stopped = false;
    if (this.child || this.respawnTimer || this.redeploying || this.gating) return;
    if (this.breaker.open) {
      this.setState('degraded', 'breaker');
      return;
    }
    this.spawnNow('spawn');
  }

  /** Closes the breaker and starts (hosts:refresh, a distro newly Running). A healthy child is kept. */
  reset(): void {
    this.breaker = resetBreaker();
    this.afterRedeploy = false;
    this.clearRespawn();
    this.stopped = false;
    // Inside stop()'s grace the old child may still be draining its EOF: a
    // reset here briefly overlaps two children — accepted, the old one exits.
    if (this.child || this.redeploying || this.gating) return;
    this.spawnNow('reset');
  }

  /** stdin EOF (the helper exits on it), kill after a short grace; no respawn. */
  stop(reason: 'stopped' | 'distro-unavailable' = 'stopped'): void {
    this.halt(reason);
  }

  /** Quit: kill (synchronously) every child stop() is still waiting on — the
   * unref'd grace timer would not fire before the process exits. */
  killStopped(): void {
    for (const child of this.stopping) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    this.stopping.clear();
  }

  private halt(reason: Reason): void {
    this.stopped = true;
    this.clearRespawn();
    this.gateSeq++;
    this.gating = false;
    const child = this.child;
    this.detach();
    this.rejectAll('exited', 'helper channel stopped');
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      this.stopping.add(child);
      const kill = setTimeout(() => {
        this.stopping.delete(child);
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, this.stopGraceMs);
      kill.unref?.();
      child.once('exit', () => {
        clearTimeout(kill);
        this.stopping.delete(child);
      });
    }
    if (this.stateValue !== 'absent' && this.stateValue !== 'node-missing' && this.stateValue !== 'unsupported-node') {
      this.setState('reconnecting', reason);
    }
  }

  /** Test hook: kill the live child (the exit takes the normal path). */
  kill(): boolean {
    if (!this.child) return false;
    try {
      return this.child.kill();
    } catch {
      return false;
    }
  }

  /** env.get reports a later watch → poll switch (never pushed). */
  noteWatchMode(mode: HelperStatus['watchMode']): void {
    if (mode === this.watchModeValue) return;
    this.watchModeValue = mode;
    this.emitState();
  }

  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const child = this.child;
    if (this.stateValue !== 'ready' || !child || !this.helloInfo) {
      return Promise.reject(new HostRpcError('not-ready', 'helper channel is not ready'));
    }
    const id = ++this.nextId;
    const ms = opts?.timeoutMs ?? requestTimeoutMs(method);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.log('host-rpc-timeout', { host: this.host.id, method: methodTag(method), ms });
        reject(new HostRpcError('timeout', `${methodTag(method)} timed out`));
      }, ms);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        child.stdin?.write(encodeFrame({ id, method, params: params ?? {} }));
      } catch {
        // a dead pipe surfaces as the child's exit, which rejects this request
      }
    });
  }

  onNotification(method: string, fn: (params: unknown) => void): () => void {
    let set = this.notificationFns.get(method);
    if (!set) {
      set = new Set();
      this.notificationFns.set(method, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  onState(fn: (s: HelperStatus) => void): () => void {
    this.stateFns.add(fn);
    return () => {
      this.stateFns.delete(fn);
    };
  }

  // --- lifecycle ---------------------------------------------------------------

  private spawnNow(reason: Reason): void {
    this.clearRespawn();
    const gate = this.opts.canSpawn;
    if (!gate) {
      this.doSpawn(reason);
      return;
    }
    const seq = ++this.gateSeq;
    this.gating = true;
    void gate()
      .catch(() => false)
      .then((ok) => {
        if (seq !== this.gateSeq) return;
        this.gating = false;
        if (this.stopped) return;
        if (ok) this.doSpawn(reason);
        else this.halt('distro-unavailable');
      });
  }

  private doSpawn(reason: Reason): void {
    const attempt = ++this.attempt;
    this.decoder = new LineDecoder(this.maxFrameBytes);
    this.helloInfo = null;
    this.endReason = null;
    this.exitCode = null;
    this.pingOutstanding = false;
    this.setState('starting', reason);
    let child: ChildProcess;
    try {
      child = this.spawnFn();
    } catch {
      this.endReason = 'spawn-error';
      this.finish(attempt);
      return;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(attempt, chunk));
    // stderr carries counts only from our helper, but rc files can print
    // anything — drained, never logged.
    child.stderr?.resume();
    child.stdin?.on('error', () => undefined);
    child.once('error', () => {
      if (attempt !== this.attempt) return;
      this.endReason ??= 'spawn-error';
      this.finish(attempt);
    });
    child.once('exit', (code) => {
      if (attempt !== this.attempt) return;
      this.exitCode = code;
      // 'close' follows once stdout drained; don't wait forever on a held pipe.
      this.exitFallback = setTimeout(() => this.finish(attempt), 1_000);
      this.exitFallback.unref?.();
    });
    child.once('close', () => this.finish(attempt));
    this.helloTimer = setTimeout(() => {
      if (attempt !== this.attempt || this.helloInfo) return;
      this.endReason = 'hello-timeout';
      this.kill();
    }, this.helloMs);
    this.helloTimer.unref?.();
  }

  private onData(attempt: number, chunk: Buffer): void {
    if (attempt !== this.attempt) return;
    const frames = this.decoder.push(chunk);
    if (frames.length === 0) return;
    this.lastFrameAt = Date.now();
    this.pingOutstanding = false;
    for (const frame of frames) {
      if (attempt !== this.attempt) return;
      if (frame instanceof FrameTooLarge) {
        this.log('host-rpc-error', { host: this.host.id, method: 'unknown', code: 'too-large' });
        continue;
      }
      const f = frame as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
      if (!this.helloInfo) {
        if (f.method === 'hello') this.onHello(f.params);
        continue;
      }
      if (typeof f.id === 'number') this.onResponse(f.id, f.result, f.error);
      else if (typeof f.method === 'string') this.onNotify(f.method, f.params);
    }
  }

  private onHello(params: unknown): void {
    const hello = params as Partial<Hello> | null;
    if (!hello || hello.protocol !== HELPER_PROTOCOL) {
      this.endReason = 'protocol';
      this.kill();
      return;
    }
    if (this.opts.expectedHash && hello.hash !== this.opts.expectedHash) {
      // A stale helper answered (old build / foreign file): redeploy once.
      this.endReason = 'hash-mismatch';
      if (!this.hashRedeployUsed && this.opts.redeploy) {
        this.hashRedeployUsed = true;
        this.hashRedeployPending = true;
      } else {
        this.breaker = { ...this.breaker, open: true, nextAttemptAt: null, readySince: null };
      }
      this.kill();
      return;
    }
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.helloInfo = hello as Hello;
    this.watchModeValue = hello.watchMode === 'poll' || hello.watchMode === 'watch' ? hello.watchMode : null;
    this.afterRedeploy = false;
    this.breaker = onReady(this.breaker, Date.now());
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.tickTimer.unref?.();
    this.setState('ready', 'hello');
  }

  private onResponse(id: number, result: unknown, error: unknown): void {
    const p = this.pending.get(id);
    if (!p) return; // late answer after a timeout
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error && typeof error === 'object') {
      const code = String((error as { code?: unknown }).code ?? 'error').slice(0, 64);
      this.log('host-rpc-error', { host: this.host.id, method: methodTag(p.method), code });
      p.reject(new HostRpcError(code, `${methodTag(p.method)} failed: ${code}`));
      return;
    }
    p.resolve(result);
  }

  private onNotify(method: string, params: unknown): void {
    for (const fn of this.notificationFns.get(method) ?? []) {
      try {
        fn(params);
      } catch {
        // a subscriber's bug never takes the channel down
      }
    }
  }

  private tick(): void {
    if (!this.child || !this.helloInfo) return;
    const now = Date.now();
    const step = livenessTick(
      { lastTickAt: this.lastTickAt, lastFrameAt: this.lastFrameAt, pingOutstanding: this.pingOutstanding },
      now,
      this.silenceMs,
      this.killMs,
      this.tickMs,
    );
    if (step.jumped) {
      this.log('host-helper-wake', { host: this.host.id, gapMs: now - (this.lastTickAt ?? now) });
    }
    this.lastTickAt = step.clock.lastTickAt;
    this.lastFrameAt = step.clock.lastFrameAt;
    this.pingOutstanding = step.clock.pingOutstanding;
    this.breaker = onTick(this.breaker, now);
    const action = step.action;
    if (action === 'ping') {
      this.pingOutstanding = true;
      this.request('ping', {}, { timeoutMs: this.killMs }).catch(() => undefined);
    } else if (action === 'kill') {
      this.endReason = 'silence';
      this.kill();
    }
  }

  private finish(attempt: number): void {
    if (attempt !== this.attempt) return;
    // Invalidate this attempt so the remaining exit/close/error events no-op.
    this.attempt++;
    const code = this.exitCode;
    const reason: Reason = this.endReason ?? 'exit';
    const helloSeen = this.helloInfo !== null;
    this.detach();
    this.rejectAll('exited', 'helper channel closed');
    if (this.stopped) return;
    const now = Date.now();
    const hashRedeploy = this.hashRedeployPending;
    this.hashRedeployPending = false;
    // A child that exited on its own before hello (not a hello timeout: a
    // wedged VM gets no extra wsl.exe run) on a bundle we did not write this
    // run may be a truncated deploy from an earlier run.
    const earlyRedeploy =
      reason === 'exit' &&
      !helloSeen &&
      !this.earlyRedeployUsed &&
      !this.afterRedeploy &&
      Boolean(this.opts.redeploy) &&
      this.opts.bundlePreexisting?.() === true;
    if (earlyRedeploy) this.earlyRedeployUsed = true;
    if (
      hashRedeploy ||
      earlyRedeploy ||
      (code === HELPER_MISSING_EXIT && this.opts.redeploy && !this.afterRedeploy)
    ) {
      this.afterRedeploy = true;
      this.redeploying = true;
      this.setState('starting', 'redeploy');
      this.gatedRedeploy();
      return;
    }
    this.breaker = onExit(this.breaker, now);
    this.scheduleRespawn(now, reason);
  }

  /** The deploy is a `wsl.exe -d D` run as well: it passes the same fresh
   * spawn gate first — a distro stopped since the last list (`wsl --terminate`
   * between spawn and hello) halts the channel instead of being booted. */
  private gatedRedeploy(): void {
    const redeploy = (): void => {
      void this.opts
        .redeploy!()
        .catch(() => false)
        .then((ok) => {
          this.redeploying = false;
          if (this.stopped) return;
          if (ok) this.spawnNow('redeploy');
          else this.failed(Date.now(), 'redeploy-failed');
        });
    };
    const gate = this.opts.canSpawn;
    if (!gate) {
      redeploy();
      return;
    }
    void gate()
      .catch(() => false)
      .then((ok) => {
        // stop() during the gate: nothing runs. (start/reset wait on
        // `redeploying`, so no other spawn raced this one.)
        if (this.stopped) {
          this.redeploying = false;
          return;
        }
        if (ok) {
          redeploy();
          return;
        }
        this.redeploying = false;
        this.halt('distro-unavailable');
      });
  }

  private failed(now: number, reason: Reason): void {
    this.breaker = onStartFailed(this.breaker, now);
    this.scheduleRespawn(now, reason);
  }

  private scheduleRespawn(now: number, reason: Reason): void {
    if (this.breaker.open) {
      this.setState('degraded', isCrashLoop(this.breaker) ? 'crash-loop' : reason);
      return;
    }
    const at = this.breaker.nextAttemptAt;
    const delay = at === null ? 0 : (this.opts.backoffMs ?? Math.max(0, at - now));
    if (delay === 0) {
      // A stable helper exited: respawn at once (state goes straight to starting).
      this.spawnNow(reason);
      return;
    }
    this.setState('reconnecting', reason);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (!this.stopped) this.spawnNow('spawn');
    }, delay);
    this.respawnTimer.unref?.();
  }

  private detach(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.exitFallback) clearTimeout(this.exitFallback);
    this.helloTimer = null;
    this.tickTimer = null;
    this.exitFallback = null;
    this.child = null;
    this.helloInfo = null;
    this.pingOutstanding = false;
    // stop() detaches without finish(): bump so the old child's events no-op.
    this.attempt++;
  }

  private clearRespawn(): void {
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
  }

  private rejectAll(code: string, message: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new HostRpcError(code, message));
    }
  }

  private setState(next: HelperChannelState, reason: Reason): void {
    // Same state, same reason = no news (starting always logs: one per spawn).
    if (next === this.stateValue && reason === this.stateReason && next !== 'starting') return;
    this.stateValue = next;
    this.stateReason = reason;
    this.log('host-helper', { host: this.host.id, state: next, reason });
    this.emitState();
  }

  private emitState(): void {
    const status = this.status;
    for (const fn of this.stateFns) {
      try {
        fn(status);
      } catch {
        // listener bug never breaks the lifecycle
      }
    }
  }

  private log(event: string, detail: Record<string, unknown>): void {
    this.opts.log?.(event, detail);
  }
}
