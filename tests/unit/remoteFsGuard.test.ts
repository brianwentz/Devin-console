import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installRemoteFsGuard,
  isRemoteFsPath,
  RemoteFsViolation,
  remoteFsViolationCount,
  uninstallRemoteFsGuard,
} from '../../src/main/remoteFsGuard';

const PREFIXED = [
  '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude',
  '\\\\wsl$\\Ubuntu\\home\\u',
  '//wsl.localhost/Ubuntu/home/u',
];

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'remote-fs-guard-'));
});

afterEach(() => {
  uninstallRemoteFsGuard();
  rmSync(tmp, { recursive: true, force: true });
});

describe('remoteFsGuard', () => {
  it('throws in test mode for each prefix', async () => {
    const extra = join(tmp, 'unc-root');
    installRemoteFsGuard({ throwOnViolation: true, extraPrefixes: [extra] });
    for (const path of [...PREFIXED, join(extra, 'home', 'u', '.claude', 'x.json')]) {
      expect(() => fs.existsSync(path), path).toThrow(RemoteFsViolation);
      expect(() => fs.readFileSync(path), path).toThrow(RemoteFsViolation);
      await expect(fs.promises.readFile(path), path).rejects.toBeInstanceOf(RemoteFsViolation);
      await expect(fs.promises.stat(path), path).rejects.toBeInstanceOf(RemoteFsViolation);
      expect(() => fs.watch(path), path).toThrow(RemoteFsViolation);
      expect(() => fs.createReadStream(path), path).toThrow(RemoteFsViolation);
    }
    // Two-path ops check the destination too; Buffer and file: URL args count.
    expect(() => fs.renameSync(join(tmp, 'a'), PREFIXED[0]!)).toThrow(RemoteFsViolation);
    expect(() => fs.copyFileSync(join(tmp, 'a'), PREFIXED[2]!)).toThrow(RemoteFsViolation);
    expect(() => fs.readFileSync(Buffer.from(PREFIXED[0]!))).toThrow(RemoteFsViolation);
    expect(() => fs.existsSync(pathToFileURL(join(extra, 'f')))).toThrow(RemoteFsViolation);
    expect(remoteFsViolationCount()).toBeGreaterThan(20);
  });

  it('test mode logs once per op before throwing', () => {
    const logged: string[] = [];
    installRemoteFsGuard({ throwOnViolation: true, extraPrefixes: [], log: (op) => logged.push(op) });
    expect(() => fs.statSync(PREFIXED[0]!)).toThrow(RemoteFsViolation);
    expect(() => fs.statSync(PREFIXED[1]!)).toThrow(RemoteFsViolation);
    expect(logged).toEqual(['statSync']);
    expect(remoteFsViolationCount()).toBe(2);
  });

  it('destructured imports see the patch', async () => {
    installRemoteFsGuard({ throwOnViolation: true, extraPrefixes: [] });
    expect(() => existsSync(PREFIXED[0]!)).toThrow(RemoteFsViolation);
    expect(() => readFileSync(PREFIXED[1]!)).toThrow(RemoteFsViolation);
    await expect(readFileP(PREFIXED[2]!)).rejects.toBeInstanceOf(RemoteFsViolation);
  });

  it('local paths pass', async () => {
    const extra = join(tmp, 'unc-root');
    installRemoteFsGuard({ throwOnViolation: true, extraPrefixes: [extra] });
    const file = join(tmp, 'local.txt');
    writeFileSync(file, 'hello');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(await fs.promises.readFile(file, 'utf8')).toBe('hello');
    // A sibling that merely shares the extra prefix's leading characters.
    expect(fs.existsSync(`${extra}-other`)).toBe(false);
    // File descriptors are not paths.
    const fd = fs.openSync(file, 'r');
    fs.closeSync(fd);
    expect(remoteFsViolationCount()).toBe(0);
  });

  it('production logs once per op and passes through', async () => {
    const extra = join(tmp, 'unc-root');
    fs.mkdirSync(extra);
    const target = join(extra, 'store.json');
    fs.writeFileSync(target, '{"ok":true}');
    const logged: string[] = [];
    installRemoteFsGuard({ throwOnViolation: false, extraPrefixes: [extra], log: (op) => logged.push(op) });
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
    expect(existsSync(target)).toBe(true);
    expect(await fs.promises.readFile(target, 'utf8')).toBe('{"ok":true}');
    expect(await fs.promises.readFile(target, 'utf8')).toBe('{"ok":true}');
    expect(logged.sort()).toEqual(['existsSync', 'promises.readFile', 'readFileSync']);
    expect(remoteFsViolationCount()).toBe(5);
  });

  it.runIf(process.platform === 'win32')('matches case-insensitively with either slash on Windows', () => {
    expect(isRemoteFsPath('\\\\WSL.LOCALHOST\\D\\x', [])).toBe(true);
    expect(isRemoteFsPath('//Wsl.LocalHost/D/x', [])).toBe(true);
    expect(isRemoteFsPath('\\\\?\\UNC\\wsl.localhost\\D\\x', [])).toBe(true);
    expect(isRemoteFsPath('C:/TEMP/root/x', ['c:\\temp\\root\\'])).toBe(true);
    expect(isRemoteFsPath('C:\\temp\\rooted', ['c:\\temp\\root'])).toBe(false);
    expect(isRemoteFsPath('C:\\Users\\u\\wsl.localhost', [])).toBe(false);
  });

  it('uninstall restores the originals', () => {
    installRemoteFsGuard({ throwOnViolation: true, extraPrefixes: [] });
    uninstallRemoteFsGuard();
    expect(fs.existsSync(PREFIXED[0]!)).toBe(false);
    expect(existsSync(PREFIXED[0]!)).toBe(false);
  });
});
