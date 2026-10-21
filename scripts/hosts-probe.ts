// hosts:probe — the exec-hosts §3.9/§0.2 measurements against real WSL:
// enumeration, probe line, env-capture vs plain `wsl.exe -e env`, argv
// round-trip through `-e /usr/bin/printf`, UNC listSessions/stat timings,
// fs.watch over the UNC dir, inotifywait presence, hook reachability
// (127.0.0.1 + vEthernet). Evidence → docs/evidence/hosts-probe.json;
// exit 0 even when wsl.exe or distros are absent (reported in the file).
// Uses only core/execHost.ts — never src/main/** (that pulls Electron state).
//
// `--soak <minutes> [--profile <dir>]` instead launches the BUILT app (out/main.cjs)
// against a throwaway COPY of the profile (default %APPDATA%\agent-workspace; the
// source is never modified, the copy is deleted at the end) with its own event
// log, waits N minutes, closes the app (kill after 15 s) and writes a `soak`
// object into hosts-probe.json: host-exec total/by-kind/per-min (raw and after a
// 60 s startup grace), `excludedLongLived` (kind 'spawn': chats/ptys/acp/inotify),
// background re-lists (claude-list source watch|hosts) per min and usage-scan file counts
// (usage-scan `wslFiles` max; null on builds that do not emit it).
// `--label <name>` (default 'run') writes soak[label] and keeps other labels; the
// reduced log (host-exec/claude-list/usage-scan counts only) is
// docs/evidence/hosts-probe-soak-<label>.jsonl. The app runs with
// AGENT_WORKSPACE_SKIP_HOOKS_INSTALL=1 so the real settings.json files are never written.
// Copying a live leveldb WAL (*.log) while the installed app runs can capture a torn tail, which leveldb tolerates.
// A pre-P0 build does not emit host-exec (its host-exec numbers are 0/absent): compare
// backgroundRelists and usage-scan for the old build.
// AGENT_WORKSPACE_TEST*/FAKE_* env in the caller's environment is passed through
// (used to soak against the fake WSL). Counts only — no payloads are recorded.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reduceEventLog, summarizeSoak } from '../src/core/soak';
import {
  hostIdForPath,
  isWslHost,
  mergeShellEnv,
  parseShellEnv,
  parseWslList,
  wslHost,
  toWindowsPath,
} from '../src/core/execHost';

const TIMEOUT = 10_000;
const ENV_MARKER = '__DW_ENV__';
const out: Record<string, unknown> = {
  at: new Date().toISOString(),
  platform: process.platform,
  note: 'real WSL — no fake (AGENT_WORKSPACE_TEST_WSL_* must not be set)',
};

function wslExists(): boolean {
  if (process.platform !== 'win32') return false;
  const found = spawnSync('where.exe', ['wsl.exe'], { encoding: 'utf8', windowsHide: true });
  return found.status === 0;
}

