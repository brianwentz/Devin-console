// Fake ssh.exe for the ssh-host e2e (AGENT_WORKSPACE_TEST_SSH_CMD — invoked as
// `node out/fixtures/fakeSsh.cjs`, argv from process.argv[2]). Test mode only;
// CI never runs a real ssh.
//
// Parses `ssh [options] <alias> -- <remote command string>`: options are
// `-o X`, `-T`, `-t`, `-R spec`, `-p port` (anything else that looks like an
// option is skipped). The ONE remote string is split into words with a small
// POSIX word splitter (the forms core/execHost's sshQuote emits: '…' runs,
// "\\" / "\"" double-quoted escapes, bare words, `&&`), an optional leading
// `cd <dir> &&` sets the cwd (mapped under the fake root), a leading `exec`
// is dropped, and the argv runs on the same fake remote side as the fake
// wsl.exe (fakeHostRunner.ts). No real shell (Windows CI has none) — only the
// command shapes the app issues are understood.
//
// Knobs:
//   FAKE_SSH_ROOT   fake remote fs root (default FAKE_WSL_ROOT, else '.')
//   FAKE_SSH_HOME   remote home (default /home/u)
//   FAKE_SSH_LOG    appends {argv, alias, tty, reverse, remote} per invocation
//   FAKE_SSH_FAIL=1 every connection fails: exit 255 (no output)
//   FAKE_SSH_FAIL_FILE  same while that file exists (network down, then back)
//   FAKE_SSH_HOSTS  comma list of known aliases (default: any) — others exit 255
//   FAKE_SSH_FORWARD_FAIL=1  the `-R` hook forward exits 255 (port squatted)
// The hook forward (any `-R` invocation) stays up until its stdin reaches EOF
// — what the real `exec cat >/dev/null` remote does — then logs
// {forwardEnded: true} and exits 0 (the app dying closes that pipe).
// The ssh run scripts' staged env (stdin line / env file) is decoded and only
// its KEYS are appended to FAKE_SSH_LOG as {stagedEnvKeys}.
// The shared FAKE_WSL_* knobs (NO_NODE, NODE_VERSION, NO_CLAUDE, CLAUDE_CMD,
// HELPER_HANG, …) apply to the ssh remote too. curl does a REAL GET (the
// hook listener is on this machine's loopback, as the -R forward would make it).

import { appendFileSync, existsSync } from 'node:fs';
import { createRunner, STAY_ALIVE } from './fakeHostRunner';

const runner = createRunner({
  root: process.env.FAKE_SSH_ROOT ?? process.env.FAKE_WSL_ROOT ?? '.',
  home: process.env.FAKE_SSH_HOME ?? '/home/u',
  realCurl: true,
  onStagedEnv: (keys) => logLine({ stagedEnvKeys: keys }),
});

function logLine(entry: Record<string, unknown>): void {
  if (!process.env.FAKE_SSH_LOG) return;
  try {
    appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    /* log failure never fails the fake */
  }
}

const OPTION_WITH_VALUE = new Set(['-o', '-R', '-L', '-p', '-i', '-l', '-F', '-J', '-D', '-E', '-S', '-W', '-b', '-c', '-m', '-O', '-Q', '-w', '-B', '-e', '-I']);

/** POSIX-ish word splitter for the remote string (`&&` comes out as its own token). */
function splitRemote(input: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error('unterminated single quote');
      cur += input.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      i++;
      for (; i < input.length && input[i] !== '"'; i++) {
        if (input[i] === '\\' && i + 1 < input.length && '\\"$`'.includes(input[i + 1]!)) i++;
        cur += input[i];
      }
      if (i >= input.length) throw new Error('unterminated double quote');
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else if (c === '&' && input[i + 1] === '&' && !inWord) {
      words.push('&&');
      i++;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[i + 1];
      inWord = true;
      i++;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

const main = (): number => {
  const args = process.argv.slice(2);
  let i = 0;
  let tty = false;
  let reverse: string | null = null;
  let noCommand = false;
  while (i < args.length && args[i]!.startsWith('-') && args[i] !== '--') {
    const opt = args[i]!;
    if (opt === '-t') tty = true;
    if (opt === '-N') noCommand = true;
    if (opt === '-R') reverse = args[i + 1] ?? null;
    i += OPTION_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const alias = args[i] ?? '';
  i++;
  if (args[i] === '--') i++;
  const remote = args.slice(i).join(' ');
  const forward = reverse !== null || noCommand;
  logLine({ argv: args, alias, tty, reverse, forward, remote, pid: process.pid });
  const known = process.env.FAKE_SSH_HOSTS?.split(',').filter(Boolean);
  const failFile = process.env.FAKE_SSH_FAIL_FILE;
  if ((failFile && existsSync(failFile)) || process.env.FAKE_SSH_FAIL === '1' || !alias || (known && !known.includes(alias))) return 255;
  // `-R …` hook forward: the listener is on this machine's loopback already,
  // so the forward is a no-op that stays up until stdin EOF;
  // FAKE_SSH_FORWARD_FAIL=1 is ExitOnForwardFailure on a squatted remote port
  // (exit 255 at once).
  if (forward) {
    if (process.env.FAKE_SSH_FORWARD_FAIL === '1') return 255;
    process.stdin.on('data', () => undefined);
    process.stdin.once('end', () => {
      logLine({ forwardEnded: true, alias });
      process.exit(0);
    });
    process.stdin.once('error', () => process.exit(0));
    return STAY_ALIVE;
  }
  let words = splitRemote(remote);
  let cwd = process.cwd();
  if (words[0] === 'cd' && words[2] === '&&') {
    cwd = runner.linuxToLocal(words[1]!);
    words = words.slice(3);
  }
  if (words[0] === 'exec') words = words.slice(1);
  return runner.runArgv(words, cwd);
};

const code = main();
if (code !== STAY_ALIVE) process.exit(code);
setInterval(() => undefined, 60_000);
