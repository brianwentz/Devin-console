// Fake wsl.exe for hosts e2e (AGENT_WORKSPACE_TEST_WSL_CMD — invoked as
// `node out/fixtures/fakeWsl.cjs`, so argv starts at process.argv[2]).
// Implements just the surface hosts.ts exercises:
//   -l -v / -l -q                 UTF-16LE distro table from FAKE_WSL_DISTROS
//                                 ("Fake:Running:default,Other:Stopped");
//                                 FAKE_WSL_DISTROS_FILE (same syntax, read per
//                                 call) wins when it exists — flips mid-run;
//                                 a spec of `FAIL` makes `-l` hang (timeout),
//                                 `NONE` makes it exit 1 with no output
//   -d D [--cd C] -e argv…        run argv locally; linux cwd C maps onto
//                                 FAKE_WSL_ROOT/C (created if missing)
//   /usr/bin/env K=V… cmd         applies the leading assignments
//   /bin/sh -c 'echo $HOME;id…'   the probe line → FAKE_WSL_HOME, u, /bin/bash
//                                 (sleeps FAKE_WSL_PROBE_DELAY_MS first)
//   <shell> -ilc 'cmd' [posargs]  __DW_ENV__ capture → canned env -0
//                                 (FAKE_WSL_MARKER=1 when FAKE_WSL_ENV_MARKER),
//                                 then __DW_NODE__ + FAKE_WSL_NODE_VERSION
//                                 (default 22.12.0; NONODE when
//                                 FAKE_WSL_NO_NODE=1);
//                                 `command -v <bin>` → canned PATH answers;
//                                 'exec "$0" "$@"'/'exec $argv' → run the argv
//   probe line + HELPER_PRESENT   prints the token when the bundle file named in
//                                 the line exists under FAKE_WSL_ROOT<home>
//   /bin/sh -c 'mkdir -p "$1" …' sh <dir> <name> <bytes>
//                                 helper deploy: stdin → <ROOT><dir>/<name>;
//                                 a stdin shorter/longer than <bytes> writes
//                                 nothing and exits 1 (the size gate)
//   <shell> -ilc 'test -f "$0" || exit 86; exec node "$0" --stdio' <file>
//                                 helper launch: exit 86 when the mapped file is
//                                 missing, else a piped child
//                                 (FAKE_WSL_NODE ?? this node) running the file
//                                 with HOME and CLAUDE_CONFIG_DIR under
//                                 FAKE_WSL_ROOT, the canned env, FAKE_* knobs
//                                 and FAKE_WSL_HELPER=1; stdio piped through
//                                 (drained before the fake exits);
//                                 FAKE_WSL_HELPER_HANG=1 stops forwarding the
//                                 child's stdout after its first line; node
//                                 runs with `-r fakeWslHelperPreload.cjs` so the
//                                 helper's `…/claude agents` prints
//                                 $FAKE_CLAUDE_AGENTS
//   curl … %{http_code}           200 only when FAKE_WSL_HOOKS=ok
//   */claude …                    --version → a canned string; agents --json
//                                 → $FAKE_CLAUDE_AGENTS; other argv → echo

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.env.FAKE_WSL_ROOT ?? '.';
const HOME = process.env.FAKE_WSL_HOME ?? '/home/u';
const STAY_ALIVE = -1; // process keeps running until killed

// '/home/u/proj' → <FAKE_WSL_ROOT>/home/u/proj (created if missing).
const linuxToLocal = (p: string): string => {
  const dir = join(ROOT, ...p.split('/').filter(Boolean));
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Same mapping without creating anything (file lookups).
const linuxFile = (p: string): string => join(ROOT, ...p.split('/').filter(Boolean));

// Helper launch: `test -f <file> || exit 86; exec node <file> --stdio` — piped
// (async) child so the NDJSON channel stays open.
// The helper's env stands in for the distro's login env (what env.get
// returns): the canned env, the Windows basics node needs, the FAKE_* knobs,
// and FAKE_WSL_HELPER=1 so specs can tell env.get apart from the -ilc capture.
// Never the whole Windows env — spawnSpec replays it as argv.
const WIN_BASICS = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC', 'USERPROFILE']);
const helperEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (WIN_BASICS.has(key.toUpperCase()) || key.startsWith('FAKE_'))) env[key] = value;
  }
  const { PATH: _linuxPath, ...canned } = cannedEnv();
  return {
    ...env,
    ...canned,
    HOME: linuxFile(HOME),
    CLAUDE_CONFIG_DIR: linuxFile(`${HOME}/.claude`),
    FAKE_WSL_HELPER: '1',
  };
};

const helperLaunch = (file: string, cwd: string): number => {
  const local = linuxFile(file);
  if (!existsSync(local)) return 86;
  // The preload sits next to this bundle in out/fixtures.
  const preload = join(__dirname, 'fakeWslHelperPreload.cjs');
  const child = spawn(process.env.FAKE_WSL_NODE ?? process.execPath, ['-r', preload, local, '--stdio'], {
    cwd,
    env: helperEnv(),
    stdio: 'pipe',
    windowsHide: true,
  });
  let forwarding = true;
  child.stdout.on('data', (chunk: Buffer) => {
    if (!forwarding) return;
    if (process.env.FAKE_WSL_HELPER_HANG === '1') {
      const nl = chunk.indexOf(10);
      if (nl !== -1) {
        forwarding = false;
        process.stdout.write(chunk.subarray(0, nl + 1));
        return;
      }
    }
    process.stdout.write(chunk);
  });
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => undefined);
  // A nonexistent FAKE_WSL_NODE: the launch dies like `exec` of a missing binary.
  child.once('error', () => process.stdout.write('', () => process.exit(127)));
  // 'close' fires after the child's stdout is fully read; then let our own
  // stdout drain (async pipes on Windows) so trailing frames aren't dropped.
  child.once('close', (code) => process.stdout.write('', () => process.exit(code ?? 1)));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  return STAY_ALIVE;
};

