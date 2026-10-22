// Absolute path of the Windows OpenSSH client (P3 M1 / R36 #1). `where.exe
// ssh.exe` searches the CURRENT DIRECTORY before PATH, so a planted ssh.exe in
// the process cwd would win; `where.exe $PATH:ssh.exe` searches PATH only, and
// where.exe itself is started by absolute path with cwd = System32. Fallback:
// the inbox client. No electron import — scripts/hosts-probe.ts uses it too.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** `$PATH:<file>` = search the PATH directories only (never the cwd). */
export const WHERE_SSH_ARGS = ['$PATH:ssh.exe'];

export function firstAbsoluteWindowsPath(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[A-Za-z]:\\/.test(line)) ?? null
  );
}

const run = (file: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolveRun, reject) => {
    execFile(file, args, { cwd, windowsHide: true, timeout: 10_000 }, (error, stdout) =>
      error ? reject(error) : resolveRun(stdout),
    );
  });

export async function resolveWindowsSsh(
  opts: {
    systemRoot?: string;
    exec?: (file: string, args: string[], cwd: string) => Promise<string>;
    exists?: (path: string) => boolean;
    /** Test only: run where.exe from this directory (proves the PATH-only pattern). */
    cwdForTest?: string;
  } = {},
): Promise<string | null> {
  const systemRoot = opts.systemRoot ?? (process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows');
  const system32 = win32.join(systemRoot, 'System32');
  try {
    const stdout = await (opts.exec ?? run)(win32.join(system32, 'where.exe'), WHERE_SSH_ARGS, opts.cwdForTest ?? system32);
    const found = firstAbsoluteWindowsPath(stdout);
    if (found) return found;
  } catch {
    // not on PATH — fall through to the inbox client
  }
  const inbox = win32.join(system32, 'OpenSSH', 'ssh.exe');
  return (opts.exists ?? existsSync)(inbox) ? inbox : null;
}
