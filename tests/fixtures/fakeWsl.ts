// Fake wsl.exe for hosts e2e (DEVIN_WORKSPACES_TEST_WSL_CMD — invoked as
// `node out/fixtures/fakeWsl.cjs`, so argv starts at process.argv[2]).
// Implements just the surface hosts.ts exercises:
//   -l -v / -l -q                 UTF-16LE distro table from FAKE_WSL_DISTROS
//                                 ("Fake:Running:default,Other:Stopped")
//   -d D [--cd C] -e argv…        run argv locally; linux cwd C maps onto
//                                 FAKE_WSL_ROOT/C (created if missing)
//   /usr/bin/env K=V… cmd         applies the leading assignments
//   /bin/sh -c 'echo $HOME;id…'   the probe line → FAKE_WSL_HOME, u, /bin/bash
//   <shell> -ilc 'cmd' [posargs]  __DW_ENV__ capture → canned env -0
//                                 (FAKE_WSL_MARKER=1 when FAKE_WSL_ENV_MARKER);
//                                 `command -v <bin>` → canned PATH answers;
//                                 'exec "$0" "$@"'/'exec $argv' → run the argv
//   inotifywait …                 exit 127 unless FAKE_WSL_INOTIFY=1 → fs.watch
//   curl … %{http_code}           200 only when FAKE_WSL_HOOKS=ok
//   */claude …                    --version → a canned string; agents --json
//                                 → $FAKE_CLAUDE_AGENTS; other argv → echo

