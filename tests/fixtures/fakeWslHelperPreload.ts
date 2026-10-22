// `node -r` preload for the helper the fake wsl.exe launches (built to
// out/fixtures/fakeWslHelperPreload.cjs). The helper runs on Windows node in
// the e2e, so the probed linux `…/claude` path from `agents.list` cannot be
// exec'd — this maps it the way fakeWsl.ts realBin() does for wsl.exe runs:
// `agents …` prints $FAKE_CLAUDE_AGENTS (default `[]`). Nothing of this
// ships; the real helper's execFile is untouched outside the fake.

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const original = childProcess.execFile;

const patched = function (this: unknown, file: string, ...rest: unknown[]) {
  if (typeof file === 'string' && file.replace(/\\/g, '/').endsWith('/claude')) {
    const args = Array.isArray(rest[0]) ? (rest.shift() as string[]) : [];
    const script =
      args[0] === 'agents'
        ? `process.stdout.write(${JSON.stringify(process.env.FAKE_CLAUDE_AGENTS ?? '[]')})`
        : `process.stdout.write("fake claude " + ${JSON.stringify(args.join(' '))})`;
    return (original as (...a: unknown[]) => unknown).call(this, process.execPath, ['-e', script], ...rest);
  }
  return (original as (...a: unknown[]) => unknown).call(this, file, ...rest);
} as unknown as typeof childProcess.execFile;

childProcess.execFile = patched;
// The helper is ESM: its `import { execFile } from 'node:child_process'`
// binding follows the CJS export only after a sync.
syncBuiltinESMExports();
