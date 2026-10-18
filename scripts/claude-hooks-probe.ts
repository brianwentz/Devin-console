// Spike B (plan §5): hooks transport — a loopback http.createServer receives
// lifecycle events from `claude` processes we did not start via the SDK.
// Evidence: docs/evidence/claude-hooks-probe-<ts>.jsonl — every received event becomes
// a line { event, session_id, cwd, notification_type?, ms }; no message text.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { resolveClaudePath } from '../src/main/claude/claudePath';

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = join('docs', 'evidence', `claude-hooks-probe-${ts}.jsonl`);
mkdirSync(join('docs', 'evidence'), { recursive: true });
const t0 = Date.now();

function record(step: string, ok: boolean, detail: unknown): void {
  appendFileSync(logFile, JSON.stringify({ step, ok, ms: Date.now() - t0, detail }) + '\n');
  console.log(`${ok ? 'OK ' : 'ERR'} ${step} (+${Date.now() - t0}ms)`, JSON.stringify(detail));
}

const token = randomUUID();
const events: Array<Record<string, unknown> & { _at: number }> = [];
let port = 0;

function hookUrl(event: string): string {
  return `http://127.0.0.1:${port}/hook/${event}`;
}

function settingsJson(events_: string[], urlFor: (e: string) => string): string {
  const hooks: Record<string, unknown> = {};
  for (const event of events_) {
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: 'http',
          url: urlFor(event),
          headers: { Authorization: 'Bearer $DEVIN_WORKSPACES_HOOK_TOKEN' },
          allowedEnvVars: ['DEVIN_WORKSPACES_HOOK_TOKEN'],
          timeout: 5,
        },
      ],
    };
    if (event === 'PostToolUse') entry.if = 'Bash(gh pr *)';
    hooks[event] = [entry];
  }
  return JSON.stringify({ hooks });
}

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'PostToolUse',
] as const;

function waitForEvent(predicate: (e: Record<string, unknown>) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveP) => {
    const check = () => {
      if (events.some(predicate)) return resolveP(true);
      if (Date.now() > deadline) return resolveP(false);
      setTimeout(check, 200);
    };
    check();
  });
}

// eslint-disable-next-line no-control-regex -- strips ANSI escapes (ESC / BEL are the point)
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

// Spawn `claude` interactively in `cwd`, answer the folder-trust picker
// (arrow down to "Yes, I trust this folder", Enter) and exit. Returns
// whether the dialog was seen+answered.
async function trustDirForTest(cli: string, cwd: string, env: Record<string, string>): Promise<boolean> {
  const proc = pty.spawn(cli, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env,
  });
  let raw = '';
  let answered = false;
  proc.onData((data) => {
    raw += data;
    const flat = raw.replace(ANSI_RE, ' ');
    // Wait for the whole picker (incl. "Enter to confirm") before answering —
    // the default is "No, exit", so a premature Enter kills the process.
    if (!answered && /trust this folder/i.test(flat) && /Enter to confirm/i.test(flat)) {
      answered = true;
      // Let the picker finish rendering before keys — the default is
      // "No, exit"; too-early input can confirm it.
      setTimeout(() => proc.write('\x1b[B'), 1500);
      setTimeout(() => proc.write('\r'), 2500);
    }
  });
  const deadline = Date.now() + 30_000;
  while (!answered && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 5000));
  try { proc.kill(); } catch { /* already gone */ }
  return answered;
}

