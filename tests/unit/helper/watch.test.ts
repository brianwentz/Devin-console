import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsWatcher, WATCH_DEBOUNCE_MS, type WatchChange } from '../../../src/helper/watch';
import { changePayload, type StoreChanged } from '../../../src/helper/store';
import { SESSION_A, SESSION_B, copyClaudeHome, transcriptLines } from './fixtureHome';

let home: { dir: string; cleanup: () => void };
let prevConfig: string | undefined;
let watcher: ProjectsWatcher | null = null;

beforeEach(() => {
  home = copyClaudeHome();
  prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home.dir;
});
afterEach(() => {
  watcher?.stop();
  watcher = null;
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  home.cleanup();
});

const projects = (): string => join(home.dir, 'projects');

function startWatching(opts: Partial<ConstructorParameters<typeof ProjectsWatcher>[0]> = {}): {
  raw: WatchChange[];
  payloads: StoreChanged[];
} {
  const raw: WatchChange[] = [];
  const payloads: StoreChanged[] = [];
  watcher = new ProjectsWatcher({
    projectsDir: projects(),
    onChange: (c) => {
      raw.push(c);
      void changePayload(projects(), c).then((p) => payloads.push(p));
    },
    ...opts,
  });
  watcher.start();
  return { raw, payloads };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await settle(20);
  }
}

