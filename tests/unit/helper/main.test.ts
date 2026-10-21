import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LineDecoder } from '../../../src/core/hostRpc';
import { EventEmitter } from 'node:events';
import {
  CLEANUP_AGE_MS,
  TOUCH_INTERVAL_MS,
  cleanupOldHelpers,
  createChangeNotifier,
  hashFromPath,
  installProcessHandlers,
  startSelfTouch,
} from '../../../src/helper/main';
import { SESSION_A, copyClaudeHome } from './fixtureHome';

const ROOT = resolve(__dirname, '../../..');
let buildDir: string;
let hash: string;
let home: { dir: string; cleanup: () => void };
let userHome: string;
let helperFile: string;

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), 'helper-build-'));
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-helper.mjs'), buildDir], { cwd: ROOT, stdio: 'pipe' });
  hash = (JSON.parse(readFileSync(join(buildDir, 'helper-hash.json'), 'utf8')) as { hash: string }).hash;
  home = copyClaudeHome();
  userHome = mkdtempSync(join(tmpdir(), 'helper-user-home-'));
  mkdirSync(join(userHome, '.agent-workspace'));
  helperFile = join(userHome, '.agent-workspace', `helper-${hash}.mjs`);
  copyFileSync(join(buildDir, 'agent-workspace-helper.mjs'), helperFile);
}, 60_000);

afterAll(() => {
  for (const d of [buildDir, userHome]) rmSync(d, { recursive: true, force: true });
  home.cleanup();
});

type Frame = Record<string, any>;
let child: ChildProcessWithoutNullStreams | null = null;

afterEach(() => {
  child?.kill();
  child = null;
});

