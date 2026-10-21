// Native watch of <configDir>/projects for the store.changed notification.
//
// Non-recursive fs.watch (Node 18 on Linux has no recursive mode) on:
//   projects/                      → project dirs appearing/disappearing
//   projects/<p>/                  → <id>.jsonl transcripts
//   projects/<p>/<id>/subagents/   → subagent transcripts
// A session dir's `subagents/` is attached when it is seen at scan time, when
// `<id>` appears in the project dir, or when the parent `<id>.jsonl` changes
// (the parent transcript is always written when a subagent runs) — so session
// dirs themselves need no watcher.
//
// Reported paths are relative to projects/ with `/` separators — the shape the
// app's onTranscriptFiles parses. On any watch error (ENOSPC, …) every watcher
// is closed and a stat poll of the newest transcripts takes over: mode 'poll'.

import { readdirSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export type WatchChange = { files: string[]; removed: string[] };
export type WatchMode = 'watch' | 'poll';

export const WATCH_DEBOUNCE_MS = 250;
export const POLL_MS = 5_000;
export const POLL_RECENT = 50;
/** Poll ticks between full stat passes (which also refresh the recent set). */
const FULL_EVERY = 12;
const RETRY_ROOT_MS = 5_000;

type WatchFn = (path: string, opts: { persistent: boolean }, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher;

export type WatcherOptions = {
  projectsDir: string;
  onChange: (change: WatchChange) => void;
  onMode?: (mode: WatchMode) => void;
  debounceMs?: number;
  pollMs?: number;
  recentCount?: number;
  watchFn?: WatchFn;
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const JSONL = '.jsonl';

/** The path disappeared under us (ENOENT/ENOTDIR) — skip it; anything else (ENOSPC, EMFILE, …) is a real watch failure. */
const isGone = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export class ProjectsWatcher {
  mode: WatchMode = 'watch';
  private readonly watchers = new Map<string, FSWatcher>();
  /** project dir → transcript ids seen in it (to report deletions). */
  private readonly known = new Map<string, Set<string>>();
  private readonly pendingFiles = new Set<string>();
  private readonly pendingRemoved = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollTicks = 0;
  /** poll mode: `<p>/<id>.jsonl` → `${mtimeMs}:${size}`. */
  private snapshot = new Map<string, string>();
  private started = false;
  private stopped = false;
  private readonly watchFn: WatchFn;

  constructor(private readonly opts: WatcherOptions) {
    this.watchFn = opts.watchFn ?? (fsWatch as unknown as WatchFn);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.attachRoot();
    } catch {
      this.toPoll();
    }
  }

  stop(): void {
    this.stopped = true;
    this.closeWatchers();
    for (const t of [this.flushTimer, this.retryTimer, this.pollTimer]) if (t) clearTimeout(t);
    this.flushTimer = this.retryTimer = this.pollTimer = null;
  }

  // ---- watch mode -------------------------------------------------------

  private attachRoot(): void {
    if (this.stopped || this.mode === 'poll') return;
    if (!isDir(this.opts.projectsDir)) {
      this.retryRoot();
      return;
    }
    try {
      this.watchDir('', this.opts.projectsDir, (name) => this.onRootEvent(name));
      for (const entry of readdirSync(this.opts.projectsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) this.attachProject(entry.name, false);
      }
    } catch (error) {
      if (!isGone(error)) throw error;
      // projects/ vanished mid-attach: start over once it is back.
      this.closeWatchers();
      this.known.clear();
      this.retryRoot();
    }
  }

  // No projects/ yet (fresh install) or it just vanished: look again shortly.
  private retryRoot(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      try {
        this.attachRoot();
      } catch {
        this.toPoll();
      }
    }, RETRY_ROOT_MS);
    this.retryTimer.unref?.();
  }

  private watchDir(key: string, abs: string, onName: (name: string) => void): void {
    const w = this.watchFn(abs, { persistent: false }, (_event, name) => {
      if (name) this.guard(() => onName(name.toString()));
    });
    w.on('error', () => this.guard(() => this.onWatchError(key, abs)));
    this.watchers.set(key, w);
  }

  private guard(fn: () => void): void {
    if (this.stopped || this.mode === 'poll') return;
    try {
      fn();
    } catch (error) {
      // A path that vanished between event and stat is a race, not a broken watcher.
      if (!isGone(error)) this.toPoll();
    }
  }

  private onWatchError(key: string, abs: string): void {
    // A deleted directory's watcher may error (Windows) — that is a removal, not a failure.
    if (key !== '' && !isDir(abs)) {
      this.detach(key);
      return;
    }
    this.toPoll();
  }

  private detach(key: string): void {
    this.closeUnder(key);
    if (!key.includes('/')) {
      for (const id of this.known.get(key) ?? []) this.pendingRemoved.add(id);
      this.known.delete(key);
      this.scheduleFlush();
    }
  }

  private onRootEvent(name: string): void {
    const abs = join(this.opts.projectsDir, name);
    if (isDir(abs)) {
      if (!this.watchers.has(name)) this.attachProject(name, true);
    } else if (this.watchers.has(name)) {
      this.detach(name);
    }
  }

  private attachProject(project: string, emitExisting: boolean): void {
    const abs = join(this.opts.projectsDir, project);
    const ids = new Set<string>();
    try {
      this.watchDir(project, abs, (name) => this.onProjectEvent(project, name));
      this.known.set(project, ids);
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(JSONL)) {
          ids.add(entry.name.slice(0, -JSONL.length));
          if (emitExisting) this.queueFile(`${project}/${entry.name}`);
        } else if (entry.isDirectory()) {
          this.maybeAttachSubagents(project, entry.name);
        }
      }
    } catch (error) {
      if (!isGone(error)) throw error;
      // Created then removed before we got to it: nothing to watch.
      this.closeUnder(project);
      this.known.delete(project);
      for (const f of [...this.pendingFiles]) if (f.startsWith(`${project}/`)) this.pendingFiles.delete(f);
    }
  }

  private closeUnder(key: string): void {
    for (const [k, w] of this.watchers) {
      if (k === key || k.startsWith(`${key}/`)) {
        try {
          w.close();
        } catch {}
        this.watchers.delete(k);
      }
    }
  }

  private onProjectEvent(project: string, name: string): void {
    const abs = join(this.opts.projectsDir, project, name);
    const ids = this.known.get(project) ?? new Set<string>();
    if (name.endsWith(JSONL)) {
      const id = name.slice(0, -JSONL.length);
      let present = false;
      try {
        present = statSync(abs).isFile();
      } catch {
        present = false;
      }
      if (present) {
        ids.add(id);
        this.queueFile(`${project}/${name}`);
        this.maybeAttachSubagents(project, id);
      } else if (ids.delete(id)) {
        this.pendingRemoved.add(id);
        this.scheduleFlush();
      }
      return;
    }
    const subKey = `${project}/${name}/subagents`;
    if (isDir(abs)) this.maybeAttachSubagents(project, name);
    else if (this.watchers.has(subKey)) this.detach(subKey);
  }

  private maybeAttachSubagents(project: string, id: string): void {
    const key = `${project}/${id}/subagents`;
    if (this.watchers.has(key)) return;
    const abs = join(this.opts.projectsDir, project, id, 'subagents');
    if (!isDir(abs)) return;
    try {
      this.watchDir(key, abs, (name) => {
        if (name.endsWith(JSONL)) this.queueFile(`${key}/${name}`);
      });
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  private closeWatchers(): void {
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {}
    }
    this.watchers.clear();
  }

  // ---- coalescing -------------------------------------------------------

  private queueFile(file: string): void {
    this.pendingFiles.add(file);
    this.scheduleFlush();
  }

  // A fixed window from the first event (not reset per event): a transcript
  // that streams continuously still reports every WATCH_DEBOUNCE_MS.
  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.opts.debounceMs ?? WATCH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    const removed = new Set(this.pendingRemoved);
    const files: string[] = [];
    for (const file of this.pendingFiles) {
      const parts = file.split('/');
      if (parts.length === 2) {
        const id = parts[1]!.slice(0, -JSONL.length);
        let present = false;
        try {
          present = statSync(join(this.opts.projectsDir, parts[0]!, parts[1]!)).isFile();
        } catch {
          present = false;
        }
        if (!present) {
          removed.add(id);
          continue;
        }
        removed.delete(id);
      }
      files.push(file);
    }
    this.pendingFiles.clear();
    this.pendingRemoved.clear();
    if (files.length === 0 && removed.size === 0) return;
    this.opts.onChange({ files: files.sort(), removed: [...removed].sort() });
  }

  // ---- poll mode --------------------------------------------------------

  private toPoll(): void {
    if (this.mode === 'poll' || this.stopped) return;
    this.mode = 'poll';
    this.closeWatchers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.opts.onMode?.('poll');
    this.snapshot = this.statAll(this.listTranscripts());
    const ms = this.opts.pollMs ?? POLL_MS;
    const tick = (): void => {
      this.pollTimer = setTimeout(() => {
        try {
          this.pollTick();
        } catch {
          /* projects dir vanished mid-tick; next tick re-reads it */
        }
        if (!this.stopped) tick();
      }, ms);
      this.pollTimer.unref?.();
    };
    tick();
  }

  /** Every `<p>/<id>.jsonl` under projects/ — readdir only, no stats. */
  private listTranscripts(): string[] {
    const out: string[] = [];
    let projects: string[];
    try {
      projects = readdirSync(this.opts.projectsDir);
    } catch {
      return out;
    }
    for (const project of projects) {
      try {
        for (const name of readdirSync(join(this.opts.projectsDir, project))) {
          if (name.endsWith(JSONL)) out.push(`${project}/${name}`);
        }
      } catch {
        /* not a dir */
      }
    }
    return out;
  }

  private statOne(file: string): string | null {
    try {
      const s = statSync(join(this.opts.projectsDir, ...file.split('/')));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }

  private statAll(files: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const f of files) {
      const sig = this.statOne(f);
      if (sig !== null) out.set(f, sig);
    }
    return out;
  }

  private recent(): string[] {
    const n = this.opts.recentCount ?? POLL_RECENT;
    const mtime = (sig: string): number => Number(sig.split(':')[0]);
    return [...this.snapshot.entries()]
      .sort((a, b) => mtime(b[1]) - mtime(a[1]))
      .slice(0, n)
      .map(([f]) => f);
  }

  private pollTick(): void {
    this.pollTicks++;
    const names = new Set(this.listTranscripts());
    for (const f of this.snapshot.keys()) {
      if (!names.has(f)) {
        this.snapshot.delete(f);
        this.pendingRemoved.add(f.split('/')[1]!.slice(0, -JSONL.length));
      }
    }
    const full = this.pollTicks % FULL_EVERY === 0;
    const check = full ? [...names] : [...new Set([...this.recent(), ...[...names].filter((f) => !this.snapshot.has(f))])];
    for (const f of check) {
      const sig = this.statOne(f);
      if (sig === null) continue;
      if (this.snapshot.get(f) !== sig) {
        this.snapshot.set(f, sig);
        this.pendingFiles.add(f);
      }
    }
    if (this.pendingFiles.size > 0 || this.pendingRemoved.size > 0) this.flush();
  }
}
