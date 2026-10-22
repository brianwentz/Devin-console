// Shared "remote side" of the fake wsl.exe (fakeWsl.ts) and the fake ssh.exe
// (fakeSsh.ts): given the argv the remote would run and its linux cwd, it
// emulates exactly the commands hosts.ts / sshHosts.ts issue — the probe line,
// the interactive-login env capture (+ node, + CLI lookups for ssh), the
// byte-gated helper deploy, the helper launch (a REAL piped child running the
// built bundle with HOME/CLAUDE_CONFIG_DIR under the fake root), `curl`, and
// `/usr/bin/env K=V… claude …`. No shell is executed (Windows CI has none):
// every form is recognised and run in JS.
//
//   /bin/sh -c 'echo $HOME;id…'   the probe line → <home>, u, /bin/bash
//                                 (sleeps FAKE_WSL_PROBE_DELAY_MS first)
//   <shell> -ilc 'cmd' [posargs]  __DW_ENV__ capture → canned env -0
//                                 (FAKE_WSL_MARKER=1 when FAKE_WSL_ENV_MARKER),
//                                 then __DW_NODE__ + FAKE_WSL_NODE_VERSION
//                                 (default 22.12.0; NONODE when
//                                 FAKE_WSL_NO_NODE=1); with __DW_CLI__ in the
//                                 command also `claude=`/`devin=`/`gh=` paths
//                                 and `version=` (the ssh probe);
//                                 `command -v <bin>` → canned PATH answers;
//                                 'exec "$0" "$@"'/'exec $argv' → run the argv
//   probe line + HELPER_PRESENT   prints the token when the bundle file named in
//                                 the line exists under <root><home>
//   /bin/sh -c 'mkdir -p "$1" …' sh <dir> <name> <bytes>
//                                 helper deploy: stdin → <root><dir>/<name>;
//                                 a stdin shorter/longer than <bytes> writes
//                                 nothing and exits 1 (the size gate)
//   <shell> -ilc 'test -f "$0" || exit 86; exec node "$0" --stdio' <file>
//                                 helper launch: exit 86 when the mapped file is
//                                 missing, else a piped child
//                                 (FAKE_WSL_NODE ?? this node) running the file
//                                 with HOME and CLAUDE_CONFIG_DIR under <root>,
//                                 the canned env, FAKE_* knobs and
//                                 FAKE_WSL_HELPER=1; stdio piped through
//                                 (drained before the fake exits);
//                                 FAKE_WSL_HELPER_TERMINATE_ONCE=<marker>: while
//                                 the marker file exists, the launch deletes
//                                 it, flips FAKE_WSL_DISTROS_FILE to Stopped
//                                 and exits 1 before hello (`wsl --terminate`
//                                 between spawn and hello);
//                                 FAKE_WSL_HELPER_HANG=1 stops forwarding the
//                                 child's stdout after its first line; node
//                                 runs with `-r fakeWslHelperPreload.cjs` so the
//                                 helper's `…/claude agents` prints
//                                 $FAKE_CLAUDE_AGENTS
//   /usr/bin/printf '%s\n' args…  one arg per line (hosts:probe argv round-trip)
//   curl … %{http_code}           canned: 200 only when FAKE_WSL_HOOKS=ok;
//                                 `realCurl` (ssh): a real GET of the URL
//   */claude …                    --version → a canned string; agents --json
//                                 → $FAKE_CLAUDE_AGENTS; other argv → echo

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STAY_ALIVE = -1; // process keeps running until killed

