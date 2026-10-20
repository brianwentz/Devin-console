// P4 contract run against the real `devin acp` (ACP v1). Exercises exactly the
// operations DevinLocalHost relies on and asserts the shapes it depends on:
//   initialize → protocolVersion 1, agentCapabilities.loadSession,
//                agentCapabilities.sessionCapabilities.list
//   session/new → sessionId
//   session/prompt → streamed session/update (agent_message_chunk …), stopReason end_turn
//   session/cancel → stopReason 'cancelled'
//   session/list (iff capability) → includes our session
//   session/load (iff capability) → replays ≥1 user_message_chunk
// Writes docs/evidence/p4-acp-contract.jsonl. Exit code 0 when every assertion
// holds (or the CLI is unauthenticated / missing — reported, not failed).
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

import { parseShellEnv, spawnSpec, wslHost } from '../src/core/execHost';

const evidenceDir = resolve(process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? 'docs/evidence');
// AGENT_WORKSPACE_HOST=wsl:<distro> runs the agent through wsl.exe with the
// distro's captured -ilc environment; cwd becomes the distro home.
const probeHost = process.env.AGENT_WORKSPACE_HOST;
const outputPath = join(
  evidenceDir,
  probeHost ? 'p4-acp-contract-wsl.jsonl' : 'p4-acp-contract.jsonl',
);
const timeoutMs = 60_000;

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
let logStream: ReturnType<typeof createWriteStream> | null = null;
let stderrText = '';

function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  process.stdout.write(`${line}\n`);
  logStream?.write(`${line}\n`);
}

function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, detail });
  record({ kind: 'check', name, ok, detail });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function unauthenticated(error: unknown): boolean {
  return /auth[_ -]?required|unauthenticated|not authenticated|not logged in|authentication required|please log in|sign in|unauthorized|(?:http|status(?: code)?)\s*401/i.test(
    `${errorMessage(error)}\n${stderrText}`,
  );
}

function withTimeout<T>(promise: Promise<T>, operation: string, ms = timeoutMs): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${operation} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function resolveDevin(): string | null {
  const override = process.env.DEVIN_CLI;
  if (override) return existsSync(override) ? override : null;
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, ['devin'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first && existsSync(first) ? first : null;
}

// Minimal -ilc env capture (mirrors src/main/hosts.ts; no Electron imports).
const WSL_ENV_MARKER = '__DW_ENV__';
function runWslArgs(args: string[], requireSuccess = true): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const child = spawn('wsl.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (requireSuccess && code !== 0) reject(new Error(`wsl.exe exited ${code}`));
      else resolveP(Buffer.concat(out));
    });
  });
}

async function wslSpawnSpec(distro: string): Promise<{
  file: string;
  args: string[];
  spawnCwd: string;
  agentCwd: string;
  devinPath: string | null;
} | null> {
  const home =
    (await runWslArgs(['-d', distro, '-e', '/bin/sh', '-c', 'echo "$HOME"']))
      .toString('utf8')
      .trim()
      .split('\n')[0] ?? '/root';
  const shell =
    (await runWslArgs(['-d', distro, '-e', '/bin/sh', '-c', 'getent passwd "$(id -un)" | cut -d: -f7']))
      .toString('utf8')
      .trim()
      .split('\n')[0] ?? '/bin/bash';
  const cap = await runWslArgs(
    ['-d', distro, '-e', shell, '-ilc', `printf "\\0${WSL_ENV_MARKER}\\0"; env -0`],
    false,
  );
  const env = parseShellEnv(cap, WSL_ENV_MARKER) ?? {};
  const devinOut = await runWslArgs(
    ['-d', distro, '-e', shell, '-ilc', 'command -v devin'],
    false,
  );
  const devinPath =
    devinOut.length > 0 ? devinOut.toString('utf8').trim().split('\n')[0]! : null;
  if (!devinPath) return null;
  const spec = spawnSpec(
    wslHost(distro, home),
    { file: devinPath, args: ['acp'], cwd: home },
    env,
  );
  return { file: spec.file, args: spec.args, spawnCwd: spec.cwd ?? homedir(), agentCwd: home, devinPath };
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => {
      clearTimeout(force);
      resolveExit();
    });
    child.stdin.end();
    setTimeout(() => child.kill(), 500);
  });
}

