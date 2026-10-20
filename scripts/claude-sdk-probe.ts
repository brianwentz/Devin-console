// Spike A (plan §4): can @anthropic-ai/claude-agent-sdk drive the installed
// claude.exe from the Electron main process? Run under BOTH:
//   node out/scripts/sdk-probe.cjs     -> docs/evidence/claude-sdk-probe-node-<ts>.jsonl
//   npx electron out/scripts/sdk-probe.cjs -> docs/evidence/claude-sdk-probe-electron-<ts>.jsonl
// Every step appends { step, ok, ms, detail }; transcript/tool text is redacted
// to lengths — never logged.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveClaudePath } from '../src/main/claude/claudePath';
import { parseShellEnv, spawnSpec, wslHost } from '../src/core/execHost';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

const runtime = typeof process.versions.electron === 'string' ? 'electron' : 'node';
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = join('docs', 'evidence', `claude-sdk-probe-${runtime}-${ts}.jsonl`);
mkdirSync(join('docs', 'evidence'), { recursive: true });

function record(step: string, ok: boolean, ms: number, detail: unknown): void {
  appendFileSync(logFile, JSON.stringify({ step, ok, ms, detail }) + '\n');
  console.log(`${ok ? 'OK ' : 'ERR'} ${step} (${ms}ms)`, JSON.stringify(detail));
}

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, Date.now() - t0, detail);
    return detail;
  } catch (error) {
    record(name, false, Date.now() - t0, {
      error: String(error && typeof error === 'object' && 'message' in error ? error.message : error).slice(0, 400),
    });
    return undefined;
  }
}

function claudeProcessCount(): number {
  const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
  }).stdout;
  return out.split('\n').filter((line) => line.toLowerCase().startsWith('"claude.exe"')).length;
}

function projectFileList(dir: string): Set<string> {
  const set = new Set<string>();
  try {
    for (const project of readdirSync(dir)) {
      const p = join(dir, project);
      for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) set.add(join(p, f));
    }
  } catch {
    // ignore
  }
  return set;
}

// --host wsl:<distro> / AGENT_WORKSPACE_PROBE_HOST: run the same new+resume
// pair against the distro's `claude`, spawned through spawnSpec with the
// captured -ilc environment (mirrors src/main/hosts.ts spawnOn — the probe
// must not import Electron state).
const WSL_ENV_MARKER = '__DW_ENV__';

function runWslArgs(
  args: string[],
  opts: { requireSuccess?: boolean } = {},
): Promise<{ stdout: Buffer; code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolveP, reject) => {
    const child = spawn('wsl.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if ((opts.requireSuccess ?? true) && code !== 0) {
        reject(new Error(`wsl.exe exited ${code}`));
        return;
      }
      resolveP({ stdout: Buffer.concat(stdout), code, ms: Date.now() - t0 });
    });
  });
}

function diffEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v !== undefined && v !== process.env[k]) out[k] = v;
  }
  return out;
}

async function runHostProbe(sdk: Sdk, distro: string): Promise<void> {
  record('wsl-host', true, 0, { distro });
  const homeRes = await runWslArgs(['-d', distro, '-e', '/bin/sh', '-c', 'echo "$HOME"']);
  const home = homeRes.stdout.toString('utf8').trim().split('\n')[0] ?? '/root';
  const shellRes = await runWslArgs([
    '-d', distro, '-e', '/bin/sh', '-c', 'getent passwd "$(id -un)" | cut -d: -f7',
  ]);
  const shell = shellRes.stdout.toString('utf8').trim().split('\n')[0] ?? '/bin/bash';
  const cap = await runWslArgs(
    ['-d', distro, '-e', shell, '-ilc', `printf "\\0${WSL_ENV_MARKER}\\0"; env -0`],
    { requireSuccess: false },
  );
  const env = parseShellEnv(cap.stdout, WSL_ENV_MARKER) ?? {};
  const cliRes = await runWslArgs(
    ['-d', distro, '-e', shell, '-ilc', 'command -v claude'],
    { requireSuccess: false },
  );
  const claudePath = cliRes.stdout.toString('utf8').trim().split('\n')[0] ?? 'claude';
  const host = wslHost(distro, home);
  record('wsl-env', true, cap.ms, {
    count: Object.keys(env).length,
    ok: cap.stdout.includes(WSL_ENV_MARKER),
    shell,
    claude: cliRes.code === 0 ? 'found' : 'missing',
  });

  const spawnClaudeCodeProcess = (o: {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => {
    const spec = spawnSpec(
      host,
      { file: o.command, args: o.args, cwd: o.cwd || home, env: diffEnv(o.env) },
      env,
    );
    return spawn(spec.file, spec.args, {
      cwd: homedir(),
      env: process.env,
      signal: o.signal,
      stdio: 'pipe',
    });
  };

  const sessionId = randomUUID();
  let init: Record<string, unknown> | null = null;
  await step('wsl-new', async () => {
    const q = sdk.query({
      prompt: 'Reply with the single word pong',
      options: {
        cwd: home,
        sessionId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: claudePath || 'claude',
        spawnClaudeCodeProcess,
        settingSources: [] as [],
      } as never,
    });
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      if (m.type === 'system' && m.subtype === 'init') init = m;
    }
    const plugins = (init as { plugins?: unknown[] } | null)?.plugins?.length ?? -1;
    const skills = (init as { skills?: unknown[] } | null)?.skills?.length ?? -1;
    return { sessionIdMatches: (init as { session_id?: string } | null)?.session_id === sessionId, plugins, skills, initFieldsPresent: plugins > 0 && skills > 0 };
  });

  await step('wsl-resume-bash', async () => {
    let toolText = '';
    const q = sdk.query({
      prompt: 'Run exactly this and report the output: echo "$SSH_AUTH_SOCK"; which node; pwd',
      options: {
        cwd: home,
        resume: sessionId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: claudePath || 'claude',
        spawnClaudeCodeProcess,
        settingSources: [] as [],
      } as never,
    });
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      if (m.type === 'user') {
        const content = (m.message as { content?: unknown[] })?.content ?? [];
        for (const block of content) {
          const b = block as { type?: string; content?: string };
          if (b.type === 'tool_result' && typeof b.content === 'string') toolText += b.content;
        }
      }
    }
    return {
      toolTextLen: toolText.length,
      sawSockPath: toolText.includes('/tmp/'),
      sawNodePath: toolText.includes('node'),
      pwdIsHome: toolText.includes(home),
    };
  });
}

