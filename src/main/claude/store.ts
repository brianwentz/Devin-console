// Claude Code SDK store wrapper: listSessions → ClaudeStoreSession rows, thin
// mutation calls, and fs.watch-based change detection over <configDir>/projects.
// The SDK is loaded lazily on the first list() via loadSdk() — a load failure
// surfaces as an error status on the controller, never as a thrown require.

import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { basename, join, relative } from 'node:path';
import type { ClaudeStoreSession } from '../../core/claudeRegistry';
import { isWslHost, type ExecHost } from '../../core/execHost';
import { log } from '../log';
import { hosts } from '../hosts';
import { loadSdk } from './sdk';

const WATCH_DEBOUNCE_MS = 250;
const POLL_MS = 30_000;
// WSL tiered polling: hot transcripts every 2 s while the Claude surface is
// visible (fs.watch does not work over the wsl UNC), full scan every 30 s.
const HOT_POLL_MS = 2_000;
const HOT_COUNT = 20;

export class ClaudeStore {
  private configDirFn: string | (() => string);
  private host: ExecHost;
  private onChange: (files: string[]) => void;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private hotTimer: NodeJS.Timeout | null = null;
  private hotIds: () => string[] = () => [];
  private visible: () => boolean = () => false;
  private inotify: ChildProcess | null = null;
  // abs path → last known mtime, recomputed on the 30 s full-scan tick
  private hotPaths = new Map<string, number>();
  private started = false;
  private watchRestarts = 0;
  private watchFailed = false;

  constructor(opts: {
    host: ExecHost;
    configDir: string | (() => string);
    onChange: (files: string[]) => void;
  }) {
    this.host = opts.host;
    this.configDirFn = opts.configDir;
    this.onChange = opts.onChange;
  }

  /** Sessions whose transcripts get the 2 s hot-stat tier; visible() gates it. */
  hot(ids: () => string[], visible: () => boolean): void {
    this.hotIds = ids;
    this.visible = visible;
  }

  // A wsl host's home is unknown until the probe lands — resolve lazily so
  // early-created stores pick up the probed home on the next access.
  private get configDir(): string {
    return typeof this.configDirFn === 'function' ? this.configDirFn() : this.configDirFn;
  }

  private get projectsDir(): string {
    return join(this.configDir, 'projects');
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return hosts().withConfigDir(this.host, fn);
  }

  async list(): Promise<ClaudeStoreSession[]> {
    const sdk = await loadSdk();
    const infos = await this.run(() => sdk.listSessions({ includeProgrammatic: true }));
    return infos.map((info) => ({
      id: info.sessionId,
      host: this.host.id,
      // The SDK already resolves title precedence: custom title →
      // auto-generated summary → first prompt.
      title: info.summary,
      cwd: info.cwd ?? null,
      gitBranch: info.gitBranch ?? null,
      tag: info.tag ?? null,
      createdAt: info.createdAt ?? null,
      lastModified: info.lastModified,
      fileSize: info.fileSize ?? null,
    }));
  }

  async rename(id: string, title: string): Promise<void> {
    const sdk = await loadSdk();
    await this.run(() => sdk.renameSession(id, title));
  }

  async fork(id: string): Promise<{ sessionId: string }> {
    const sdk = await loadSdk();
    const result = await this.run(() => sdk.forkSession(id));
    return { sessionId: result.sessionId };
  }

  async deleteTranscript(id: string): Promise<void> {
    const sdk = await loadSdk();
    await this.run(() => sdk.deleteSession(id));
  }

  async listSubagents(id: string): Promise<string[]> {
    const sdk = await loadSdk();
    return this.run(() => sdk.listSubagents(id));
  }

  async subagentMessages(id: string, agentId: string): Promise<unknown[]> {
    const sdk = await loadSdk();
    return this.run(() => sdk.getSubagentMessages(id, agentId)) as Promise<unknown[]>;
  }