// The fake claude reports the CLI version the installed SDK targets, so a
// Dependabot SDK bump never turns into a host version-mismatch warning.
const sdkTargetVersion = (): string => {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const manifest = JSON.parse(readFileSync(join(entry, '..', 'manifest.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '2.1.296';
  } catch {
    return '2.1.296';
  }
};

export interface RunnerConfig {
  /** Fake filesystem root: linux `/x/y` lives at `<root>/x/y`. */
  root: string;
  /** The remote user's linux home. */
  home: string;
  /** curl performs a real HTTP GET (ssh: the hook listener is reachable on loopback). */
  realCurl?: boolean;
  /** Called with the KEYS (never values) of env staged by the ssh run scripts. */
  onStagedEnv?: (keys: string[]) => void;
}

export function createRunner(cfg: RunnerConfig) {
  const ROOT = cfg.root;
  const HOME = cfg.home;

  // '/home/u/proj' → <root>/home/u/proj (created if missing).
  const linuxToLocal = (p: string): string => {
    const dir = join(ROOT, ...p.split('/').filter(Boolean));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  // Same mapping without creating anything (file lookups).
  const linuxFile = (p: string): string => join(ROOT, ...p.split('/').filter(Boolean));

  const cannedEnv = (): Record<string, string> => ({
    PATH: `${HOME}/.local/bin:/usr/bin:/bin`,
    HOME,
    USER: 'u',
    SHELL: '/bin/bash',
    SSH_AUTH_SOCK: '/tmp/agent.1',
    ...(process.env.FAKE_WSL_ENV_MARKER === '1' ? { FAKE_WSL_MARKER: '1' } : {}),
  });

  // The helper's env stands in for the remote login env (what env.get
  // returns): the canned env, the Windows basics node needs, the FAKE_* knobs,
  // and FAKE_WSL_HELPER=1 so specs can tell env.get apart from the -ilc
  // capture. Never the whole Windows env — spawn specs replay it as argv.
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
      // The helper preload maps linux paths under this root.
      FAKE_WSL_ROOT: ROOT,
      FAKE_WSL_HELPER: '1',
    };
  };

  // Helper launch: `test -f <file> || exit 86; exec node <file> --stdio` — piped
  // (async) child so the NDJSON channel stays open.
  const helperLaunch = (file: string, cwd: string): number => {
    const local = linuxFile(file);
    if (!existsSync(local)) return 86;
    const terminate = process.env.FAKE_WSL_HELPER_TERMINATE_ONCE;
    const distros = process.env.FAKE_WSL_DISTROS_FILE;
    if (terminate && distros && existsSync(terminate)) {
      rmSync(terminate, { force: true });
      writeFileSync(distros, readFileSync(distros, 'utf8').replace(/:Running/g, ':Stopped'));
      return 1;
    }
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
        return [process.execPath, '-e', `console.log(${JSON.stringify(`${sdkTargetVersion()} (Claude Code)`)})`];
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

  // curl -s -m 2 -o /dev/null -w %{http_code} <url> → reachability probe;
  // `realCurl`: a real GET, printing the status (-w) or the body (the ssh
  // hook-forward challenge `curl -s -m 2 <url>?nonce=…`).
  const curl = (args: string[]): number => {
    const statusOnly = args.some((a) => a.includes('http_code'));
    if (cfg.realCurl) {
      const url = args[args.length - 1] ?? '';
      const script =
        "require('http').get(process.argv[1], (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => " +
        "process.stdout.write(process.argv[2] === '1' ? String(r.statusCode) : b)); })" +
        ".on('error', () => process.stdout.write(process.argv[2] === '1' ? '000' : '')).setTimeout(2000, function () { this.destroy(); });";
      const result = spawnSync(process.execPath, ['-e', script, url, statusOnly ? '1' : '0'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const outText = result.stdout ?? '';
      process.stdout.write(outText);
      return statusOnly ? (outText.trim() === '000' || !outText.trim() ? 7 : 0) : outText ? 0 : 7;
    }
    if (!statusOnly) return 0;
    const ok = process.env.FAKE_WSL_HOOKS === 'ok';
    process.stdout.write(ok ? '200' : '000');
    return ok ? 0 : 7;
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
      const node =
        process.env.FAKE_WSL_NO_NODE === '1' ? 'NONODE' : (process.env.FAKE_WSL_NODE_VERSION ?? '22.12.0');
      process.stdout.write(`\0__DW_ENV__\0${body}\0\0__DW_NODE__\0${node}\n`);
      if (cmd.includes('__DW_CLI__')) {
        const claude = commandV('claude');
        process.stdout.write(
          `\0__DW_CLI__\0claude=${claude ?? ''}\ndevin=${commandV('devin') ?? ''}\ngh=${commandV('gh') ?? ''}\n` +
            `version=${claude ? `${sdkTargetVersion()} (Claude Code)` : ''}\n`,
        );
      }
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

  // One line from stdin, byte by byte (what sh `read` does on a pipe) — the
  // rest of stdin stays for the exec'd CLI.
  const readStdinLine = (): string => {
    const one = Buffer.alloc(1);
    let line = '';
    for (;;) {
      let n = 0;
      try {
        n = readSync(0, one, 0, 1, null);
      } catch {
        break;
      }
      if (n === 0 || one[0] === 10) break;
      line += String.fromCharCode(one[0]!);
    }
    return line;
  };

  // `export K='v'` lines (posixQuote: '…' runs joined by \') → env.
  const parseExportLines = (text: string): Record<string, string> => {
    const env: Record<string, string> = {};
    const re = /export ([A-Za-z_][A-Za-z0-9_]*)=/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let i = re.lastIndex;
      let value = '';
      for (;;) {
        if (text[i] === "'") {
          const end = text.indexOf("'", i + 1);
          value += text.slice(i + 1, end);
          i = end + 1;
        } else if (text[i] === '\\' && text[i + 1] === "'") {
          value += "'";
          i += 2;
        } else break;
      }
      env[m[1]!] = value;
      re.lastIndex = i;
    }
    return env;
  };

  const runStaged = (staged: Record<string, string>, runCwd: string, cmd: string, args: string[]): number => {
    cfg.onStagedEnv?.(Object.keys(staged).sort());
    return runArgv(['/usr/bin/env', ...Object.entries(staged).map(([k, v]) => `${k}=${v}`), cmd, ...args], linuxToLocal(runCwd));
  };

  /** Runs one remote argv (after `wsl.exe -d D [--cd C] -e` / `ssh … -- [cd C &&] exec`). */
  const runArgv = (rest: string[], cwd: string): number => {
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
    // The ssh run scripts (core/execHost SSH_RUN_STDIN_SCRIPT / SSH_RUN_FILE_SCRIPT):
    // `/bin/sh -c <script> <login body> [<envfile>] <cwd> <shell> <cmd> <args…>`.
    if (file === '/bin/sh' && tail[0] === '-c' && (tail[1] ?? '').includes('IFS= read -r e')) {
      const [, , , runCwd, , cmd, ...args] = tail;
      const decoded = Buffer.from(readStdinLine(), 'base64').toString('utf8');
      return runStaged(parseExportLines(decoded), runCwd ?? '/', cmd ?? '', args);
    }
    if (file === '/bin/sh' && tail[0] === '-c' && (tail[1] ?? '').includes('. "$f"')) {
      const [, , , envFile, runCwd, , cmd, ...args] = tail;
      let staged: Record<string, string> = {};
      if (envFile) {
        const local = linuxFile(envFile);
        staged = parseExportLines(readFileSync(local, 'utf8'));
        rmSync(local, { force: true });
      }
      return runStaged(staged, runCwd ?? '/', cmd ?? '', args);
    }
    if (file === '/bin/sh' && tail[0] === '-c' && (tail[1] ?? '').includes('mkdir -p "$1"')) {
      return helperDeploy(tail[3] ?? '', tail[4] ?? '', tail[5]);
    }
    if (/bash|zsh|fish|sh$/.test(file) && tail.some((a) => /^-[a-z]*c$/.test(a))) {
      return shInteractive(tail, cwd);
    }
    if (file.endsWith('curl')) return curl(tail);
    // `/usr/bin/printf '%s\n' args…` — the hosts:probe argv round-trip.
    if (file.endsWith('/printf') && tail[0] === '%s\\n') {
      for (const arg of tail.slice(1)) process.stdout.write(`${arg}\n`);
      return 0;
    }
    return runLocal(realBin(argv), cwd, env);
  };

  return { runArgv, linuxToLocal };
}
