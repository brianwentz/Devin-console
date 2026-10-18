// Claude Code SDK store wrapper: listSessions → ClaudeStoreSession rows, thin
// mutation calls, and fs.watch-based change detection over <configDir>/projects.
// The SDK is loaded lazily on the first list() via loadSdk() — a load failure
// surfaces as an error status on the controller, never as a thrown require.

import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeStoreSession } from '../../core/claudeRegistry';
import { log } from '../log';
import { loadSdk } from './sdk';

const WATCH_DEBOUNCE_MS = 250;
const POLL_MS = 30_000;

export class ClaudeStore {
  private configDir: string;
  private onChange: (files: string[]) => void;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private started = false;
  private watchRestarts = 0;
  private watchFailed = false;

  constructor(opts: { configDir: string; onChange: (files: string[]) => void }) {
    this.configDir = opts.configDir;
    this.onChange = opts.onChange;
  }

  private get projectsDir(): string {
    return join(this.configDir, 'projects');
  }

  async list(): Promise<ClaudeStoreSession[]> {
    const sdk = await loadSdk();
    const infos = await sdk.listSessions({ includeProgrammatic: true });
    return infos.map((info) => ({
      id: info.sessionId,
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
    await sdk.renameSession(id, title);
  }

  async fork(id: string): Promise<{ sessionId: string }> {
    const sdk = await loadSdk();
    const result = await sdk.forkSession(id);
    return { sessionId: result.sessionId };
  }

  async deleteTranscript(id: string): Promise<void> {
    const sdk = await loadSdk();
    await sdk.deleteSession(id);
  }

  async listSubagents(id: string): Promise<string[]> {
    const sdk = await loadSdk();
    return sdk.listSubagents(id);
  }

  async subagentMessages(id: string, agentId: string): Promise<unknown[]> {
    const sdk = await loadSdk();
    return (await sdk.getSubagentMessages(id, agentId)) as unknown[];
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
    this.startWatch();
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
      const dirExists = existsSync(this.projectsDir);
      if (!this.watcher && !this.watchFailed && dirExists) {
        // The dir appeared after the waiting phase — try watching again.
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
        this.startWatch();
        return;
      }
      if (dirExists) this.onChange([]);
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
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.stopPoll();
  }
}
