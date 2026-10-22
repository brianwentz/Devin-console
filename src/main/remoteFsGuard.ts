// Regression guard (spec §3.3): the app must never touch a WSL distro's
// filesystem from Windows (`\\wsl.localhost` is 9P — hammering it wedged
// users' WSL VMs). Every remote read goes over the per-host helper channel.
//
// The guard patches the `fs` / `fs/promises` module objects in place. The main
// bundle is esbuild CJS, which compiles `import { readFile } from 'node:fs'`
// into `(0, import_fs.readFile)(…)` — a property read at call time — so every
// bundled caller sees the wrapper regardless of when it was imported.
// `syncBuiltinESMExports()` pushes the patch into ESM named-import bindings
// (the externally loaded Agent SDK, vitest). Not covered: native addons and
// Node/Electron internals that call the C++ bindings directly.
//
// Explicitly out of scope: `shell.showItemInFolder` and the native folder
// dialog opening a `\\wsl.localhost` path on the user's click — Explorer
// does that access, not the app.
//
// Both modes log `remote-fs-violation {op}` once per op. Test mode then throws
// RemoteFsViolation (promise forms reject); production lets the call through.

import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export class RemoteFsViolation extends Error {
  readonly op: string;
  constructor(op: string) {
    super(`remote fs access via ${op} (app-originated fs on a WSL path)`);
    this.name = 'RemoteFsViolation';
    this.op = op;
  }
}

export interface RemoteFsGuardOptions {
  throwOnViolation: boolean;
  /** Extra path roots treated as remote (the e2e UNC-root stand-in). */
  extraPrefixes: string[];
  /** Event sink, called once per op (both modes). */
  log?: (op: string) => void;
}

const isWindows = process.platform === 'win32';

// Normalised (backslashes, lower case) — `//wsl.localhost/` folds into the first.
const BUILTIN_PREFIXES = ['\\\\wsl.localhost', '\\\\wsl$', '\\\\?\\unc\\wsl.localhost', '\\\\?\\unc\\wsl$'];

/** fs ops whose first two arguments are both paths. */
const TWO_PATH = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']);

const FS_OPS = [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'copyFile', 'copyFileSync',
  'cp', 'cpSync', 'createReadStream', 'createWriteStream', 'existsSync', 'link', 'linkSync', 'lstat',
  'lstatSync', 'mkdir', 'mkdirSync', 'open', 'openSync', 'opendir', 'opendirSync', 'readdir', 'readdirSync',
  'readFile', 'readFileSync', 'realpath', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir',
  'rmdirSync', 'stat', 'statSync', 'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink',
  'unlinkSync', 'utimes', 'utimesSync', 'watch', 'watchFile', 'writeFile', 'writeFileSync',
];

const PROMISE_OPS = [
  'access', 'appendFile', 'chmod', 'copyFile', 'cp', 'link', 'lstat', 'mkdir', 'open', 'opendir', 'readdir',
  'readFile', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'watch',
  'writeFile',
];

function normalise(path: string): string {
  const slashed = path.replace(/\//g, '\\');
  return isWindows ? slashed.toLowerCase() : slashed;
}

function normalisePrefix(prefix: string): string {
  return normalise(prefix).replace(/\\+$/, '');
}

function startsWithRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}\\`);
}

/** fs path argument → string; null for fds and anything else. */
function pathOf(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (Buffer.isBuffer(arg)) return arg.toString();
  if (arg instanceof URL) {
    try {
      return fileURLToPath(arg);
    } catch {
      return null;
    }
  }
  return null;
}

/** True when `path` is under a WSL UNC root or one of `extraPrefixes`. */
export function isRemoteFsPath(path: string, extraPrefixes: string[]): boolean {
  const p = normalise(path);
  if (BUILTIN_PREFIXES.some((root) => startsWithRoot(p, root))) return true;
  return extraPrefixes.some((prefix) => {
    const root = normalisePrefix(prefix);
    return root.length > 0 && startsWithRoot(p, root);
  });
}

type Fn = (...args: unknown[]) => unknown;

let installed: { originals: Array<[Record<string, unknown>, string, Fn]> } | null = null;
let violations = 0;
const loggedOps = new Set<string>();

/** Violations seen since install (both modes) — the `remoteFsViolations` hook. */
export function remoteFsViolationCount(): number {
  return violations;
}

export function installRemoteFsGuard(opts: RemoteFsGuardOptions): void {
  if (installed) uninstallRemoteFsGuard();
  const extra = opts.extraPrefixes.filter((p) => p.trim().length > 0);
  const originals: Array<[Record<string, unknown>, string, Fn]> = [];
  violations = 0;
  loggedOps.clear();

  const wrap = (target: Record<string, unknown>, name: string, op: string, isPromise: boolean): void => {
    const original = target[name];
    if (typeof original !== 'function') return;
    const fn = original as Fn;
    const argCount = TWO_PATH.has(name) ? 2 : 1;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      for (let i = 0; i < argCount; i++) {
        const path = pathOf(args[i]);
        if (path === null || !isRemoteFsPath(path, extra)) continue;
        violations += 1;
        // Logged in both modes: a test-mode throw a caller swallows still
        // leaves the event for the e2e teardown to find.
        if (!loggedOps.has(op)) {
          loggedOps.add(op);
          try {
            opts.log?.(op);
          } catch {
            /* logging must never break the call */
          }
        }
        if (opts.throwOnViolation) {
          const error = new RemoteFsViolation(op);
          if (isPromise) return Promise.reject(error);
          throw error;
        }
        break;
      }
      return fn.apply(this, args);
    };
    // Keep attached helpers such as `realpathSync.native`.
    for (const key of Reflect.ownKeys(fn)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      const desc = Object.getOwnPropertyDescriptor(fn, key);
      if (desc) Object.defineProperty(wrapped, key, desc);
    }
    Object.defineProperty(wrapped, 'name', { value: fn.name });
    target[name] = wrapped;
    originals.push([target, name, fn]);
  };

  // The real CJS module objects — an `import * as fs` namespace (ESM, or
  // esbuild's __toESM copy) is a read-only view and can't be patched.
  const fsMod = process.getBuiltinModule('node:fs');
  for (const name of FS_OPS) wrap(fsMod as unknown as Record<string, unknown>, name, name, false);
  const promises = fsMod.promises as unknown as Record<string, unknown>;
  for (const name of PROMISE_OPS) wrap(promises, name, `promises.${name}`, true);
  installed = { originals };
  syncBuiltinESMExports();
}

/** Restores the original functions (unit tests). */
export function uninstallRemoteFsGuard(): void {
  if (!installed) return;
  for (const [target, name, fn] of installed.originals) target[name] = fn;
  installed = null;
  violations = 0;
  loggedOps.clear();
  syncBuiltinESMExports();
}
