// Claude Code SDK store wrapper: listSessions → ClaudeStoreSession rows, thin
// mutation calls, and fs.watch-based change detection over <configDir>/projects.
// The SDK is loaded lazily on the first list() via loadSdk() — a load failure
// surfaces as an error status on the controller, never as a thrown require.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { access, readdir, stat as statFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, relative } from 'node:path';
import type { ClaudeStoreSession } from '../../core/claudeRegistry';
import { dirsChanged } from '../../core/claudeWatchPolicy';
import { isWslHost, type ExecHost } from '../../core/execHost';
import { log } from '../log';
import { hosts } from '../hosts';
import { loadSdk } from './sdk';

const WATCH_DEBOUNCE_MS = 250;
const POLL_MS = 30_000;
// WSL polling (fs.watch does not work over the wsl UNC): terminal-owned
// transcripts every 2 s while the Claude surface is visible, project-dir
// change check every WSL_CHANGE_CHECK_MS.
const HOT_POLL_MS = 2_000;
export const WSL_CHANGE_CHECK_MS = 300_000;

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
  // hot session id -> resolved transcript path + last known mtime
  private hotPaths = new Map<string, { path: string; mtime: number }>();
  private dirMtimeSnapshot: Map<string, number> | null = null;
  private hotTickInFlight = false;
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
      for (const project of await readdir(this.projectsDir)) {
        const candidate = join(this.projectsDir, project, `${id}.jsonl`);
        try {
          await access(candidate);
          return candidate;
        } catch {
          /* not in this project dir */
        }
      }
    } catch {
      // No projects dir.
    }
    return null;
  }

  start(): void {
    if (this.started) return;
    if (isWslHost(this.host)) {
      // Probe not ready: touching the UNC root could block — refuse without
      // marking started so refresh() retries once the probe lands.
      if (!hosts().fsReady(this.host)) return;
      this.started = true;
      // fs.watch fails over the wsl UNC (EISDIR) — inotifywait inside the
      // distro when the probe found it, else tiered polling.
      const status = hosts().status(this.host.id);
      if (status?.inotify) this.startInotify();
      else this.startTieredPoll();
      return;
    }
    this.started = true;
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
    log('host', 'host-exec', { detail: { host: this.host.id, kind: 'spawn' } });
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
        log('claude', 'claude-watch', {
          detail: { mode: 'inotify', host: this.host.id, events: files.length },
        });
        this.onChange(files);
      }, WATCH_DEBOUNCE_MS);
    });
    // File-bearing events are history-only (see watchAction), so sessions
    // created outside the app still surface through the dir-mtime check.
    this.startChangeCheck();
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
    // hostPath also honours the test UNC-root seam.
    return hosts().hostPath(this.host, this.projectsDir);
  }

  // wsl without inotify. fs.watch fails over the UNC and a full SDK list there
  // costs seconds, so: a cheap project-dir mtime check every WSL_CHANGE_CHECK_MS
  // (onChange([]) -> full refresh only when a dir changed), plus a 2 s stat of
  // the terminal-owned (hot) transcripts only, reported as <encoded-cwd>/<id>.jsonl
  // relative paths - the shape fs.watch emits, so onTranscriptFiles parses them.
  private startTieredPoll(): void {
    if (this.hotTimer) return;
    log('claude', 'claude-watch', { detail: { mode: 'poll-wsl', host: this.host.id, events: 0 } });
    this.startChangeCheck();
    this.hotTimer = setInterval(() => {
      void this.hotTick();
    }, HOT_POLL_MS);
    this.hotTimer.unref?.();
  }

  // Shared by inotify and poll-only wsl modes; a no-op when already running.
  private startChangeCheck(): void {
    if (this.pollTimer) return;
    void this.dirMtimes().then((m) => {
      this.dirMtimeSnapshot ??= m;
    });
    this.pollTimer = setInterval(() => {
      void this.changeCheck();
    }, WSL_CHANGE_CHECK_MS);
    this.pollTimer.unref?.();
  }

  // projectDir -> mtimeMs; null when the projects dir can't be read.
  private async dirMtimes(): Promise<Map<string, number> | null> {
    try {
      const next = new Map<string, number>();
      for (const project of await readdir(this.projectsDir)) {
        try {
          next.set(project, (await statFile(join(this.projectsDir, project))).mtimeMs);
        } catch {
          /* removed between readdir and stat */
        }
      }
      return next;
    } catch {
      return null;
    }
  }

  private async changeCheck(): Promise<void> {
    const next = await this.dirMtimes();
    if (!next) return;
    const changed = dirsChanged(this.dirMtimeSnapshot, next);
    this.dirMtimeSnapshot = next;
    if (!changed) return;
    log('claude', 'claude-watch', { detail: { mode: 'poll-wsl', host: this.host.id, events: 1 } });
    this.onChange([]);
  }

  // The 2 s hot tick is async (UNC stats don't block the loop); a slow tick
  // never overlaps the next one.
  private async hotTick(): Promise<void> {
    if (this.hotTickInFlight || !this.visible()) return;
    this.hotTickInFlight = true;
    try {
      const ids = this.hotIds();
      for (const id of [...this.hotPaths.keys()]) {
        if (!ids.includes(id)) this.hotPaths.delete(id);
      }
      const changed: string[] = [];
      for (const id of ids) {
        let entry = this.hotPaths.get(id);
        if (!entry) {
          // Resolved once per id; a new file counts as changed immediately.
          const path = await this.transcriptFor(id);
          if (!path) continue;
          entry = { path, mtime: -1 };
          this.hotPaths.set(id, entry);
        }
        let mtime: number | null = null;
        try {
          mtime = (await statFile(entry.path)).mtimeMs;
        } catch {
          /* gone between ticks */
        }
        if (mtime === null || mtime === entry.mtime) continue;
        entry.mtime = mtime;
        changed.push(relative(this.projectsDir, entry.path));
      }
      if (changed.length > 0) {
        log('claude', 'claude-watch', {
          detail: { mode: 'poll-wsl', host: this.host.id, events: changed.length },
        });
        this.onChange(changed);
      }
    } catch {
      /* transient stat failures - next tick retries */
    } finally {
      this.hotTickInFlight = false;
    }
  }

  private async transcriptFor(id: string): Promise<string | null> {
    try {
      for (const project of await readdir(this.projectsDir)) {
        const candidate = join(this.projectsDir, project, `${id}.jsonl`);
        try {
          await access(candidate);
          return candidate;
        } catch {
          /* not in this project dir */
        }
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

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void (async () => {
        const dirExists = await access(this.projectsDir).then(
          () => true,
          () => false,
        );
        if (!this.watcher && !this.watchFailed && dirExists) {
          // The dir appeared after the waiting phase — try watching again.
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          this.startWatch();
          return;
        }
        if (dirExists) {
          this.onChange([]);
        }
      })();
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
