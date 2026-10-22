// Fake wsl.exe for hosts e2e (AGENT_WORKSPACE_TEST_WSL_CMD — invoked as
// `node out/fixtures/fakeWsl.cjs`, so argv starts at process.argv[2]).
// Implements just the surface hosts.ts exercises:
//   -l -v / -l -q                 UTF-16LE distro table from FAKE_WSL_DISTROS
//                                 ("Fake:Running:default,Other:Stopped");
//                                 FAKE_WSL_DISTROS_FILE (same syntax, read per
//                                 call) wins when it exists — flips mid-run;
//                                 a spec of `FAIL` makes `-l` hang (timeout),
//                                 `NONE` makes it exit 1 with no output
//   -d D [--cd C] -e argv…        run argv on the fake remote side
//                                 (fakeHostRunner.ts — probe line, env capture,
//                                 deploy, helper launch, curl, claude); linux
//                                 cwd C maps onto FAKE_WSL_ROOT/C (created if
//                                 missing); home FAKE_WSL_HOME (default /home/u)

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRunner, STAY_ALIVE } from './fakeHostRunner';

const runner = createRunner({
  root: process.env.FAKE_WSL_ROOT ?? '.',
  home: process.env.FAKE_WSL_HOME ?? '/home/u',
});

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
    cwd = runner.linuxToLocal(rest[1]);
    rest = rest.slice(2);
  }
  if (rest[0] === '-e') rest = rest.slice(1);
  return runner.runArgv(rest, cwd);
};

const code = main();
if (code !== STAY_ALIVE) process.exit(code);
setInterval(() => undefined, 60_000);