function runWsl(
  args: string[],
  opts: { requireSuccess?: boolean; timeout?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null; ms: number }> {
  const timeout = opts.timeout ?? TIMEOUT;
  const requireSuccess = opts.requireSuccess ?? true;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (requireSuccess && code !== 0) {
        reject(new Error(`wsl.exe exited ${code}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code,
        ms: Date.now() - t0,
      });
    });
  });
}

function captureEnv(distro: string, shell: string) {
  return runWsl(
    ['-d', distro, '-e', shell, '-ilc', `printf "\\0${ENV_MARKER}\\0"; env -0`],
    { requireSuccess: false },
  ).then((r) => ({ env: parseShellEnv(r.stdout, ENV_MARKER), ms: r.ms }));
}

function firstVethAddr(): string | null {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!name.startsWith('vEthernet (WSL')) continue;
    const v4 = (addrs ?? []).find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

function curl(distro: string, url: string) {
  return runWsl(
    ['-d', distro, '-e', 'curl', '-s', '-m', '2', '-o', '/dev/null', '-w', '%{http_code}', url],
    { requireSuccess: false, timeout: 6_000 },
  ).then((r) => ({ stdout: r.stdout.toString('utf8').trim(), code: r.code, ms: r.ms }));
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SKIP_DIRS = new Set(
  [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Crashpad',
    'Service Worker',
    'blob_storage',
    'Shared Dictionary',
  ].map((n) => n.toLowerCase()),
);
const SKIP_FILE = /^(lock|lockfile|singleton.*|events(\.1)?\.jsonl)$/i;

/** Copies the profile minus Chromium cache/state; per-file EBUSY/EPERM is counted, not fatal. */
function copyProfile(src: string, dest: string, stats: { copied: number; skipped: number }): void {
  mkdirSync(dest, { recursive: true });
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch {
    stats.skipped += 1;
    return;
  }
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      copyProfile(from, to, stats);
    } else if (entry.isFile()) {
      if (SKIP_FILE.test(entry.name)) continue;
      try {
        copyFileSync(from, to);
        stats.copied += 1;
      } catch {
        stats.skipped += 1;
      }
    }
  }
}

function killTree(child: ChildProcess, force: boolean): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
      windowsHide: true,
    });
  } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

async function soak(minutes: number): Promise<void> {
  const customProfile = argValue('--profile');
  const source = resolve(customProfile ?? join(process.env.APPDATA ?? tmpdir(), 'agent-workspace'));
  const label = argValue('--label') ?? 'run';
  const work = mkdtempSync(join(tmpdir(), 'aw-soak-'));
  let child: ChildProcess | null = null;
  try {
    const profile = join(work, 'profile');
    const eventLog = join(work, 'events.jsonl');
    const copy = { copied: 0, skipped: 0 };
    const copyStart = Date.now();
    if (existsSync(source)) copyProfile(source, profile, copy);
    else mkdirSync(profile, { recursive: true });
    const copyMs = Date.now() - copyStart;
    console.log(`soak copy: ${copy.copied} files, ${copy.skipped} skipped, ${copyMs} ms`);
    const electronBin = createRequire(join(process.cwd(), 'package.json'))('electron') as string;
    const startedAt = Date.now();
    child = spawn(electronBin, [process.cwd()], {
      stdio: 'ignore',
      env: {
        ...process.env,
        AGENT_WORKSPACE_USER_DATA: profile,
        AGENT_WORKSPACE_LOG: eventLog,
        // userData is the only thing redirected; never let the soaked app rewrite the real hooks files.
        AGENT_WORKSPACE_SKIP_HOOKS_INSTALL: '1',
      },
    });
    const exited = new Promise<void>((done) => child!.once('exit', () => done()));
    console.log(`soak: ${minutes} min, label ${label}`);
    await Promise.race([new Promise((r) => setTimeout(r, minutes * 60_000)), exited]);
    const text = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
    if (child.exitCode === null) {
      killTree(child, false);
      const timer = setTimeout(() => killTree(child!, true), 15_000);
      await exited;
      clearTimeout(timer);
    }
    const summary = summarizeSoak(text, startedAt, minutes);
    mkdirSync('docs/evidence', { recursive: true });
    const keepLog = join('docs', 'evidence', `hosts-probe-soak-${label.replace(/[^\w.-]/g, '_')}.jsonl`);
    writeFileSync(keepLog, reduceEventLog(text));
    const previous = (out.soak ?? {}) as Record<string, unknown>;
    out.soak = {
      ...previous,
      [label]: {
        ...summary,
        startedAt: new Date(startedAt).toISOString(),
        profile: customProfile ? 'custom' : 'default',
        copy: { ...copy, ms: copyMs },
        reducedLog: keepLog,
        graceNote:
          'post-grace numbers exclude the first 60 s; backgroundRelists = claude-list source watch|hosts',
      },
    };
    finish(true);
  } finally {
    if (child && child.exitCode === null) killTree(child, true);
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const soakMinutes = argValue('--soak');
  if (soakMinutes !== undefined) {
    const n = Number(soakMinutes);
    if (!(n > 0)) throw new Error('--soak needs a positive number of minutes');
    await soak(n);
    return;
  }
  if (!wslExists()) {
    out.wsl = 'absent';
    finish();
    return;
  }
  // --- enumeration ----------------------------------------------------------
  let distros: string[];
  {
    const t0 = Date.now();
    const r = await runWsl(['-l', '-v'], { requireSuccess: false });
    const rows = parseWslList(r.stdout.toString('utf16le'));
    out.enumeration = { ms: Date.now() - t0, rows };
    distros = rows.filter((row) => row.state === 'Running' || row.default).map((row) => row.name);
  }
  if (distros.length === 0) {
    out.wsl = 'no distros';
    finish();
    return;
  }

  const hookServer: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const hookPort = await new Promise<number>((resolvePort) =>
    hookServer.listen(0, '127.0.0.1', () =>
      resolvePort((hookServer.address() as { port: number }).port),
    ),
  );
  const vethAddr = firstVethAddr();
  const vethServer: Server | null = vethAddr
    ? createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      })
    : null;
  if (vethServer && vethAddr) {
    vethServer.on('error', () => undefined);
    await new Promise<void>((done) => vethServer.listen(hookPort, vethAddr, done));
  }

  const hostResults: Record<string, unknown>[] = [];
  for (const name of distros) {
    const entry: Record<string, unknown> = { id: `wsl:${name}`, distro: name };
    try {
      // home/shell probe line
      {
        const t0 = Date.now();
        const r = await runWsl([
          '-d',
          name,
          '-e',
          '/bin/sh',
          '-c',
          'echo "$HOME"; id -un; getent passwd "$(id -un)" | cut -d: -f7',
        ]);
        const [home, , shellLine] = r.stdout.toString('utf8').split('\n').map((l) => l.trim());
        entry.probe = { ms: Date.now() - t0, home, user: 'redacted', shell: shellLine };
      }
      const home = (entry.probe as { home?: string }).home ?? '/root';
      const shell = (entry.probe as { shell?: string }).shell ?? '/bin/sh';
      const host = wslHost(name, home ?? null);
      // env capture vs plain env
      {
        const captured = await captureEnv(name, shell);
        const plain = await runWsl(['-d', name, '-e', 'env']);
        const plainNames = new Set(
          plain.stdout
            .toString('utf8')
            .split('\n')
            .map((l) => l.split('=')[0])
            .filter((k): k is string => Boolean(k)),
        );
        const cap = captured.env ?? {};
        const capNames = new Set(Object.keys(cap));
        entry.envCapture = {
          ms: captured.ms,
          ok: captured.env !== null,
          count: capNames.size,
          addedVsPlain: [...capNames].filter((k) => !plainNames.has(k)).sort(),
          lostVsPlain: [...plainNames].filter((k) => !capNames.has(k)).sort(),
          pathHead: (cap['PATH'] ?? '').split(':').slice(0, 3),
          hasSshAuthSock: 'SSH_AUTH_SOCK' in cap,
        };
        // ssh-add -l under the captured env (exit code only)
        const kv = Object.entries(mergeShellEnv(cap, {})).map(([k, v]) => `${k}=${v}`);
        const ssh = await runWsl(
          ['-d', name, '-e', '/usr/bin/env', ...kv, 'ssh-add', '-l'],
          { requireSuccess: false },
        );
        (entry.envCapture as Record<string, unknown>).sshAddExit = ssh.code;
      }
      // argv round-trip through -e /usr/bin/printf '%s\n'
      {
        const strings = [
          JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'http://127.0.0.1:1/hook/PreToolUse' }] }] } }),
          'two words',
          'a"q',
          '50%',
          'trail\\',
          '$HOME',
          'unicode é',
        ];
        const r = await runWsl([
          '-d',
          name,
          '-e',
          '/usr/bin/printf',
          '%s\\n',
          ...strings,
        ]);
        const lines = r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
        entry.argvRoundTrip = { sent: strings.length, got: lines.length, ok: lines.length === strings.length && strings.every((s, i) => lines[i] === s) };
        if (!(entry.argvRoundTrip as { ok: boolean }).ok) {
          (entry.argvRoundTrip as Record<string, unknown>).mismatch = lines.map((l, i) => ({ i, sent: strings[i], got: l }));
        }
      }
      // UNC listSessions + stat timing
      {
        const unc = toWindowsPath(host, `${home}/.claude`);
        const projects = join(unc, 'projects');
        entry.unc = { exists: existsSync(projects), dir: '<UNC>/.claude/projects' };
        const t0 = Date.now();
        let fileCount = 0;
        const files: { path: string; mtime: number }[] = [];
        try {
          for (const project of readdirSync(projects)) {
            const dir = join(projects, project);
            for (const f of readdirSync(dir)) {
              if (!f.endsWith('.jsonl')) continue;
              const p = join(dir, f);
              try {
                files.push({ path: p, mtime: statSync(p).mtimeMs });
              } catch {
                /* transient */
              }
            }
          }
          fileCount = files.length;
        } catch {
          /* absent */
        }
        const newest = files.sort((a, b) => b.mtime - a.mtime).slice(0, 20);
        const t1 = Date.now();
        let stats = 0;
        for (const f of newest) {
          try {
            statSync(f.path);
            stats += 1;
          } catch {
            /* transient */
          }
        }
        const statMs = Date.now() - t1;
        entry.unc = {
          ...(entry.unc as object),
          listScanMs: Date.now() - t0,
          transcripts: fileCount,
          stat20Ms: statMs,
          stat20Count: stats,
        };
        // listSessions via the SDK against the UNC configDir
        const prevDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = unc;
        const t2 = Date.now();
        try {
          const sdk = await import('@anthropic-ai/claude-agent-sdk');
          const sessions = await sdk.listSessions({ includeProgrammatic: true });
          (entry.unc as Record<string, unknown>).listSessionsMs = Date.now() - t2;
          (entry.unc as Record<string, unknown>).listed = sessions.length;
        } catch (error) {
          (entry.unc as Record<string, unknown>).listSessionsError = String(error).slice(0, 200);
        } finally {
          if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
          else process.env.CLAUDE_CONFIG_DIR = prevDir;
        }
        // fs.watch over the UNC projects dir — expect a failure code
        try {
          await new Promise<void>((resolveP, reject) => {
            const w = watch(projects, { recursive: true }, () => undefined);
            w.on('error', reject);
            setTimeout(() => {
              w.close();
              resolveP();
            }, 500);
          });
          (entry.unc as Record<string, unknown>).watchError = null;
        } catch (error) {
          (entry.unc as Record<string, unknown>).watchError =
            (error as NodeJS.ErrnoException).code ?? String(error).slice(0, 60);
        }
      }
      // inotifywait + curl reachability
      {
        const ino = await runWsl(
          ['-d', name, '-e', shell, '-ilc', 'command -v inotifywait'],
          { requireSuccess: false },
        );
        entry.inotify = ino.code === 0 && ino.stdout.toString('utf8').trim().length > 0;
        const loop = await curl(name, `http://127.0.0.1:${hookPort}/agent-workspace/hook/health`);
        const veth = vethAddr
          ? await curl(name, `http://${vethAddr}:${hookPort}/agent-workspace/hook/health`)
          : null;
        entry.hookReachability = {
          loopback: loop.stdout === '200' ? 'ok' : `unreachable(${loop.stdout})`,
          veth: veth ? (veth.stdout === '200' ? 'ok' : `unreachable(${veth.stdout})`) : 'no-veth',
          vethAddr: vethAddr ? '<vEthernet (WSL)>' : null,
        };
      }
      // path-form selector sanity
      entry.pathSelector = hostIdForPath(`\\\\wsl.localhost\\${name}\\home`);
      entry.isWsl = isWslHost(host);
    } catch (error) {
      entry.error = String(error).slice(0, 200);
    }
    hostResults.push(entry);
    console.log(`probed ${name}`);
  }
  out.hosts = hostResults;
  hookServer.close();
  vethServer?.close();
  finish();
}

function finish(merge = false): void {
  mkdirSync('docs/evidence', { recursive: true });
  const file = join('docs', 'evidence', 'hosts-probe.json');
  let result: Record<string, unknown> = out;
  if (merge && existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      result = { ...prev, soak: { ...((prev.soak ?? {}) as object), ...(out.soak as object) } };
    } catch {
      /* unreadable previous evidence — write fresh */
    }
  }
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
