import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstAbsoluteWindowsPath, resolveWindowsSsh, WHERE_SSH_ARGS } from '../../src/main/sshResolve';

// R36 #1: `where.exe ssh.exe` searches the CURRENT DIRECTORY before PATH, so a
// planted ssh.exe in the app's cwd would win. The resolver asks for PATH only
// (`$PATH:ssh.exe`) and runs where.exe from System32.

describe('ssh.exe resolution', () => {
  it('asks where.exe for PATH matches only, from System32, by absolute where.exe path', async () => {
    const calls: { file: string; args: string[]; cwd: string | undefined }[] = [];
    const found = await resolveWindowsSsh({
      systemRoot: 'C:\\Windows',
      exists: () => false,
      exec: async (file, args, cwd) => {
        calls.push({ file, args, cwd });
        return 'C:\\Program Files\\OpenSSH\\ssh.exe\r\nC:\\Windows\\System32\\OpenSSH\\ssh.exe\r\n';
      },
    });
    expect(WHERE_SSH_ARGS).toEqual(['$PATH:ssh.exe']);
    expect(calls).toEqual([
      { file: 'C:\\Windows\\System32\\where.exe', args: ['$PATH:ssh.exe'], cwd: 'C:\\Windows\\System32' },
    ]);
    expect(found).toBe('C:\\Program Files\\OpenSSH\\ssh.exe');
  });

  it('falls back to the inbox client when where.exe finds nothing; null when that is absent too', async () => {
    const fail = async (): Promise<string> => {
      throw new Error('INFO: Could not find files');
    };
    expect(await resolveWindowsSsh({ systemRoot: 'C:\\Windows', exec: fail, exists: () => true })).toBe(
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    );
    expect(await resolveWindowsSsh({ systemRoot: 'C:\\Windows', exec: fail, exists: () => false })).toBeNull();
  });

  it('only absolute drive paths count', () => {
    expect(firstAbsoluteWindowsPath('ssh.exe\r\n.\\ssh.exe\r\nD:\\x\\ssh.exe\r\n')).toBe('D:\\x\\ssh.exe');
    expect(firstAbsoluteWindowsPath('')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('a planted ssh.exe in the cwd is never the answer (real where.exe)', async () => {
    const planted = mkdtempSync(join(tmpdir(), 'ssh-plant-'));
    try {
      writeFileSync(join(planted, 'ssh.exe'), 'MZ');
      // Even when the caller's cwd is the planted dir, the resolver's own cwd and
      // the PATH-only pattern keep it out.
      const found = await resolveWindowsSsh({ cwdForTest: planted });
      expect(found === null || !found.toLowerCase().startsWith(planted.toLowerCase())).toBe(true);
    } finally {
      rmSync(planted, { recursive: true, force: true });
    }
  });
});
