// Spike A (plan §4): can @anthropic-ai/claude-agent-sdk drive the installed
// claude.exe from the Electron main process? Run under BOTH:
//   node out/scripts/sdk-probe.cjs     -> docs/evidence/claude-sdk-probe-node-<ts>.jsonl
//   npx electron out/scripts/sdk-probe.cjs -> docs/evidence/claude-sdk-probe-electron-<ts>.jsonl
// Every step appends { step, ok, ms, detail }; transcript/tool text is redacted
// to lengths — never logged.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveClaudePath } from '../src/main/claude/claudePath';

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

async function run(): Promise<void> {
  // Header: SDK version, bundled CLI manifest version, installed CLI version.
  const sdk: Sdk = await import('@anthropic-ai/claude-agent-sdk');
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
