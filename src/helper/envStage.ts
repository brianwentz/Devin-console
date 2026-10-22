// env.stage (fix round 1 #4): an ssh pty must get the app's extra env (the
// hook bearer token) without it appearing in any argv (remote `ps`,
// /proc/*/cmdline, audit logs). The app sends the vars over the channel; this
// writes them as `export K='v'` lines to <home>/.agent-workspace/run/<random>
// — dir 0700, file 0600, created O_EXCL — and the pty's `/bin/sh` sources and
// deletes it (core/execHost SSH_RUN_FILE_SCRIPT). Files a pty never consumed
// are swept after STAGE_MAX_AGE_MS.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HELPER_DIR, sshEnvFileContent } from '../core/execHost';
import { RpcError } from './params';

export const STAGE_MAX_VARS = 64;
export const STAGE_MAX_BYTES = 64 * 1024;
export const STAGE_MAX_AGE_MS = 3_600_000;
const STAGED_NAME = /^[0-9a-f]{32}$/;

function varsOf(params: unknown): Record<string, string> {
  const vars = (params as { vars?: unknown } | null)?.vars;
  if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) throw new RpcError('bad-params', 'vars must be an object');
  const entries = Object.entries(vars as Record<string, unknown>);
  if (entries.length > STAGE_MAX_VARS) throw new RpcError('bad-params', 'too many vars');
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string') throw new RpcError('bad-params', 'var values must be strings');
    out[key] = value;
  }
  return out;
}

async function sweep(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!STAGED_NAME.test(name)) continue;
    const file = join(dir, name);
    try {
      if (now - (await stat(file)).mtimeMs > STAGE_MAX_AGE_MS) await unlink(file);
    } catch {
      // consumed meanwhile
    }
  }
}

/** `path` is the helper-native absolute path (the app falls back to <probed home>/.agent-workspace/run/<name>). */
export async function stageEnv(home: string, params: unknown, now = Date.now()): Promise<{ name: string; path: string }> {
  const vars = varsOf(params);
  let content: string;
  try {
    content = sshEnvFileContent(vars);
  } catch {
    throw new RpcError('bad-params', 'invalid var name or value');
  }
  if (Buffer.byteLength(content) > STAGE_MAX_BYTES) throw new RpcError('bad-params', 'vars too large');
  const dir = join(home, HELPER_DIR, 'run');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await sweep(dir, now);
  const name = randomBytes(16).toString('hex');
  const handle = await open(join(dir, name), 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return { name, path: join(dir, name) };
}
