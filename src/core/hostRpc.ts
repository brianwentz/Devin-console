// Pure NDJSON JSON-RPC core shared by the in-distro helper and the main-process HostChannel.
// No electron / child_process imports; must stay loadable on plain Node 18.

export const HELPER_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const BACKOFF_MS = [60_000, 120_000] as const;
export const STABLE_MS = 60_000;

export type RpcRequest = { id: number; method: string; params: unknown };
export type RpcResponse = { id: number; result?: unknown; error?: { code: string; message: string } };
export type RpcNotification = { method: string; params: unknown };
export type Hello = {
  protocol: number;
  hash: string;
  node: string;
  pid: number;
  home: string;
  watchMode: 'watch' | 'poll';
};

/** Yielded by `LineDecoder.push` in place of a line that exceeded the size limit (the line itself is dropped). */
export class FrameTooLarge {
  constructor(readonly limit: number) {}
}

const NL = 0x0a;

export class LineDecoder {
  private chunks: Buffer[] = [];
  private pending = 0;
  private discarding = false;

  constructor(private readonly maxBytes: number = MAX_FRAME_BYTES) {}

  /** Complete frames in arrival order. Non-JSON lines are skipped; an oversize line yields one FrameTooLarge. */
  push(chunk: Buffer | string): Array<unknown | FrameTooLarge> {
    const out: Array<unknown | FrameTooLarge> = [];
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    while (buf.length > 0) {
      const nl = buf.indexOf(NL);
      if (this.discarding) {
        if (nl < 0) return out;
        this.discarding = false;
        buf = buf.subarray(nl + 1);
        continue;
      }
      const end = nl < 0 ? buf.length : nl;
      if (this.pending + end > this.maxBytes) {
        out.push(new FrameTooLarge(this.maxBytes));
        this.chunks = [];
        this.pending = 0;
        if (nl < 0) {
          this.discarding = true;
          return out;
        }
        buf = buf.subarray(nl + 1);
        continue;
      }
      if (nl < 0) {
        this.chunks.push(buf);
        this.pending += buf.length;
        return out;
      }
      this.chunks.push(buf.subarray(0, nl));
      const line = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      this.pending = 0;
      buf = buf.subarray(nl + 1);
      const text = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (text.trim() === '') continue;
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) out.push(v);
      } catch {
        // rc-file noise before hello
      }
    }
    return out;
  }
}

export function encodeFrame(msg: RpcRequest | RpcResponse | RpcNotification): string {
  return JSON.stringify(msg) + '\n';
}

export type BreakerState = {
  failures: number;
  open: boolean;
  nextAttemptAt: number | null;
  readySince: number | null;
};

export function resetBreaker(): BreakerState {
  return { failures: 0, open: false, nextAttemptAt: null, readySince: null };
}

export function onStartFailed(s: BreakerState, now: number): BreakerState {
  const failures = s.failures + 1;
  const backoff = BACKOFF_MS[failures - 1];
  if (backoff === undefined) return { failures, open: true, nextAttemptAt: null, readySince: null };
  return { failures, open: false, nextAttemptAt: now + backoff, readySince: null };
}

export function onReady(s: BreakerState, now: number): BreakerState {
  if (s.open) return s;
  return { ...s, readySince: now, nextAttemptAt: null };
}

// Once open, only resetBreaker() closes the breaker.
export function onExit(s: BreakerState, now: number): BreakerState {
  if (s.open) return s;
  if (s.readySince === null || now - s.readySince < STABLE_MS) return onStartFailed(s, now);
  return resetBreaker();
}

export function onTick(s: BreakerState, now: number): BreakerState {
  if (!s.open && s.readySince !== null && now - s.readySince >= STABLE_MS && s.failures > 0) {
    return { ...s, failures: 0, open: false, nextAttemptAt: null };
  }
  return s;
}