import { spawnSync } from 'node:child_process';
import { mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.FAKE_WSL_ROOT ?? '.';
const HOME = process.env.FAKE_WSL_HOME ?? '/home/u';
const STAY_ALIVE = -1; // process keeps running until killed

// '/home/u/proj' → <FAKE_WSL_ROOT>/home/u/proj (created if missing).
const linuxToLocal = (p: string): string => {
  const dir = join(ROOT, ...p.split('/').filter(Boolean));
  mkdirSync(dir, { recursive: true });
  return dir;
};

const cannedEnv = (): Record<string, string> => ({
  PATH: `${HOME}/.local/bin:/usr/bin:/bin`,
  HOME,
  USER: 'u',
  SHELL: '/bin/bash',
  SSH_AUTH_SOCK: '/tmp/agent.1',
  ...(process.env.FAKE_WSL_ENV_MARKER === '1' ? { FAKE_WSL_MARKER: '1' } : {}),
});

const runLocal = (argv: string[], cwd: string, env: Record<string, string>): number => {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  return result.status ?? 1;
};

// Leading `/usr/bin/env` + K=V pairs → {rest, env}.
const envPrefix = (argv: string[]): { rest: string[]; env: Record<string, string> } => {
  const env: Record<string, string> = {};
  const rest = [...argv];
  if (rest[0]?.replace(/\\/g, '/').endsWith('/usr/bin/env')) rest.shift();
  while (rest[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
    const kv = rest.shift()!;
    env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return { rest, env };
};

// `command -v <bin>` answers from the canned PATH.
const commandV = (bin: string): string | null => {
  switch (bin) {
    case 'claude':
      return process.env.FAKE_WSL_NO_CLAUDE === '1' ? null : `${HOME}/.local/bin/claude`;
    case 'devin':
      return `${HOME}/.local/bin/devin`;
    case 'gh':
      return process.env.FAKE_WSL_NO_GH === '1' ? null : `${HOME}/.local/bin/gh`;
    case 'inotifywait':
      return process.env.FAKE_WSL_INOTIFY === '1' ? '/usr/bin/inotifywait' : null;
    default:
      return null;
  }
};

// A linux PATH `claude`/`devin` maps onto the fixture the e2e installed.
const realBin = (argv: string[]): string[] => {
  const file = argv[0] ?? '';
  if (file.endsWith('/claude')) {
    const cmd = process.env.FAKE_WSL_CLAUDE_CMD;
    if (cmd) return [process.execPath, cmd, ...argv.slice(1)];
    if (argv[1] === '--version') {
      return [process.execPath, '-e', 'console.log("2.1.296 (Claude Code)")'];
    }
    if (argv[1] === 'agents') {
      const json = process.env.FAKE_CLAUDE_AGENTS ?? '[]';
      return [process.execPath, '-e', `console.log(${JSON.stringify(json)})`];
    }
    return [
      process.execPath,
      '-e',
      'console.log("fake claude " + process.argv.slice(1).join(" "))',
      ...argv.slice(1),
    ];
  }
  if (file.endsWith('/devin') && process.env.FAKE_WSL_DEVIN_CMD) {
    return [process.execPath, process.env.FAKE_WSL_DEVIN_CMD, ...argv.slice(1)];
  }
  return argv;
};

// inotifywait -m -r -q -e <events> --format %w%f <dir> — one line per change.
const inotify = (dir: string): number => {
  if (process.env.FAKE_WSL_INOTIFY !== '1') return 127;
  const local = linuxToLocal(dir);
  const watcher = watch(local, { recursive: true }, (_e, f) => {
    if (f) process.stdout.write(`${dir.replace(/\/+$/, '')}/${String(f).split('\\').join('/')}\n`);
  });
  process.on('SIGTERM', () => watcher.close());
  return STAY_ALIVE;
};

// curl -s -m 2 -o /dev/null -w %{http_code} <url> → reachability probe.
const curl = (args: string[]): number => {
  if (args.some((a) => a.includes('http_code'))) {
    const ok = process.env.FAKE_WSL_HOOKS === 'ok';
    process.stdout.write(ok ? '200' : '000');
    return ok ? 0 : 7;
  }
  return 0;
};

// `<shell> -ilc 'cmd' [posargs…]` — the interactive-login invocations.
const shInteractive = (tail: string[], cwd: string): number => {
  const cIdx = tail.findIndex((a) => /^-[a-z]*c$/.test(a));
  const cmd = cIdx === -1 ? '' : (tail[cIdx + 1] ?? '');
  const posargs = cIdx === -1 ? tail : tail.slice(cIdx + 2);

  if (cmd.includes('__DW_ENV__')) {
    const body = Object.entries(cannedEnv())
      .map(([k, v]) => `${k}=${v}`)
      .join('\0');
    process.stdout.write(`\0__DW_ENV__\0${body}\0`);
    return 0;
  }
  if (cmd.includes('command -v')) {
    let ok = true;
    for (const m of cmd.matchAll(/command -v ([A-Za-z0-9_-]+)/g)) {
      const path = commandV(m[1]!);
      if (path) process.stdout.write(`${path}\n`);
      else ok = false;
    }
    return ok ? 0 : 1;
  }
  if (cmd.startsWith('exec ')) {
    const { rest, env } = envPrefix(posargs);
    if (rest[0]?.endsWith('inotifywait')) return inotify(rest[rest.length - 1]!);
    return runLocal(realBin(rest), cwd, env);
  }
  // Fallback: run the command string verbatim (argv form never used today).
  return runLocal([cmd, ...posargs], cwd, {});
};

const listV = (): number => {
  const spec = process.env.FAKE_WSL_DISTROS ?? '';
  const rows = spec
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [name, state, flag] = entry.split(':');
      return `${flag === 'default' ? '*' : ' '} ${name!.padEnd(18)}${(state ?? 'Running').padEnd(16)}2`;
    });
  const text = `  ${'NAME'.padEnd(18)}${'STATE'.padEnd(16)}VERSION\n${rows.join('\n')}\n`;
  process.stdout.write(Buffer.from(text, 'utf16le'));
  return 0;
};

const listQ = (): number => {
  const names = (process.env.FAKE_WSL_DISTROS ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => entry.split(':')[0]!);
  process.stdout.write(Buffer.from(`${names.join('\r\n')}\r\n`, 'utf16le'));
  return 0;
};

const main = (): number => {
  const args = process.argv.slice(2);
  if (args[0] === '-l' || args[0] === '--list') {
    return args.includes('-v') ? listV() : listQ();
  }
  if (args[0] !== '-d') return 1;
  let rest = args.slice(2);
  let cwd = process.cwd();
  while (rest[0] === '--cd' && rest[1]) {
    cwd = linuxToLocal(rest[1]);
    rest = rest.slice(2);
  }
  if (rest[0] === '-e') rest = rest.slice(1);
  if (!rest.length) return 1;

  const { rest: argv, env } = envPrefix(rest);
  const file = (argv[0] ?? '').replace(/\\/g, '/');
  const tail = argv.slice(1);

  // Probe line: /bin/sh -c 'echo "$HOME"; id -un; getent … | cut -d: -f7'
  if (file === '/bin/sh' && tail[0] === '-c' && (tail[1] ?? '').includes('id -un')) {
    process.stdout.write(`${HOME}\nu\n/bin/bash\n`);
    return 0;
  }
  if (/bash|zsh|fish|sh$/.test(file) && tail.some((a) => /^-[a-z]*c$/.test(a))) {
    return shInteractive(tail, cwd);
  }
  if (file.endsWith('inotifywait')) return inotify(argv[argv.length - 1]!);
  if (file.endsWith('curl')) return curl(tail);
  return runLocal(realBin(argv), cwd, env);
};

const code = main();
if (code !== STAY_ALIVE) process.exit(code);
setInterval(() => undefined, 60_000);
