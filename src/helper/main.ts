// In-distro helper entry (bundled to out/helper/agent-workspace-helper.mjs,
// deployed as <home>/.agent-workspace/helper-<hash>.mjs, launched with
// `node <file> --stdio`). NDJSON JSON-RPC over stdin/stdout (core/hostRpc.ts):
// stdout carries protocol frames only — the first is `hello` — and nothing
// else is ever written there; diagnostics go to stderr as counts. Exits on
// stdin EOF, SIGTERM and SIGHUP so a dropped channel never leaves an orphan.

import { readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  FrameTooLarge,
  HELPER_PROTOCOL,
  LineDecoder,
  MAX_FRAME_BYTES,
  encodeFrame,
  type Hello,
  type RpcNotification,
  type RpcResponse,
} from '../core/hostRpc';
import { agentsHandlers } from './agents';
import { hooksHandlers, hooksOffOnce } from './hooks';
import { RpcError, safeMessage, type Handler } from './params';
import { changePayload, storeHandlers, type StoreChanged } from './store';
import { ProjectsWatcher, type WatchChange } from './watch';

export const TOUCH_INTERVAL_MS = 3_600_000;
export const CLEANUP_AGE_MS = 7 * 24 * 3_600_000;
/** On stdin EOF, in-flight requests get this long to answer before exit. */
const DRAIN_MS = 2_000;

const HELPER_FILE_RE = /^helper-([0-9a-f]{12})\.mjs$/;
// Deploy temp files (`.tmp.$$`) a failed `cat` left behind.
const DEPLOY_TMP_RE = /^\.tmp\.\d+$/;

/** The hash is the deployed filename's — embedding it in the bundle would change the hash. */
export function hashFromPath(file: string): string | null {
  return HELPER_FILE_RE.exec(basename(file))?.[1] ?? null;
}

export function touchSelf(file: string): void {
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch {
    // best-effort: a stale mtime only risks a sibling's cleanup after 7 days
  }
}

/** Touch now and every hour; returns a stop function. */
export function startSelfTouch(file: string, touch: (file: string) => void = touchSelf): () => void {
  touch(file);
  const timer = setInterval(() => touch(file), TOUCH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Deletes other `helper-*.mjs` (and stale deploy temps) in `dir` whose mtime is
 * older than 7 days. A running helper of another version keeps its own file
 * fresh, so it is never removed. Returns the number deleted.
 */
export function cleanupOldHelpers(dir: string, selfName: string, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    if (name === selfName || !(HELPER_FILE_RE.test(name) || DEPLOY_TMP_RE.test(name))) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs <= CLEANUP_AGE_MS) continue;
      unlinkSync(file);
      deleted++;
    } catch {
      // vanished or not ours to delete
    }
  }
  return deleted;
}

const isRequest = (f: unknown): f is { id: number; method: string; params?: unknown } =>
  typeof f === 'object' &&
  f !== null &&
  typeof (f as { id?: unknown }).id === 'number' &&
  typeof (f as { method?: unknown }).method === 'string';

export async function dispatch(handlers: Record<string, Handler>, id: number, method: string, params: unknown): Promise<RpcResponse> {
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
  if (!handler) return { id, error: { code: 'unknown-method', message: `unknown method ${method.slice(0, 64)}` } };
  try {
    const result = await handler(params);
    return { id, result: result === undefined ? null : result };
  } catch (error) {
    if (error instanceof RpcError) return { id, error: { code: error.code, message: safeMessage(error) } };
    return { id, error: { code: 'internal', message: safeMessage(error) } };
  }
}

/**
 * `store.changed` sender: payloads (which await getSessionInfo per id) are
 * built and written strictly in flush order, so a slow earlier flush can never
 * land after — and overwrite — a newer one. A failed payload is dropped.
 */
export function createChangeNotifier(
  write: (msg: RpcNotification) => void,
  payload: (change: WatchChange) => Promise<StoreChanged>,
): (change: WatchChange) => void {
  let queue: Promise<void> = Promise.resolve();
  return (change) => {
    queue = queue
      .then(() => payload(change))
      .then(
        (params) => write({ method: 'store.changed', params }),
        () => undefined,
      );
  };
}

/**
 * Last-resort handlers. stdout stays frames-only, so both report a count line
 * on stderr (never the error text — it can carry paths). A stray rejection
 * keeps the helper serving; an uncaught exception leaves state unknown, so
 * exit non-zero and let the channel respawn.
 */