async function run(): Promise<void> {
  // Header: SDK version, bundled CLI manifest version, installed CLI version.
  const sdk: Sdk = await import('@anthropic-ai/claude-agent-sdk');
  const hostFlagIdx = process.argv.findIndex((a) => a === '--host');
  const probeHost =
    (hostFlagIdx >= 0 ? process.argv[hostFlagIdx + 1] : undefined) ??
    process.env.AGENT_WORKSPACE_PROBE_HOST;
  if (probeHost?.startsWith('wsl:')) {
    await runHostProbe(sdk, probeHost.slice(4));
    return;
  }
  const sdkPkg = JSON.parse(
    readFileSync(join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'),
  ) as { version: string };
  const manifest = JSON.parse(
    readFileSync(join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'manifest.json'), 'utf8'),
  ) as { version: string };
  record('header', true, 0, {
    runtime,
    sdkVersion: sdkPkg.version,
    manifestCliVersion: manifest.version,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
    bundling: 'external (SDK is ESM-only: createRequire(import.meta.url) fails when bundled to cjs)',
  });

  // 1. resolveClaudePath → pathToClaudeCodeExecutable
  const claudePath = await step('1-resolve-path', () => {
    const path = resolveClaudePath(null);
    if (!path) throw new Error('claude not found on PATH');
    const version = spawnSync(path, ['--version'], { encoding: 'utf8' }).stdout.trim();
    return { found: true, version };
  });
  if (!claudePath) return;
  const cli = resolveClaudePath(null)!;
  const cwd = join(tmpdir(), `cw-sdk-probe-${randomUUID().slice(0, 8)}`);
  mkdirSync(cwd, { recursive: true });
  const sessionId = randomUUID();
  record('cwd', true, 0, { cwd, sessionId });

  const baseOptions = {
    cwd,
    permissionMode: 'default' as const,
    settingSources: [] as [],
    pathToClaudeCodeExecutable: cli,
  };

  // 2. query 'Reply with the single word pong' — stream/init/assistant/result
  await step('2-query', async () => {
    const counts: Record<string, number> = {};
    let initSessionId: string | null = null;
    let result: Record<string, unknown> | null = null;
    let assistantTextLen = 0;
    const q = sdk.query({
      prompt: 'Reply with the single word pong',
      options: { ...baseOptions, sessionId, includePartialMessages: true },
    });
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      counts[m.type as string] = (counts[m.type as string] ?? 0) + 1;
      if (m.type === 'system' && m.subtype === 'init') initSessionId = m.session_id as string;
      if (m.type === 'assistant') {
        const content = (m.message as { content?: unknown[] })?.content ?? [];
        assistantTextLen += JSON.stringify(content).length;
      }
      if (m.type === 'result') result = m;
    }
    return {
      initSessionIdMatches: initSessionId === sessionId,
      counts,
      assistantTextLen,
      result: result
        ? {
            subtype: result.subtype,
            duration_ms: result.duration_ms,
            total_cost_usd: result.total_cost_usd,
            usage: result.usage,
          }
        : null,
    };
  });

  // 3. Permission round-trip: canUseTool + in-process hooks
  await step('3-permission', async () => {
    const seen: Array<{ hook: string; tool?: string | undefined; inputKeys?: number }> = [];
    let toolRan = false;
    const q = sdk.query({
      prompt: 'Create a file named probe.txt containing hello',
      options: {
        ...baseOptions,
        sessionId: randomUUID(),
        canUseTool: async (toolName, input) => {
          seen.push({ hook: 'canUseTool', tool: toolName, inputKeys: Object.keys(input).length });
          await new Promise((r) => setTimeout(r, 500));
          return { behavior: 'allow', updatedInput: input };
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [async (input) => {
                const i = input as { tool_name?: string };
                seen.push({ hook: 'PreToolUse', tool: i.tool_name });
                return {};
              }],
            },
          ],
          PermissionRequest: [
            {
              hooks: [async (input) => {
                const i = input as { tool_name?: string };
                seen.push({ hook: 'PermissionRequest', tool: i.tool_name });
                return {};
              }],
            },
          ],
        },
      },
    });
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      if (m.type === 'result' && m.subtype === 'success') toolRan = true;
    }
    return { events: seen, toolRan, fileCreated: existsSync(join(cwd, 'probe.txt')) };
  });

  // 4. interrupt() mid-turn — error results surface as a throw from the
  // iterator; capture it.
  await step('4-interrupt', async () => {
    const q = sdk.query({
      prompt: 'Count slowly from 1 to 200, one number per line',
      options: { ...baseOptions, sessionId: randomUUID() },
    });
    let resultSubtype: string | null = null;
    let threw: string | null = null;
    const consumer = (async () => {
      try {
        for await (const msg of q) {
          const m = msg as Record<string, unknown>;
          if (m.type === 'result') resultSubtype = m.subtype as string;
        }
      } catch (error) {
        threw = String(error && typeof error === 'object' && 'message' in error ? error.message : error).slice(0, 300);
      }
    })();
    await new Promise((r) => setTimeout(r, 3500));
    let resp: unknown = null;
    try {
      resp = await q.interrupt();
    } catch (error) {
      threw = `interrupt() threw: ${String(error).slice(0, 200)}`;
    }
    await Promise.race([consumer, new Promise((r) => setTimeout(r, 30_000))]);
    return { interruptResponse: resp ?? null, resultSubtype, iteratorThrew: threw };
  });

  // 5. resume — history not re-streamed
  await step('5-resume', async () => {
    const counts: Record<string, number> = {};
    let assistantCount = 0;
    let mentionsPong = false;
    const q = sdk.query({
      prompt: 'What did you reply the first time?',
      options: { ...baseOptions, resume: sessionId },
    });
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      counts[m.type as string] = (counts[m.type as string] ?? 0) + 1;
      if (m.type === 'assistant') {
        assistantCount += 1;
        const content = (m.message as { content?: unknown[] })?.content ?? [];
        if (JSON.stringify(content).toLowerCase().includes('pong')) mentionsPong = true;
      }
    }
    return { counts, assistantCount, mentionsPong };
  });

  // 6. getSessionMessages / getSessionInfo
  await step('6-store-read', async () => {
    const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
    const info = await sdk.getSessionInfo(sessionId, { dir: cwd });
    return {
      messageCount: messages.length,
      messageTypes: messages.reduce<Record<string, number>>((acc, m) => {
        const t = (m as Record<string, unknown>).type as string;
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {}),
      info: info
        ? {
            hasSummary: Boolean(info.summary),
            summaryLen: info.summary?.length ?? 0,
            cwd: info.cwd,
            createdAt: info.createdAt,
            gitBranch: info.gitBranch ?? null,
          }
        : null,
    };
  });

  // 7. listSessions visibility + real-CLI resume by id
  await step('7-visibility', async () => {
    const [all, inclProg] = await Promise.all([
      sdk.listSessions({ dir: cwd }),
      sdk.listSessions({ dir: cwd, includeProgrammatic: true }),
    ]);
    const inDefault = all.some((s) => s.sessionId === sessionId);
    const inProg = inclProg.some((s) => s.sessionId === sessionId);
    const t0 = Date.now();
    const child = spawnSync(cli, ['-r', sessionId, '-p', 'say hi'], {
      encoding: 'utf8',
      cwd,
      timeout: 120_000,
    });
    return {
      inDefaultList: inDefault,
      inProgrammaticList: inProg,
      defaultCount: all.length,
      cliResume: {
        exit: child.status,
        stderrLen: child.stderr?.length ?? 0,
        stdoutLen: child.stdout?.length ?? 0,
        ms: Date.now() - t0,
      },
    };
  });

  // 8. Lock test: SDK query parked on canUseTool; concurrent `claude -r <uuid> -p`
  await step('8-lock', async () => {
    const lockSession = randomUUID();
    const projectsDir = join(homedir(), '.claude', 'projects');
    // First establish the session with a quick prompt so the file exists.
    const seed = sdk.query({
      prompt: 'Reply with the word seeded',
      options: { ...baseOptions, sessionId: lockSession },
    });
    for await (const _m of seed) void _m;
    const before = projectFileList(projectsDir);

    let resolvePerm: (() => void) | null = null;
    const parked = sdk.query({
      prompt: 'Create a file named lockprobe.txt containing x',
      options: {
        ...baseOptions,
        resume: lockSession,
        canUseTool: async (toolName, input) => {
          await new Promise<void>((r) => { resolvePerm = () => r(); });
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });
    let parkedThrew: string | null = null;
    const consumer = (async () => {
      try {
        for await (const _m of parked) void _m;
      } catch (error) {
        parkedThrew = String(error && typeof error === 'object' && 'message' in error ? error.message : error).slice(0, 300);
      }
    })();
    // Wait (bounded) until canUseTool is actually parked before spawning.
    for (let i = 0; i < 100 && !resolvePerm; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const parkedAtCanUseTool = resolvePerm !== null;
    const t0 = Date.now();
    const child = spawnSync(cli, ['-r', lockSession, '-p', 'say hi'], {
      encoding: 'utf8',
      cwd,
      timeout: 120_000,
    });
    const after = projectFileList(projectsDir);
    const newFiles = [...after].filter((f) => !before.has(f));
    (resolvePerm as (() => void) | null)?.();
    await Promise.race([consumer, new Promise((r) => setTimeout(r, 30_000))]);
    return {
      concurrent: {
        exit: child.status,
        stderrLen: child.stderr?.length ?? 0,
        stderrHead: (child.stderr ?? '').slice(0, 300),
        stdoutLen: child.stdout?.length ?? 0,
        ms: Date.now() - t0,
      },
      newSessionFiles: newFiles.length,
      parkedAtCanUseTool,
      parkedThrew,
    };
  });

  // 9. forkSession + renameSession + tagSession + deleteSession
  await step('9-fork', async () => {
    const fork = await sdk.forkSession(sessionId, { dir: cwd });
    const newId = fork.sessionId;
    const rename = await step('9a-rename', () =>
      sdk.renameSession(newId, 'cw-probe-fork', { dir: cwd }).then(() => ({ renamed: true })),
    );
    const tag = await step('9b-tag', () =>
      sdk.tagSession(newId, 'probe', { dir: cwd }).then(() => ({ tagged: true })),
    );
    const resumable = await step('9c-resume-check', async () => {
      const info = await sdk.getSessionInfo(newId, { dir: cwd });
      return { hasInfo: Boolean(info), customTitle: info?.customTitle === 'cw-probe-fork', tag: info?.tag };
    });
    await step('9d-delete', () => sdk.deleteSession(newId, { dir: cwd }).then(() => ({ deleted: true })));
    return { forkedId: newId, rename: rename !== undefined, tag: tag !== undefined, resumable };
  });

  // 10. Shutdown: close() an active query, count claude.exe before/after
  await step('10-shutdown', async () => {
    const before = claudeProcessCount();
    const q = sdk.query({
      prompt: 'Count slowly from 1 to 500, one number per line',
      options: { ...baseOptions, sessionId: randomUUID() },
    });
    const consumer = (async () => { for await (const _m of q) void _m; })();
    // Let the process actually spawn.
    await new Promise((r) => setTimeout(r, 3000));
    const during = claudeProcessCount();
    q.close();
    await Promise.race([consumer, new Promise((r) => setTimeout(r, 15_000))]);
    await new Promise((r) => setTimeout(r, 2000));
    const after2s = claudeProcessCount();
    await new Promise((r) => setTimeout(r, 5000));
    const after7s = claudeProcessCount();
    return { claudeCount: { before, during, after2s, after7s } };
  });

  // 11. Env/console: SDK spawn without WT_SESSION/TERM_PROGRAM (observational)
  await step('11-env', () => ({
    hasWtSession: Boolean(process.env.WT_SESSION),
    termProgram: process.env.TERM_PROGRAM ?? null,
    sdkRanWithoutConsole: true,
  }));

  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    // A just-exited claude.exe may still hold the dir; cosmetic only.
  }
}

async function main(): Promise<void> {
  try {
    await run();
  } finally {
    console.log(`evidence: ${resolve(logFile)}`);
  }
}

async function boot(): Promise<void> {
  if (runtime === 'electron') {
    const { app } = await import('electron');
    await app.whenReady();
    try {
      await main();
    } finally {
      app.exit(0);
    }
    return;
  }
  await main();
}

void boot();