// One-shot helper mode (`… exec node "$0" --apply-hooks-off`): runs to
// completion with the helper env, stderr passed through, exit code returned.
const helperOnce = (file: string, mode: string, cwd: string): number => {
  const local = linuxFile(file);
  if (!existsSync(local)) return 86;
  const result = spawnSync(process.env.FAKE_WSL_NODE ?? process.execPath, [local, mode], {
    cwd,
    env: helperEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  return result.status ?? 1;
};

// Helper deploy: `mkdir -p "$1" && cat > tmp && test <size> -eq "$3" && mv … "$1/$2"`
// with the bundle on stdin; a size mismatch leaves no file and exits 1.
const helperDeploy = (dir: string, name: string, bytes: string | undefined): number => {
  const target = join(linuxToLocal(dir), name);
  mkdirSync(dirname(target), { recursive: true });
  const data = readFileSync(0);
  if (bytes === undefined || data.length !== Number(bytes)) return 1;
  writeFileSync(target, data);
  return 0;
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

  if (cmd.startsWith('test -f ') && cmd.includes('exit 86;')) {
    const mode = /exec node "?\$(?:0|argv)"? (--[a-z-]+)$/.exec(cmd)?.[1] ?? '--stdio';
    if (mode !== '--stdio') return helperOnce(posargs[0] ?? '', mode, cwd);
    return helperLaunch(posargs[0] ?? '', cwd);
  }
  if (cmd.includes('__DW_ENV__')) {
    const body = Object.entries(cannedEnv())
      .map(([k, v]) => `${k}=${v}`)
      .join('\0');
    const node = process.env.FAKE_WSL_NO_NODE === '1' ? 'NONODE' : (process.env.FAKE_WSL_NODE_VERSION ?? '22.12.0');
    process.stdout.write(`\0__DW_ENV__\0${body}\0\0__DW_NODE__\0${node}\n`);
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
    return runLocal(realBin(rest), cwd, env);
  }
  // Fallback: run the command string verbatim (argv form never used today).
  return runLocal([cmd, ...posargs], cwd, {});
};

const distroSpec = (): string => {
  const file = process.env.FAKE_WSL_DISTROS_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return process.env.FAKE_WSL_DISTROS ?? '';
};

const listV = (): number => {
  const spec = distroSpec();
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
  const names = distroSpec()
    .split(',')
    .filter(Boolean)
    .map((entry) => entry.split(':')[0]!);
  process.stdout.write(Buffer.from(`${names.join('\r\n')}\r\n`, 'utf16le'));
  return 0;
};

const main = (): number => {
  const args = process.argv.slice(2);
  if (args[0] === '-l' || args[0] === '--list') {
    // `FAIL`: a wedged VM — `wsl -l` hangs until the caller's timeout kills it.
    // `NONE`: no distros installed / no WSL feature — exits 1 at once, no rows.
    const spec = distroSpec();
    if (spec === 'FAIL') return STAY_ALIVE;
    if (spec === 'NONE') return 1;
    return args.includes('-v') ? listV() : listQ();
  }
  if (args[0] !== '-d') return 1;
  let rest = args.slice(2);
  // FAKE_WSL_SPAWN_LOG records every -d invocation: the full argv plus the
  // linux --cd value the caller asked for (specs assert on it).
  const linuxCwdIdx = rest.findIndex((a, i) => a === '--cd' && rest[i + 1]);
  const linuxCwd = linuxCwdIdx === -1 ? null : rest[linuxCwdIdx + 1]!;
  if (process.env.FAKE_WSL_SPAWN_LOG) {
    try {
      appendFileSync(
        process.env.FAKE_WSL_SPAWN_LOG,
        `${JSON.stringify({ argv: args, cwd: linuxCwd })}
`,
      );
    } catch {
      /* log failure never fails the fake */
    }
  }
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
    // A wedged distro answers the probe late — block this thread so startup
    // fs gating is exercised while the probe is still 'probing'.
    const delay = Number(process.env.FAKE_WSL_PROBE_DELAY_MS) || 0;
    if (delay > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
    // `test -f "$HOME/…"` or a quoted resolved home `test -f '/srv/h/…'`.
    const m = /test -f (?:"([^"]*)"|'([^']*)')/.exec(tail[1] ?? '');
    const checked = (m?.[1] ?? m?.[2])?.replace(/^\$HOME/, HOME);
    const present = checked !== undefined && existsSync(linuxFile(checked));
    process.stdout.write(`${HOME}\nu\n/bin/bash\n${present ? 'HELPER_PRESENT\n' : ''}`);
    return 0;
  }
  if (file === '/bin/sh' && tail[0] === '-c' && (tail[1] ?? '').includes('mkdir -p "$1"')) {
    return helperDeploy(tail[3] ?? '', tail[4] ?? '', tail[5]);
  }
  if (/bash|zsh|fish|sh$/.test(file) && tail.some((a) => /^-[a-z]*c$/.test(a))) {
    return shInteractive(tail, cwd);
  }
  if (file.endsWith('curl')) return curl(tail);
  return runLocal(realBin(argv), cwd, env);
};

const code = main();
if (code !== STAY_ALIVE) process.exit(code);
setInterval(() => undefined, 60_000);