function launch(): { frames: Frame[]; next: (pred?: (f: Frame) => boolean) => Promise<Frame>; exited: Promise<number | null> } {
  const c = spawn(process.execPath, [helperFile, '--stdio'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home.dir, HOME: userHome },
    stdio: 'pipe',
    windowsHide: true,
  });
  child = c;
  const frames: Frame[] = [];
  const decoder = new LineDecoder();
  const waiters: Array<() => void> = [];
  c.stdout.on('data', (chunk: Buffer) => {
    for (const f of decoder.push(chunk)) frames.push(f as Frame);
    for (const w of waiters.splice(0)) w();
  });
  const exited = new Promise<number | null>((r) => c.once('exit', (code) => r(code)));
  let cursor = 0;
  const next = async (pred: (f: Frame) => boolean = () => true): Promise<Frame> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      while (cursor < frames.length) {
        const f = frames[cursor++]!;
        if (pred(f)) return f;
      }
      if (Date.now() > deadline) throw new Error(`no frame; got ${JSON.stringify(frames)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 200);
      });
    }
  };
  return { frames, next, exited };
}

const send = (msg: unknown): void => {
  child!.stdin.write(`${JSON.stringify(msg)}\n`);
};

describe('helper main (built bundle)', () => {
  it('main replies hello first and exits on stdin EOF', async () => {
    const { frames, next, exited } = launch();
    const hello = await next();
    expect(hello).toEqual({
      method: 'hello',
      params: {
        protocol: 1,
        hash,
        node: process.versions.node,
        pid: child!.pid,
        home: userHome,
        watchMode: 'watch',
      },
    });
    send({ id: 1, method: 'ping', params: {} });
    expect((await next((f) => f.id === 1)).result).toEqual({ t: expect.any(Number) });
    child!.stdin.end();
    expect(await exited).toBe(0);
    expect(frames[0]).toBe(hello);
  });

  it('unknown method → unknown-method', async () => {
    const { next } = launch();
    await next();
    send({ id: 7, method: 'nope.nope', params: {} });
    expect(await next((f) => f.id === 7)).toEqual({ id: 7, error: { code: 'unknown-method', message: expect.any(String) } });
    send({ id: 8, method: 'store.messages', params: { sessionId: SESSION_A, limit: 9999 } });
    expect((await next((f) => f.id === 8)).error.code).toBe('bad-params');
  });

  it('serves store.list, env.get and store.changed after watch.subscribe', async () => {
    const { next } = launch();
    await next();
    send({ id: 1, method: 'store.list', params: {} });
    const list = await next((f) => f.id === 1);
    expect((list.result as Array<{ sessionId: string }>).map((s) => s.sessionId)).toContain(SESSION_A);
    send({ id: 2, method: 'env.get', params: {} });
    const env = await next((f) => f.id === 2);
    expect(env.result.watchMode).toBe('watch');
    expect(env.result.env.CLAUDE_CONFIG_DIR).toBe(home.dir);
    send({ id: 3, method: 'watch.subscribe', params: {} });
    expect((await next((f) => f.id === 3)).result).toEqual({});
    await new Promise((r) => setTimeout(r, 150));
    const file = join(home.dir, 'projects', 'C--work-alpha', `${SESSION_A}.jsonl`);
    writeFileSync(file, readFileSync(file));
    const changed = await next((f) => f.method === 'store.changed');
    expect(changed.params.files).toEqual([`C--work-alpha/${SESSION_A}.jsonl`]);
    expect(changed.params.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([SESSION_A]);
    expect(changed.params.removed).toEqual([]);
  });

  it('touches its own file at start', async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    utimesSync(helperFile, old, old);
    const { next } = launch();
    await next();
    expect(Date.now() - statSync(helperFile).mtimeMs).toBeLessThan(60_000);
  });
});

describe('helper main (modules)', () => {
  it('store.changed notifications go out in flush order even when an earlier payload is slow', async () => {
    const written: string[][] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const notify = createChangeNotifier(
      (msg) => written.push((msg.params as { files: string[] }).files),
      async (change) => {
        if (change.files[0] === 'p/first.jsonl') await slow;
        return { files: change.files, sessions: [], removed: change.removed };
      },
    );
    notify({ files: ['p/first.jsonl'], removed: [] });
    notify({ files: ['p/second.jsonl'], removed: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(written).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(written).toEqual([['p/first.jsonl'], ['p/second.jsonl']]);
  });

  it('a failed payload does not stall the queue', async () => {
    const written: string[][] = [];
    const notify = createChangeNotifier(
      (msg) => written.push((msg.params as { files: string[] }).files),
      async (change) => {
        if (change.files[0] === 'p/bad.jsonl') throw new Error('boom');
        return { files: change.files, sessions: [], removed: [] };
      },
    );
    notify({ files: ['p/bad.jsonl'], removed: [] });
    notify({ files: ['p/ok.jsonl'], removed: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(written).toEqual([['p/ok.jsonl']]);
  });

  it('process handlers: unhandledRejection is counted and served on; uncaughtException exits non-zero', () => {
    const proc = new EventEmitter();
    const stderr: string[] = [];
    const exits: number[] = [];
    installProcessHandlers(proc as unknown as NodeJS.Process, (s) => stderr.push(s), (code) => exits.push(code));
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    proc.emit('unhandledRejection', new Error('secret /home/u/path'), Promise.resolve());
    proc.emit('unhandledRejection', new Error('again'), Promise.resolve());
    expect(exits).toEqual([]);
    expect(stderr).toEqual(['helper: unhandledRejection=1\n', 'helper: unhandledRejection=2\n']);
    proc.emit('uncaughtException', new Error('fatal /home/u/x'));
    expect(stderr[2]).toBe('helper: uncaughtException=1\n');
    expect(exits).toEqual([1]);
    expect(stderr.join('')).not.toContain('/home/u');
  });

  it('hashFromPath reads the deployed filename', () => {
    expect(hashFromPath('/home/u/.agent-workspace/helper-0123456789ab.mjs')).toBe('0123456789ab');
    expect(hashFromPath('/x/agent-workspace-helper.mjs')).toBeNull();
  });

  it('touches its own file hourly', () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn();
      const stop = startSelfTouch('/f/helper-0123456789ab.mjs', touch);
      expect(touch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(TOUCH_INTERVAL_MS - 1);
      expect(touch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(touch).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(TOUCH_INTERVAL_MS * 3);
      expect(touch).toHaveBeenCalledTimes(5);
      stop();
      vi.advanceTimersByTime(TOUCH_INTERVAL_MS * 3);
      expect(touch).toHaveBeenCalledTimes(5);
      expect(TOUCH_INTERVAL_MS).toBe(3_600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup keeps files touched within 7 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helper-cleanup-'));
    try {
      const now = Date.now();
      const at = (name: string, ageMs: number): string => {
        const p = join(dir, name);
        writeFileSync(p, 'x');
        const t = new Date(now - ageMs);
        utimesSync(p, t, t);
        return p;
      };
      const self = at('helper-aaaaaaaaaaaa.mjs', CLEANUP_AGE_MS * 2);
      const fresh = at('helper-bbbbbbbbbbbb.mjs', CLEANUP_AGE_MS - 3600_000);
      const stale = at('helper-cccccccccccc.mjs', CLEANUP_AGE_MS + 3600_000);
      const staleTmp = at('.tmp.1234', CLEANUP_AGE_MS + 3600_000);
      const other = at('notes.txt', CLEANUP_AGE_MS * 3);
      expect(cleanupOldHelpers(dir, 'helper-aaaaaaaaaaaa.mjs', now)).toBe(2);
      expect(existsSync(self)).toBe(true);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleTmp)).toBe(false);
      expect(CLEANUP_AGE_MS).toBe(7 * 24 * 3600_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
