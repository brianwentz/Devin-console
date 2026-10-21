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

// --- channel liveness (main-process HostChannel) ------------------------------

export const SILENCE_PING_MS = 15_000;
export const SILENCE_KILL_MS = 45_000;
export const HELLO_DEADLINE_MS = 20_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const LONG_REQUEST_TIMEOUT_MS = 60_000;
/** Max messages per store.messages / store.subagentMessages page; callers page until a short page. */
export const STORE_MESSAGES_PAGE = 500;
/** Page cap for one history read (200 × 500 = 100 000 messages). */
export const STORE_MAX_PAGES = 200;

export class PagingError extends Error {
  constructor(
    readonly code: 'bad-page' | 'bad-paging' | 'too-many-pages',
    message: string,
  ) {
    super(message);
    this.name = 'PagingError';
  }
}

/**
 * Reads every page (`fetch(offset, limit)`) until a short page. The remote
 * side is not trusted to honour `offset`: a full page identical in its first
 * item to the previous one, a non-array / oversized page, or more than
 * `maxPages` full pages rejects with a PagingError instead of looping.
 */
export async function pageAll(
  fetch: (offset: number, limit: number) => Promise<unknown[]>,
  limit: number,
  maxPages: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let previousHead: string | null = null;
  for (let n = 0; n < maxPages; n++) {
    const page = await fetch(out.length, limit);
    if (!Array.isArray(page) || page.length > limit) throw new PagingError('bad-page', 'malformed page');
    if (page.length > 0) {
      const head = JSON.stringify(page[0]);
      if (head === previousHead) throw new PagingError('bad-paging', 'page repeated: offset ignored');
      previousHead = head;
    }
    out.push(...page);
    if (page.length < limit) return out;
  }
  throw new PagingError('too-many-pages', `no short page within ${maxPages} pages`);
}

const LONG_METHODS: ReadonlySet<string> = new Set(['store.list', 'usage.scan']);

export function requestTimeoutMs(method: string): number {
  return LONG_METHODS.has(method) ? LONG_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

export type LivenessAction = 'none' | 'ping' | 'kill';

/** Any frame counts as life: one ping after `silenceMs` of quiet, a kill after `killMs` with no frame at all. */
export function livenessAction(
  now: number,
  lastFrameAt: number,
  pingOutstanding: boolean,
  silenceMs: number,
  killMs: number,
): LivenessAction {
  const quiet = now - lastFrameAt;
  if (quiet >= killMs) return 'kill';
  if (quiet >= silenceMs && !pingOutstanding) return 'ping';
  return 'none';
}