export function installProcessHandlers(
  proc: NodeJS.Process,
  writeErr: (line: string) => void,
  exit: (code: number) => void,
): void {
  let rejections = 0;
  let exceptions = 0;
  proc.on('unhandledRejection', () => {
    rejections++;
    writeErr(`helper: unhandledRejection=${rejections}\n`);
  });
  proc.on('uncaughtException', () => {
    exceptions++;
    writeErr(`helper: uncaughtException=${exceptions}\n`);
    exit(1);
  });
}

function run(): void {
  const self = process.argv[1] ? resolve(process.argv[1]) : '';
  const selfName = basename(self);
  const hash = hashFromPath(self);
  const home = process.env.HOME || homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const projectsDir = join(configDir, 'projects');
  const counts = { tooLarge: 0, ignored: 0 };

  const write = (msg: RpcResponse | RpcNotification): void => {
    let line = encodeFrame(msg);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES && 'id' in msg) {
      line = encodeFrame({ id: msg.id, error: { code: 'too-large', message: 'result exceeds the frame limit; page it' } });
    }
    process.stdout.write(line);
  };

  // Replaced by the draining exit below once the watcher exists.
  let exitWith = (code: number): void => process.exit(code);
  installProcessHandlers(process, (line) => process.stderr.write(line), (code) => exitWith(code));

  let subscribed = false;
  const notify = createChangeNotifier(write, (change) => changePayload(projectsDir, change));
  const watcher = new ProjectsWatcher({
    projectsDir,
    onChange: (change) => {
      if (subscribed) notify(change);
    },
  });
  try {
    watcher.start();
  } catch {
    // start() falls back to poll on its own; never block hello
  }

  const hello: Hello = {
    protocol: HELPER_PROTOCOL,
    hash: hash ?? 'unknown',
    node: process.versions.node,
    pid: process.pid,
    home,
    watchMode: watcher.mode,
  };
  // Only a deployed helper-<hash>.mjs manages its directory — a dev run of
  // out/helper/agent-workspace-helper.mjs must not touch its neighbours.
  // Before hello (a few sync syscalls), so a ready channel implies a fresh mtime.
  if (hash) {
    startSelfTouch(self);
    cleanupOldHelpers(dirname(self), selfName);
  }
  write({ method: 'hello', params: hello });

  const handlers: Record<string, Handler> = {
    ping: () => ({ t: Date.now() }),
    'env.get': () => ({ env: { ...process.env }, watchMode: watcher.mode }),
    'watch.subscribe': () => {
      subscribed = true;
      return {};
    },
    ...storeHandlers(configDir),
    ...hooksHandlers(configDir),
    ...agentsHandlers(),
  };

  let inFlight = 0;
  let ending = false;
  const exit = (code: number): void => {
    watcher.stop();
    if (counts.tooLarge || counts.ignored) process.stderr.write(`helper: tooLarge=${counts.tooLarge} ignored=${counts.ignored}\n`);
    // Let queued stdout frames reach the pipe first (async pipes on Windows).
    process.stdout.write('', () => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
  };
  exitWith = exit;
  const maybeExit = (): void => {
    if (ending && inFlight === 0) exit(0);
  };

  const decoder = new LineDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame instanceof FrameTooLarge) {
        counts.tooLarge++; // no id survives an oversize line, so nothing to answer
        continue;
      }
      if (!isRequest(frame)) {
        counts.ignored++;
        continue;
      }
      inFlight++;
      void dispatch(handlers, frame.id, frame.method, frame.params).then((res) => {
        write(res);
        inFlight--;
        maybeExit();
      });
    }
  });
  process.stdin.on('end', () => {
    ending = true;
    maybeExit();
    setTimeout(() => exit(0), DRAIN_MS).unref();
  });
  process.stdin.on('error', () => exit(0));
  process.stdout.on('error', () => process.exit(0));
  process.on('SIGTERM', () => exit(0));
  process.on('SIGHUP', () => exit(0));
}

if (process.argv.includes('--stdio')) run();
else if (process.argv.includes('--apply-hooks-off')) {
  // One-shot opt-out (no stdio protocol): exit 0/1, a count line on stderr.
  const home = process.env.HOME || homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  void hooksOffOnce(configDir, (line) => process.stderr.write(line)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