describe('helper watch', () => {
  it('watch emits {files, sessions} within 1 s of an append', async () => {
    const { payloads } = startWatching();
    expect(watcher!.mode).toBe('watch');
    await settle(100);
    const file = join(projects(), 'C--work-alpha', `${SESSION_A}.jsonl`);
    const t0 = Date.now();
    appendFileSync(file, transcriptLines(SESSION_A, 1).replace(`${SESSION_A}-m0`, `${SESSION_A}-x0`));
    const first = await until(() => payloads.find((p) => p.files.length > 0));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(first.files).toEqual([`C--work-alpha/${SESSION_A}.jsonl`]);
    expect(first.sessions.map((s) => s.sessionId)).toEqual([SESSION_A]);
    expect(first.removed).toEqual([]);
  });

  it('events inside one debounce window coalesce into one change; the window is fixed from the first event', () => {
    // Real fs.watch delivery timing is up to the OS, so the coalescing contract is
    // pinned with an injected watcher and fake timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const listeners = new Map<string, (event: string, name: string | null) => void>();
      const { raw } = startWatching({
        watchFn: ((p: string, _o: { persistent: boolean }, l: (e: string, n: string | null) => void) => {
          listeners.set(p, l);
          return Object.assign(new EventEmitter(), { close: () => undefined });
        }) as never,
      });
      expect(watcher!.mode).toBe('watch');
      const alpha = listeners.get(join(projects(), 'C--work-alpha'))!;
      expect(alpha).toBeDefined();
      for (let i = 0; i < 5; i++) {
        alpha('change', `${SESSION_A}.jsonl`);
        vi.advanceTimersByTime(20);
      }
      expect(raw).toEqual([]);
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 100);
      expect(raw).toEqual([{ files: [`C--work-alpha/${SESSION_A}.jsonl`], removed: [] }]);
      // A later event opens a new window → exactly one more change.
      alpha('change', `${SESSION_A}.jsonl`);
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 1);
      expect(raw).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(raw).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deleted transcript → removed', async () => {
    const { payloads } = startWatching();
    await settle(100);
    rmSync(join(projects(), 'C--work-alpha', `${SESSION_B}.jsonl`));
    const p = await until(() => payloads.find((x) => x.removed.length > 0));
    expect(p.removed).toEqual([SESSION_B]);
    expect(p.files).toEqual([]);
    expect(p.sessions).toEqual([]);
  });

  it('new project dir is watched', async () => {
    const { payloads } = startWatching();
    await settle(100);
    const id = '33333333-0000-4000-8000-000000000001';
    const dir = join(projects(), '-home-u-gamma');
    mkdirSync(dir);
    await settle(400);
    writeFileSync(join(dir, `${id}.jsonl`), transcriptLines(id, 2, '/home/u/gamma'));
    const p = await until(() => payloads.find((x) => x.files.includes(`-home-u-gamma/${id}.jsonl`)));
    expect(p.sessions.map((s) => s.sessionId)).toContain(id);
    // A later append inside the new dir is seen by its own watcher.
    payloads.length = 0;
    await settle(300);
    appendFileSync(join(dir, `${id}.jsonl`), transcriptLines(id, 1, '/home/u/gamma').replace(`${id}-m0`, `${id}-y`));
    await until(() => payloads.find((x) => x.files.includes(`-home-u-gamma/${id}.jsonl`)));
  });

  it('a projects dir that appears after start reports the transcripts already in it', async () => {
    rmSync(projects(), { recursive: true, force: true });
    const { payloads } = startWatching({ retryRootMs: 100 });
    await settle(50);
    const id = '33333333-0000-4000-8000-000000000002';
    const dir = join(projects(), '-home-u-fresh');
    // A fresh install: the CLI creates projects/<p>/<id>.jsonl in one go.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), transcriptLines(id, 2, '/home/u/fresh'));
    const p = await until(() => payloads.find((x) => x.files.includes(`-home-u-fresh/${id}.jsonl`)));
    expect(p.sessions.map((s) => s.sessionId)).toContain(id);
  });

  it('subagent transcript changes are reported under <proj>/<id>/subagents/', async () => {
    const { raw } = startWatching();
    await settle(100);
    appendFileSync(join(projects(), 'C--work-alpha', SESSION_A, 'subagents', 'agent-fixture01.jsonl'), '\n');
    const c = await until(() => raw.find((x) => x.files.length > 0));
    expect(c.files).toEqual([`C--work-alpha/${SESSION_A}/subagents/agent-fixture01.jsonl`]);
  });

  it('an ENOENT race on a vanishing dir is skipped; mode stays watch', async () => {
    const enoent = (p: string): never => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${p}'`), { code: 'ENOENT' });
    };
    // -home-u-race "vanishes" between isDir and watch — at scan time and when it appears later.
    mkdirSync(join(projects(), '-home-u-race'));
    const { payloads } = startWatching({
      watchFn: ((p: string, o: { persistent: boolean }, l: (e: string, n: string | null) => void) =>
        p.includes('-home-u-race') ? enoent(p) : watch(p, o, l)) as never,
    });
    expect(watcher!.mode).toBe('watch');
    await settle(100);
    mkdirSync(join(projects(), '-home-u-race2'));
    await settle(300);
    expect(watcher!.mode).toBe('watch');
    // The other dirs are still watched.
    appendFileSync(join(projects(), 'C--work-alpha', `${SESSION_A}.jsonl`), '\n');
    await until(() => payloads.find((x) => x.files.includes(`C--work-alpha/${SESSION_A}.jsonl`)));
    expect(watcher!.mode).toBe('watch');
  });

  it('ENOSPC on a new project dir switches to poll', async () => {
    const { raw } = startWatching({
      watchFn: ((p: string, o: { persistent: boolean }, l: (e: string, n: string | null) => void) => {
        if (p.includes('-home-u-full')) {
          throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
        }
        return watch(p, o, l);
      }) as never,
      pollMs: 50,
    });
    expect(watcher!.mode).toBe('watch');
    await settle(100);
    mkdirSync(join(projects(), '-home-u-full'));
    await until(() => (watcher!.mode === 'poll' ? true : undefined));
    expect(raw).toBeDefined();
  });

  it('a watch error falls back to the 5 s stat poll with watchMode poll', async () => {
    const modes: string[] = [];
    const { payloads } = startWatching({
      watchFn: (() => {
        throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
          code: 'ENOSPC',
        });
      }) as never,
      pollMs: 50,
      onMode: (m) => modes.push(m),
    });
    expect(watcher!.mode).toBe('poll');
    expect(modes).toEqual(['poll']);
    await settle(120);
    appendFileSync(join(projects(), 'C--work-alpha', `${SESSION_A}.jsonl`), '\n');
    const p = await until(() => payloads.find((x) => x.files.length > 0));
    expect(p.files).toEqual([`C--work-alpha/${SESSION_A}.jsonl`]);
    rmSync(join(projects(), 'C--work-alpha', `${SESSION_B}.jsonl`));
    await until(() => payloads.find((x) => x.removed.includes(SESSION_B)));
  });
});
