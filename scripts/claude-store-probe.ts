// Spike C (plan §6): can the Phase 1 registry be built on the SDK's store
// functions vs an own parser? Read-only against the real ~/.claude except a
// temp-cwd prompt in step 4 (subagent) and step 5 (fs.watch latency).
// Evidence: docs/evidence/claude-store-probe-<ts>.json (single JSON doc).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, rmSync, type FSWatcher } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { resolveClaudePath } from '../src/main/claude/claudePath';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = join('docs', 'evidence', `claude-store-probe-${ts}.json`);
mkdirSync(join('docs', 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = { steps: {} };
const steps = evidence.steps as Record<string, { ok: boolean; ms: number; detail: unknown }>;

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    steps[name] = { ok: true, ms: Date.now() - t0, detail };
    console.log(`OK  ${name}`, JSON.stringify(detail).slice(0, 300));
    return detail;
  } catch (error) {
    steps[name] = {
      ok: false,
      ms: Date.now() - t0,
      detail: { error: String(error && typeof error === 'object' && 'message' in error ? error.message : error).slice(0, 400) },
    };
    console.log(`ERR ${name}`, String(error).slice(0, 200));
    return undefined;
  }
}

function walkProjects(projectsDir: string): { file: string; sessionId: string; size: number; lines: string[] | null }[] {
  const out: { file: string; sessionId: string; size: number; lines: string[] | null }[] = [];
  if (!existsSync(projectsDir)) return out;
  for (const project of readdirSync(projectsDir)) {
    const dir = join(projectsDir, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      out.push({ file, sessionId: basename(f, '.jsonl'), size: statSync(file).size, lines: null });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const sdk: Sdk = await import('@anthropic-ai/claude-agent-sdk');
  const sdkPkg = JSON.parse(
    readFileSync(join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'),
  ) as { version: string };
  const manifest = JSON.parse(
    readFileSync(join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'manifest.json'), 'utf8'),
  ) as { version: string };
  const cli = resolveClaudePath(null);
  const cliVersion = cli ? spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim() : null;
  evidence.header = { sdkVersion: sdkPkg.version, manifestCliVersion: manifest.version, cliVersion, nodeVersion: process.version };

  const projectsDir = join(homedir(), '.claude', 'projects');
  const walk = walkProjects(projectsDir);

  // 1. listSessions() all projects, with and without includeProgrammatic
  await step('1-listSessions', async () => {
    const t1 = Date.now();
    const all = await sdk.listSessions();
    const msAll = Date.now() - t1;
    const t2 = Date.now();
    const prog = await sdk.listSessions({ includeProgrammatic: true });
    const msProg = Date.now() - t2;
    const fields = ['summary', 'customTitle', 'firstPrompt', 'gitBranch', 'cwd', 'createdAt', 'lastModified', 'fileSize', 'tag'];
    const present: Record<string, number> = {};
    for (const f of fields) present[f] = prog.filter((s) => (s as Record<string, unknown>)[f] != null).length;
    const listedIds = new Set(prog.map((s) => s.sessionId));
    const omitted = walk.filter((w) => !listedIds.has(w.sessionId));
    // Classify omitted files by first line type.
    const omittedFirstTypes: Record<string, number> = {};
    for (const o of omitted.slice(0, 50)) {
      try {
        const first = readFileSync(o.file, 'utf8').split('\n', 1)[0]!;
        const t = (JSON.parse(first) as { type?: string }).type ?? 'unknown';
        omittedFirstTypes[t] = (omittedFirstTypes[t] ?? 0) + 1;
      } catch {
        omittedFirstTypes.unreadable = (omittedFirstTypes.unreadable ?? 0) + 1;
      }
    }
    return {
      countAll: all.length,
      countWithProgrammatic: prog.length,
      msAll,
      msProgrammatic: msProg,
      fieldsPresent: present,
      dirWalkFiles: walk.length,
      omittedCount: omitted.length,
      omittedFirstLineTypes: omittedFirstTypes,
      programmaticOnlyCount: prog.length - all.length,
    };
  });

  // 2. listSessions({ dir }) on a real project, includeWorktrees on/off
  const targetDir = 'C:\\Users\\brian\\source\\repos\\housekeeping-app';
  await step('2-listSessions-dir', async () => {
    if (!existsSync(targetDir)) return { exists: false };
    const plain = await sdk.listSessions({ dir: targetDir });
    const worktrees = await sdk.listSessions({ dir: targetDir, includeWorktrees: true });
    return {
      exists: true,
      count: plain.length,
      countWithWorktrees: worktrees.length,
      cwds: [...new Set(plain.map((s) => s.cwd))].length,
    };
  });

  // 3. getSessionMessages on the largest file
  await step('3-getSessionMessages', async () => {
    const largest = walk.reduce((a, b) => (b.size > a.size ? b : a));
    const projectDirName = basename(largest.file.replace(/[/\\][^/\\]+$/, ''));
    void projectDirName;
    const t1 = Date.now();
    const messages = await sdk.getSessionMessages(largest.sessionId);
    const ms = Date.now() - t1;
    const types: Record<string, number> = {};
    let toolUses = 0;
    let toolResults = 0;
    for (const m of messages) {
      const rec = m as Record<string, unknown>;
      types[rec.type as string] = (types[rec.type as string] ?? 0) + 1;
      const content = (rec.message as { content?: unknown[] })?.content;
      if (Array.isArray(content)) {
        for (const c of content as Array<{ type?: string }>) {
          if (c.type === 'tool_use') toolUses += 1;
          if (c.type === 'tool_result') toolResults += 1;
        }
      }
    }
    return {
      fileSizeKB: Math.round(largest.size / 1024),
      sessionIdPrefix: largest.sessionId.slice(0, 8),
      ms,
      messageCount: messages.length,
      types,
      toolUseCount: toolUses,
      toolResultCount: toolResults,
    };
  });

  // 4. listSubagents / getSubagentMessages — find or create a subagents dir
  await step('4-subagents', async () => {
    // Scan for an existing <sessionId>/subagents/ dir.
    let found: { sessionId: string; agents: string[] } | null = null;
    for (const project of readdirSync(projectsDir)) {
      const dir = join(projectsDir, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        const sub = join(dir, entry, 'subagents');
        if (existsSync(sub) && statSync(sub).isDirectory()) {
          const agents = readdirSync(sub).filter((f) => f.endsWith('.jsonl'));
          if (agents.length) {
            found = { sessionId: entry, agents };
            break;
          }
        }
      }
      if (found) break;
    }
    let created = false;
    if (!found && cli) {
      // Run one SDK prompt that uses the Agent tool in a temp cwd.
      const cwd = join(tmpdir(), `cw-store-sub-${randomUUID().slice(0, 8)}`);
      mkdirSync(cwd, { recursive: true });
      const sessionId = randomUUID();
      const q = sdk.query({
        prompt: 'Use the Agent tool to list the files in the current directory',
        options: {
          cwd,
          sessionId,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          pathToClaudeCodeExecutable: cli,
        },
      });
      for await (const _m of q) void _m;
      // Look for the new session's subagents dir.
      for (const project of readdirSync(projectsDir)) {
        const sub = join(projectsDir, project, sessionId, 'subagents');
        if (existsSync(sub)) {
          found = { sessionId, agents: readdirSync(sub).filter((f) => f.endsWith('.jsonl')) };
          created = true;
          break;
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
    if (!found) return { found: false, created };
    const listed = await sdk.listSubagents(found.sessionId);
    let msgCount: number | null = null;
    let msgTypes: Record<string, number> | null = null;
    if (listed.length) {
      const msgs = await sdk.getSubagentMessages(found.sessionId, listed[0]!);
      msgCount = msgs.length;
      msgTypes = msgs.reduce<Record<string, number>>((acc, m) => {
        const t = (m as Record<string, unknown>).type as string;
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {});
    }
    return {
      found: true,
      created,
      sessionIdPrefix: found.sessionId.slice(0, 8),
      filesOnDisk: found.agents.length,
      listedCount: listed.length,
      firstAgentMessages: msgCount,
      firstAgentTypes: msgTypes,
    };
  });

  // 5. Change detection: fs.watch while an SDK prompt runs
  await step('5-watch', async () => {
    if (!cli) return { skipped: 'no cli' };
    const cwd = join(tmpdir(), `cw-store-watch-${randomUUID().slice(0, 8)}`);
    mkdirSync(cwd, { recursive: true });
    const seen: Array<{ at: number; filename: string }> = [];
    const tStart = Date.now();
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(projectsDir, { recursive: true }, (_e, filename) => {
        seen.push({ at: Date.now() - tStart, filename: filename ?? '' });
      });
    } catch (error) {
      return { watchError: String(error).slice(0, 200) };
    }
    const sessionId = randomUUID();
    const q = sdk.query({
      prompt: 'Reply with the single word pong',
      options: {
        cwd,
        sessionId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        pathToClaudeCodeExecutable: cli,
      },
    });
    let resultMs: number | null = null;
    for await (const m of q) {
      if ((m as Record<string, unknown>).type === 'result') resultMs = Date.now() - tStart;
    }
    await new Promise((r) => setTimeout(r, 1000));
    watcher.close();
    const forSession = seen.filter((e) => e.filename.includes(sessionId));
    rmSync(cwd, { recursive: true, force: true });
    return {
      totalEvents: seen.length,
      eventsForSession: forSession.length,
      firstEventAt: forSession[0]?.at ?? null,
      lastEventAt: forSession[forSession.length - 1]?.at ?? null,
      resultMs,
    };
  });

  // 6. Title precedence: session with both customTitle and aiTitle
  await step('6-title-precedence', async () => {
    for (const w of walk) {
      try {
        const text = readFileSync(w.file, 'utf8');
        if (!text.includes('customTitle') || !text.includes('aiTitle')) continue;
        const info = await sdk.getSessionInfo(w.sessionId);
        const custom = /"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
        const ai = /"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
        if (!custom || !ai) continue;
        const decode = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
        const customV = decode(custom);
        const aiV = decode(ai);
        return {
          found: true,
          summaryIsCustom: info?.summary === customV,
          summaryIsAi: info?.summary === aiV,
          summary: info?.summary ?? null,
        };
      } catch {
        continue;
      }
    }
    return { found: false };
  });

  // 7. firstPrompt/summary sufficiency (history.jsonl not needed?)
  await step('7-sufficiency', async () => {
    const all = await sdk.listSessions({ includeProgrammatic: true });
    return {
      total: all.length,
      withSummary: all.filter((s) => s.summary).length,
      withFirstPrompt: all.filter((s) => s.firstPrompt).length,
      withCwd: all.filter((s) => s.cwd).length,
      withCreatedAt: all.filter((s) => s.createdAt != null).length,
    };
  });

  writeFileSync(logFile, JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${resolve(logFile)}`);
}

void main();
