// hosts:probe — the exec-hosts §3.9/§0.2 measurements against real WSL:
// enumeration, probe line, env-capture vs plain `wsl.exe -e env`, argv
// round-trip through `-e /usr/bin/printf`, UNC listSessions/stat timings,
// fs.watch over the UNC dir, inotifywait presence, hook reachability
// (127.0.0.1 + vEthernet). Evidence → docs/evidence/hosts-probe.json;
// exit 0 even when wsl.exe or distros are absent (reported in the file).
// Uses only core/execHost.ts — never src/main/** (that pulls Electron state).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, watch } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
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

async function main(): Promise<void> {
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

function finish(): void {
  mkdirSync('docs/evidence', { recursive: true });
  const file = join('docs', 'evidence', 'hosts-probe.json');
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}

void main();