async function main(): Promise<void> {
  const sdkPkg = JSON.parse(
    readFileSync(join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'),
  ) as { version: string };
  const manifest = JSON.parse(
    readFileSync(join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'manifest.json'), 'utf8'),
  ) as { version: string };

  const server: Server = createServer((request, response) => {
    const match = /^\/hook\/([A-Za-z]+)$/.exec(request.url ?? '');
    const auth = request.headers.authorization;
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      if (!match || auth !== `Bearer ${token}`) {
        record('event-rejected', false, { url: request.url, authOk: auth === `Bearer ${token}` });
        return;
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = { _unparsed: body.length };
      }
      const entry = {
        event: match[1],
        hook_event_name: parsed.hook_event_name,
        session_id: parsed.session_id,
        cwd: parsed.cwd,
        notification_type: parsed.notification_type,
        tool_name: parsed.tool_name,
        _at: Date.now() - t0,
      };
      events.push(entry);
      record('event', true, entry);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;

  const cli = resolveClaudePath(null);
  if (!cli) {
    record('0-resolve', false, { error: 'claude not found on PATH' });
    server.close();
    return;
  }
  const cliVersion = spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim();
  record('header', true, {
    sdkVersion: sdkPkg.version,
    manifestCliVersion: manifest.version,
    cliVersion,
    port,
    nodeVersion: process.version,
  });

  const env = { ...process.env, DEVIN_WORKSPACES_HOOK_TOKEN: token };

  // Part 1: headless `claude -p "say hi" --settings <json>`
  await (async () => {
    const cwd = join(tmpdir(), `cw-hooks-headless-${randomUUID().slice(0, 8)}`);
    mkdirSync(cwd, { recursive: true });
    const settings = settingsJson([...HOOK_EVENTS], hookUrl);
    const t1 = Date.now();
    const child = spawnSync(cli, ['-p', 'say hi', '--settings', settings], {
      encoding: 'utf8',
      cwd,
      env,
      timeout: 120_000,
    });
    const spawnResult = {
      exit: child.status,
      stderrLen: child.stderr?.length ?? 0,
      stderrHead: (child.stderr ?? '').slice(0, 300),
      stdoutLen: child.stdout?.length ?? 0,
      ms: Date.now() - t1,
    };
    // Grace for any last hooks in flight.
    await new Promise((r) => setTimeout(r, 3000));
    const received = events.map((e) => e.event);
    record('1-headless', child.status === 0, {
      spawn: spawnResult,
      eventsReceived: received,
      gotSessionStart: received.includes('SessionStart'),
      gotUserPromptSubmit: received.includes('UserPromptSubmit'),
      gotStop: received.includes('Stop'),
      gotSessionEnd: received.includes('SessionEnd'),
    });
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* child still exiting */ }
  })();

  // Part 2: interactive run via node-pty — permission_prompt + idle_prompt
  await (async () => {
    const cwd = join(tmpdir(), `cw-hooks-pty-${randomUUID().slice(0, 8)}`);
    mkdirSync(cwd, { recursive: true });
    const settings = settingsJson([...HOOK_EVENTS], hookUrl);
    const before = events.length;
    // --permission-mode default forces an ask prompt for Write — the user's
    // default 'auto' mode would auto-approve it and no permission_prompt /
    // PermissionRequest would ever fire.
    const proc = pty.spawn(cli, ['--settings', settings, '--permission-mode', 'default'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: env as Record<string, string>,
    });
    let outputLen = 0;
    let trustAnswered = false;
    let raw = '';
    proc.onData((data) => {
      outputLen += data.length;
      raw += data;
      // First run in a fresh cwd shows the folder-trust picker; the UI writes
      // words with cursor-move escapes between them, so flatten ANSI to
      // spaces before matching. Default is "No, exit" — arrow down to
      // "Yes, I trust this folder" then Enter.
      const flat = raw.replace(ANSI_RE, ' ');
      if (!trustAnswered && /trust this folder/i.test(flat) && /Enter to confirm/i.test(flat)) {
        trustAnswered = true;
        setTimeout(() => proc.write('\x1b[B'), 1500);
        setTimeout(() => proc.write('\r'), 2500);
      }
    });
    // Wait for the trust picker to be answered (or absent) then for the
    // main prompt UI ("Try \"…\"" placeholder / "? for shortcuts").
    for (let i = 0; i < 120; i += 1) {
      const flat = raw.replace(ANSI_RE, ' ');
      if (/Try "|for shortcuts|auto mode|shift\+tab/i.test(flat)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 3000));
    proc.write('create a file named probe2.txt containing hi\r');
    const gotPermission = await waitForEvent(
      (e) => (e.event === 'Notification' && e.notification_type === 'permission_prompt') || e.event === 'PermissionRequest',
      30_000,
    );
    // idle_prompt needs ~60s of user inactivity; cap at 90s total.
    const gotIdle = await waitForEvent(
      (e) => e.event === 'Notification' && e.notification_type === 'idle_prompt',
      90_000,
    );
    proc.write('\x03'); // Ctrl+C — dismiss / interrupt
    await new Promise((r) => setTimeout(r, 2000));
    proc.write('exit\r');
    await new Promise((r) => setTimeout(r, 2000));
    try { proc.kill(); } catch { /* already gone */ }
    const received = events.slice(before).map((e) => `${e.event}${e.notification_type ? ':' + String(e.notification_type) : ''}`);
    record('2-interactive', gotPermission, {
      outputLen,
      trustAnswered,
      gotPermissionPrompt: gotPermission,
      gotIdlePrompt: gotIdle,
      eventsReceived: received,
    });
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* child still exiting */ }
  })();

  // Part 3: unreachable hook URL does not break the CLI
  await (async () => {
    const cwd = join(tmpdir(), `cw-hooks-dead-${randomUUID().slice(0, 8)}`);
    mkdirSync(cwd, { recursive: true });
    const settings = settingsJson(['SessionStart', 'SessionEnd'], (e) => `http://127.0.0.1:9/hook/${e}`);
    const t1 = Date.now();
    const child = spawnSync(cli, ['-p', 'say hi', '--settings', settings], {
      encoding: 'utf8',
      cwd,
      env,
      timeout: 120_000,
    });
    record('3-unreachable', child.status === 0, {
      exit: child.status,
      stderrLen: child.stderr?.length ?? 0,
      stdoutLen: child.stdout?.length ?? 0,
      ms: Date.now() - t1,
    });
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* child still exiting */ }
  })();

  // Part 4: precedence — project .claude/settings.json command hook AND our
  // --settings http hook: both must fire (§8 hooks concatenate).
  await (async () => {
    const cwd = join(tmpdir(), `cw-hooks-prec-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const marker = join(cwd, 'proj-hook.txt');
    // Project settings are only loaded for trusted folders — grant trust to
    // this temp dir via a short interactive run first (same flow the user
    // would confirm once per folder).
    const trusted = await trustDirForTest(cli, cwd, env as Record<string, string>);
    // Stop fires in headless -p mode; SessionStart does not (see part 1).
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'cmd.exe /c echo fired> proj-hook.txt' }],
            },
          ],
        },
      }),
    );
    const before = events.length;
    const settings = settingsJson(['Stop', 'SessionEnd'], hookUrl);
    const child = spawnSync(cli, ['-p', 'say hi', '--settings', settings], {
      encoding: 'utf8',
      cwd,
      env,
      timeout: 120_000,
    });
    await new Promise((r) => setTimeout(r, 2000));
    record('4-precedence', child.status === 0 && existsSync(marker), {
      exit: child.status,
      trustDialogAnswered: trusted,
      projectHookFired: existsSync(marker),
      httpHookFired: events.slice(before).some((e) => e.event === 'Stop'),
    });
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* child still exiting */ }
  })();

  server.close();
}

void main();