  // The SDK exposes no transcript-path API: <configDir>/projects/<encoded cwd>/
  // <id>.jsonl — find it by scanning project dirs for the id-named file.
  async transcriptPath(id: string): Promise<string | null> {
    try {
      for (const project of readdirSync(this.projectsDir)) {
        const candidate = join(this.projectsDir, project, `${id}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // No projects dir.
    }
    return null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (isWslHost(this.host)) {
      // fs.watch fails over the wsl UNC (EISDIR) — inotifywait inside the
      // distro when the probe found it, else tiered polling.
      const status = hosts().status(this.host.id);
      if (status?.inotify) this.startInotify();
      else this.startTieredPoll();
      return;
    }
    this.startWatch();
  }

  // `wsl.exe -d D -e inotifywait -m -r -q -e <ev> --format %w%f <projects>` —
  // each stdout line is a changed file; same debounce as fs.watch. A dead
  // child falls back to tiered polling.
  private startInotify(): void {
    const wsl = hosts().wslCmd();
    if (!wsl || !isWslHost(this.host)) {
      this.startTieredPoll();
      return;
    }
    const [file, ...prefix] = wsl;
    const projects = this.projectsDirLinux();
    const child = spawn(
      file!,
      [
        ...prefix,
        '-d',
        this.host.distro,
        '-e',
        '/usr/bin/inotifywait',
        '-m',
        '-r',
        '-q',
        '-e',
        'modify,create,delete,moved_to',
        '--format',
        '%w%f',
        projects,
      ],
      { windowsHide: true },
    );
    this.inotify = child;
    const changed = new Set<string>();
    let rest = '';
    child.stdout?.on('data', (data: Buffer) => {
      rest += data.toString('utf8');
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const rel = line.trim().slice(projects.length).replace(/^\/+/, '');
        if (rel) changed.add(rel);
      }
      if (this.watchTimer) return;
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null;
        const files = [...changed];
        changed.clear();
        this.onChange(files);
      }, WATCH_DEBOUNCE_MS);
    });
    const fallback = () => {
      if (this.inotify !== child) return;
      this.inotify = null;
      if (this.started) this.startTieredPoll();
    };
    child.once('exit', fallback);
    child.once('error', fallback);
    log('claude', 'claude-watch', { detail: { mode: 'inotify', host: this.host.id, events: 0 } });
  }

  // Windows-side <configDir>/projects → the linux path inside the distro.
  private projectsDirLinux(): string {
    const dir = this.projectsDir.replace(/\\/g, '/');
    const m = /^\/{2}[^/]+\/[^/]+(\/.*)$/.exec(dir);
    return m && m[1] ? m[1] : dir;
  }

  // Tiered polling (wsl without inotify): the 30 s full-scan tick recomputes
  // the recent-20 ∪ hot-id path set once; the 2 s tick only stats that cached
  // set and reports changed transcripts as <encoded-cwd>/<id>.jsonl relative
  // paths — the same shape fs.watch emits, so onTranscriptFiles parses them.
  private startTieredPoll(): void {
    log('claude', 'claude-watch', {
      detail: { mode: 'poll-tiered', host: this.host.id, events: 0 },
    });
    void this.recomputeHotPaths();
    this.startPoll(() => {
      void this.recomputeHotPaths();
    });
    this.hotTimer = setInterval(() => {
      if (!this.visible()) return;
      try {
        // Hot ids whose transcript appeared since the last recompute get
        // resolved lazily — a new file counts as changed immediately.
        const known = new Set([...this.hotPaths.keys()].map((p) => basename(p, '.jsonl')));
        for (const id of this.hotIds()) {
          if (known.has(id)) continue;
          const path = this.transcriptFor(id);
          if (!path) continue;
          try {
            this.hotPaths.set(path, statSync(path).mtimeMs - 1);
          } catch {
            /* gone already */
          }
        }
        const changed: string[] = [];
        for (const [path, prev] of this.hotPaths) {
          let mtime: number | null = null;
          try {
            mtime = statSync(path).mtimeMs;
          } catch {
            /* gone between ticks */
          }
          if (mtime === null || mtime === prev) continue;
          this.hotPaths.set(path, mtime);
          changed.push(relative(this.projectsDir, path));
        }
        if (changed.length > 0) {
          log('claude', 'claude-watch', {
            detail: { mode: 'poll-tiered', host: this.host.id, events: changed.length },
          });
          this.onChange(changed);
        }
      } catch {
        /* transient stat failures — next tick retries */
      }
    }, HOT_POLL_MS);
    this.hotTimer.unref?.();
  }

  // Full readdir scan: the 20 most recent transcripts plus any hot (e.g.
  // terminal-owned) ids, keyed abs-path → mtime. Runs on the 30 s tick and
  // once at watcher start.
  private async recomputeHotPaths(): Promise<void> {
    await this.run(async () => {
      try {
        const files: { path: string; mtime: number }[] = [];
        for (const project of readdirSync(this.projectsDir)) {
          const dir = join(this.projectsDir, project);
          for (const name of readdirSync(dir)) {
            if (!name.endsWith('.jsonl')) continue;
            const path = join(dir, name);
            try {
              files.push({ path, mtime: statSync(path).mtimeMs });
            } catch {
              /* transient */
            }
          }
        }
        const hot = new Set(this.hotIds());
        const next = new Map<string, number>();
        for (const file of files.sort((a, b) => b.mtime - a.mtime).slice(0, HOT_COUNT)) {
          next.set(file.path, file.mtime);
        }
        for (const file of files) {
          if (hot.has(basename(file.path, '.jsonl')) && !next.has(file.path)) {
            next.set(file.path, file.mtime);
          }
        }
        this.hotPaths = next;
      } catch {
        /* no projects dir yet */
      }
    });
  }

  private transcriptFor(id: string): string | null {
    try {
      for (const project of readdirSync(this.projectsDir)) {
        const candidate = join(this.projectsDir, project, `${id}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* no projects dir */
    }
    return null;
  }

  private startWatch(): void {
    if (!existsSync(this.projectsDir)) {
      // Fresh machines have no projects dir yet; poll until it appears.
      log('claude', 'claude-watch', { detail: { mode: 'waiting', events: 0 } });
      this.startPoll();
      return;
    }
    this.stopPoll();
    try {
      const changed = new Set<string>();
      this.watcher = watch(this.projectsDir, { recursive: true }, (_event, filename) => {
        if (filename) changed.add(filename);
        if (this.watchTimer) return;
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          const files = [...changed];
          changed.clear();
          this.onChange(files);
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => {
        // One restart, then fall back to polling.
        this.watcher?.close();
        this.watcher = null;
        this.watchRestarts += 1;
        if (this.watchRestarts <= 1) {
          setTimeout(() => this.startWatch(), 5_000).unref?.();
        } else {
          this.watchFailed = true;
          this.startPoll();
        }
      });
      log('claude', 'claude-watch', { detail: { mode: 'watch', events: 0 } });
    } catch {
      this.watchFailed = true;
      log('claude', 'claude-watch', { detail: { mode: 'poll', events: 0 } });
      this.startPoll();
    }
  }

  private startPoll(onTick?: () => void): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      const dirExists = existsSync(this.projectsDir);
      if (!this.watcher && !this.watchFailed && dirExists) {
        // The dir appeared after the waiting phase — try watching again.
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
        this.startWatch();
        return;
      }
      if (dirExists) {
        onTick?.();
        this.onChange([]);
      }
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  dispose(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = null;
    this.inotify?.kill();
    this.inotify = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.hotTimer) clearInterval(this.hotTimer);
    this.hotTimer = null;
    this.stopPoll();
  }
}