async function run(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  logStream = createWriteStream(outputPath, { flags: 'w' });
  const devin = resolveDevin();
  let status = 'error';
  let child: ChildProcessWithoutNullStreams | null = null;
  const workspace = await mkdtemp(join(tmpdir(), 'agent-workspace-p4-'));
  const updates: SessionNotification[] = [];

  try {
    let spawnFile = devin;
    let spawnArgs = ['acp'];
    let spawnCwd = workspace;
    let agentCwd = workspace;
    if (probeHost?.startsWith('wsl:')) {
      const spec = await wslSpawnSpec(probeHost.slice(4));
      if (!spec) {
        status = 'missing-cli';
        record({
          kind: 'missing-cli',
          message: `devin not found inside ${probeHost}`,
          host: probeHost,
        });
        return;
      }
      spawnFile = spec.file;
      spawnArgs = spec.args;
      spawnCwd = spec.spawnCwd;
      agentCwd = spec.agentCwd;
      record({ kind: 'start', devin: spec.devinPath, host: probeHost, agentCwd });
    } else {
      if (!devin) {
        status = 'missing-cli';
        record({ kind: 'missing-cli', message: 'devin not found on PATH (set DEVIN_CLI to override)' });
        return;
      }
      record({ kind: 'start', devin, workspace, platform: process.platform });
    }
    child = spawn(spawnFile!, spawnArgs, { cwd: spawnCwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client: Client = {
      async sessionUpdate(params) {
        updates.push(params);
        record({ kind: 'session/update', sessionId: params.sessionId, update: params.update.sessionUpdate });
      },
      async requestPermission(params) {
        record({ kind: 'session/request_permission', options: params.options, decision: 'cancelled' });
        return { outcome: { outcome: 'cancelled' } };
      },
    };
    const connection = new ClientSideConnection(() => client, stream);

    const init = await withTimeout(
      connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'agent-workspace-p4-contract', version: '0.1.0' },
        clientCapabilities: {},
      }),
      'initialize',
    );
    record({ kind: 'initialize', response: init });
    check('initialize.protocolVersion === 1', init.protocolVersion === 1, init.protocolVersion);
    const loadSession = init.agentCapabilities?.loadSession === true;
    const sessionList = Boolean(init.agentCapabilities?.sessionCapabilities?.list);
    check('agentCapabilities.loadSession is boolean', typeof init.agentCapabilities?.loadSession === 'boolean', loadSession);
    check('agentCapabilities.sessionCapabilities present', init.agentCapabilities?.sessionCapabilities !== undefined, { sessionList });

    const created = await withTimeout(connection.newSession({ cwd: agentCwd, mcpServers: [] }), 'session/new');
    record({ kind: 'session/new', response: { sessionId: created.sessionId } });
    check('session/new returns sessionId', typeof created.sessionId === 'string' && created.sessionId.length > 0);
    const sessionId = created.sessionId;

    const before = updates.length;
    const prompt = await withTimeout(
      connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: pong' }] }),
      'session/prompt',
      120_000,
    );
    const streamed = updates.slice(before).filter((u) => u.sessionId === sessionId);
    record({ kind: 'session/prompt', stopReason: prompt.stopReason, updates: streamed.map((u) => u.update.sessionUpdate) });
    check('prompt stopReason end_turn', prompt.stopReason === 'end_turn', prompt.stopReason);
    check(
      'prompt streamed agent_message_chunk',
      streamed.some((u) => u.update.sessionUpdate === 'agent_message_chunk'),
      streamed.length,
    );

    const slow = connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'Count from 1 to 200 slowly, one number per line.' }] });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
    await connection.cancel({ sessionId });
    const cancelled = await withTimeout(slow, 'cancelled session/prompt', 60_000);
    record({ kind: 'session/cancel', stopReason: cancelled.stopReason });
    check('cancel → stopReason cancelled', cancelled.stopReason === 'cancelled', cancelled.stopReason);

    if (sessionList) {
      const list = await withTimeout(connection.listSessions({ cwd: agentCwd }), 'session/list');
      record({ kind: 'session/list', count: list.sessions.length, ids: list.sessions.map((s) => s.sessionId) });
      check('session/list includes our session', list.sessions.some((s) => s.sessionId === sessionId));
    } else {
      record({ kind: 'session/list', skipped: 'capability not advertised' });
    }

    if (loadSession) {
      const beforeLoad = updates.length;
      await withTimeout(connection.loadSession({ sessionId, cwd: agentCwd, mcpServers: [] }), 'session/load');
      const replayed = updates.slice(beforeLoad).filter((u) => u.sessionId === sessionId);
      record({ kind: 'session/load', replayed: replayed.map((u) => u.update.sessionUpdate) });
      check(
        'session/load replays user_message_chunk',
        replayed.some((u) => u.update.sessionUpdate === 'user_message_chunk'),
        replayed.length,
      );
    } else {
      record({ kind: 'session/load', skipped: 'capability not advertised' });
    }
    status = checks.every((c) => c.ok) ? 'pass' : 'fail';
  } catch (error) {
    status = unauthenticated(error) ? 'unauthenticated' : 'error';
    record({ kind: 'error', status, error: errorMessage(error), stderr: stderrText.slice(-2000) });
  } finally {
    if (child) await stop(child);
    record({
      kind: 'finished',
      status,
      checks: checks.map(({ name, ok }) => ({ name, ok })),
      passed: checks.filter((c) => c.ok).length,
      total: checks.length,
    });
    await new Promise<void>((resolveClose) => logStream?.end(resolveClose) ?? resolveClose());
    await rm(workspace, { recursive: true, force: true });
    process.exitCode = status === 'pass' || status === 'unauthenticated' || status === 'missing-cli' ? 0 : 1;
  }
}

void run();
