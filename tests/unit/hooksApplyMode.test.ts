import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyHooksToSettings, secureFileMode, type SettingsFileIo } from '../../src/core/hooksApply';
import { applyHooks } from '../../src/helper/hooks';

// Fix round 1 #2: settings.json carries the hook bearer token — the tmp file
// and the one-time backup are written 0600 (a stricter existing mode wins).

function memIo(files: Record<string, { data: string; mode: number }>) {
  const writes: { path: string; mode: number | undefined }[] = [];
  const copies: { to: string; mode: number | undefined }[] = [];
  const io: SettingsFileIo = {
    exists: async (p) => p in files,
    read: async (p) => files[p]!.data,
    mode: async (p) => files[p]?.mode ?? null,
    write: async (p, data, mode) => {
      writes.push({ path: p, mode });
      files[p] = { data, mode: mode ?? 0o644 };
    },
    rename: async (from, to) => {
      files[to] = files[from]!;
      delete files[from];
    },
    copy: async (from, to, mode) => {
      copies.push({ to, mode });
      files[to] = { data: files[from]!.data, mode: mode ?? 0o644 };
    },
  };
  return { io, writes, copies };
}

describe('hooks settings file mode', () => {
  it('secureFileMode: 0600 by default, never looser than an existing stricter mode', () => {
    expect(secureFileMode(null)).toBe(0o600);
    expect(secureFileMode(0o644)).toBe(0o600);
    expect(secureFileMode(0o400)).toBe(0o400);
    expect(secureFileMode(0o100664)).toBe(0o600);
  });

  it('writes the tmp file and the backup with the secure mode', async () => {
    const { io, writes, copies } = memIo({ '/c/settings.json': { data: '{}\n', mode: 0o644 } });
    const r = await applyHooksToSettings(io, '/c/settings.json', { enabled: true, port: 50001, token: 't' });
    expect(r.error).toBeNull();
    expect(writes).toEqual([{ path: '/c/settings.json.tmp', mode: 0o600 }]);
    expect(copies).toEqual([{ to: '/c/settings.json.agent-workspace.bak', mode: 0o600 }]);
  });

  it('a new settings.json is created 0600', async () => {
    const { io, writes } = memIo({});
    await applyHooksToSettings(io, '/c/settings.json', { enabled: true, port: 50001, token: 't' });
    expect(writes[0]?.mode).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('helper hooks.apply leaves settings.json and the backup 0600 on POSIX', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-mode-'));
    try {
      writeFileSync(join(dir, 'settings.json'), '{}\n');
      chmodSync(join(dir, 'settings.json'), 0o644);
      await applyHooks(dir, { enabled: true, port: 50001, token: 'tok' });
      expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'settings.json.agent-workspace.bak')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
