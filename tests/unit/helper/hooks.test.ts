import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHooks } from '../../../src/helper/hooks';
import { isOurHook } from '../../../src/core/claudeHooks';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helper-hooks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FOREIGN = { type: 'command', command: 'echo foreign' };
const ORIGINAL = `${JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [FOREIGN] }] } }, null, 2)}\n`;
const settingsFile = (): string => join(dir, 'settings.json');
const backupFile = (): string => `${settingsFile()}.agent-workspace.bak`;
const read = (): any => JSON.parse(readFileSync(settingsFile(), 'utf8'));
const ourCount = (s: any): number =>
  Object.values((s.hooks ?? {}) as Record<string, Array<{ hooks: unknown[] }>>)
    .flat()
    .flatMap((g) => g.hooks)
    .filter((h) => isOurHook(h)).length;

describe('helper hooks.apply', () => {
  it('hooks.apply is idempotent, backs up once, off removes only ours', async () => {
    writeFileSync(settingsFile(), ORIGINAL);
    const on = { enabled: true, port: 50001, token: 'tok-1' };

    expect(await applyHooks(dir, on)).toEqual({ installed: true, changed: true, error: null });
    expect(readFileSync(backupFile(), 'utf8')).toBe(ORIGINAL);
    const installed = read();
    expect(installed.model).toBe('opus');
    expect(ourCount(installed)).toBeGreaterThan(0);
    expect(JSON.stringify(installed)).toContain('echo foreign');

    // Same block again → nothing written.
    const before = readFileSync(settingsFile(), 'utf8');
    expect(await applyHooks(dir, on)).toEqual({ installed: true, changed: false, error: null });
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before);

    // A new port rewrites the block but never re-takes the backup.
    expect(await applyHooks(dir, { ...on, port: 50002, addr: '172.20.0.1' })).toEqual({
      installed: true,
      changed: true,
      error: null,
    });
    expect(readFileSync(settingsFile(), 'utf8')).toContain('172.20.0.1:50002');
    expect(readFileSync(backupFile(), 'utf8')).toBe(ORIGINAL);

    // Off removes exactly ours; foreign hooks and other keys survive.
    expect(await applyHooks(dir, { enabled: false, port: 50002, token: 'tok-1' })).toEqual({
      installed: false,
      changed: true,
      error: null,
    });
    expect(read()).toEqual(JSON.parse(ORIGINAL));
    expect(await applyHooks(dir, { enabled: false, port: 50002, token: 'tok-1' })).toEqual({
      installed: false,
      changed: false,
      error: null,
    });
    expect(existsSync(`${settingsFile()}.tmp`)).toBe(false);
  });

  it('creates settings.json when absent (no backup of a missing file)', async () => {
    expect(await applyHooks(dir, { enabled: true, port: 50001, token: 't' })).toMatchObject({ changed: true });
    expect(ourCount(read())).toBeGreaterThan(0);
    expect(existsSync(backupFile())).toBe(false);
  });

  it('unparseable settings → no write, error without content or path', async () => {
    const junk = '{ "secret-value": ';
    writeFileSync(settingsFile(), junk);
    const r = await applyHooks(dir, { enabled: true, port: 50001, token: 't' });
    expect(r.installed).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
    expect(r.error).not.toContain('secret-value');
    expect(r.error).not.toContain(dir);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(junk);
    expect(existsSync(backupFile())).toBe(false);
  });

  it('migrates the pre-rename one-time backup instead of taking a second one', async () => {
    writeFileSync(settingsFile(), ORIGINAL);
    writeFileSync(`${settingsFile()}.devin-workspaces.bak`, 'legacy');
    await applyHooks(dir, { enabled: true, port: 50001, token: 't' });
    expect(readFileSync(backupFile(), 'utf8')).toBe('legacy');
    expect(existsSync(`${settingsFile()}.devin-workspaces.bak`)).toBe(false);
  });
});
