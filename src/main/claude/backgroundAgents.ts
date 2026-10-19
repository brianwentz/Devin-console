// Background-agent poller: `claude agents --json --all` on a focus-aware
// cadence (15 s focused / 60 s unfocused, plus an immediate poll on focus and
// after stop). Output parses through the tolerant core/claudeAgents.ts
// parser — the item shape comes from `claude agents --json --all` output
// (docs/evidence/claude-agents-probe.json). Logs counts only.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeAgent } from '../../shared/ipc';
import { parseAgentsJson } from '../../core/claudeAgents';
import { log } from '../log';
import { state, testMode } from '../state';
import { resolveClaudePath } from './claudePath';

const execFileAsync = promisify(execFile);

const FOCUSED_MS = 15_000;
const UNFOCUSED_MS = 60_000;

function pollMs(): number {
  if (testMode && process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_POLL_MS) {
    const ms = Math.max(50, Number(process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_POLL_MS) || 0);
    return ms;
  }
  return state.windowRef?.isFocused() ? FOCUSED_MS : UNFOCUSED_MS;
}

export class ClaudeBackgroundAgents {
  private readonly cliPath: () => string | null;
  private readonly onChange: (agents: ClaudeAgent[]) => void;
  private agents: ClaudeAgent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private dirty: 'timer' | 'focus' | 'manual' | 'mutate' | null = null;
  private running = false;

  constructor(opts: {
    cliPath: () => string | null;
    onChange: (agents: ClaudeAgent[]) => void;
  }) {
    this.cliPath = opts.cliPath;
    this.onChange = opts.onChange;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.refresh('timer');
  }

  dispose(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  list(): ClaudeAgent[] {
    return this.agents;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh('timer');
    }, pollMs());
    this.timer.unref?.();
  }

  onWindowFocus(): void {
    if (this.running && !this.inFlight) void this.refresh('focus');
  }

  async refresh(
    source: 'timer' | 'focus' | 'manual' | 'mutate',
  ): Promise<void> {
    if (this.inFlight) {
      this.dirty = source;
      return;
    }
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const cli =
        (testMode && process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD?.trim()) ||
        this.cliPath() ||
        resolveClaudePath(state.settings?.current.claude.path ?? null);
      if (!cli) {
        log('claude', 'claude-agents', {
          detail: { count: -1, running: 0, ms: Date.now() - t0, source },
        });
        this.schedule();
        return;
      }
      const [file, ...prefixArgs] = testMode &&
        process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD
          ? process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD.split(/\s+/).filter(Boolean)
          : [cli];
      const { stdout } = await execFileAsync(
        file!,
        [...prefixArgs, 'agents', '--json', '--all'],
        { timeout: 5_000, windowsHide: true },
      );
      const { agents, unknownKeys } = parseAgentsJson(stdout);
      this.agents = agents;
      if (unknownKeys.length > 0) {
        log('claude', 'claude-agents-parse', {
          detail: { count: agents.length, unknownKeys },
        });
      }
      log('claude', 'claude-agents', {
        detail: {
          count: agents.length,
          running: agents.filter((a) => a.status === 'running').length,
          ms: Date.now() - t0,
          source,
        },
      });
      this.onChange(agents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('claude', 'claude-agents-error', {
        detail: { message: message.slice(0, 200) },
      });
    } finally {
      this.inFlight = false;
      if (this.dirty) {
        const next = this.dirty;
        this.dirty = null;
        void this.refresh(next);
      } else {
        this.schedule();
      }
    }
  }

  async stop(agentId: string): Promise<void> {
    const cli =
      (testMode && process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD?.trim()) ||
      this.cliPath() ||
      resolveClaudePath(state.settings?.current.claude.path ?? null);
    if (!cli) return;
    const [file, ...prefixArgs] = testMode &&
      process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD
        ? process.env.DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD.split(/\s+/).filter(Boolean)
        : [cli];
    let ok = true;
    try {
      await execFileAsync(file!, [...prefixArgs, 'stop', agentId], {
        timeout: 3_000,
        windowsHide: true,
      });
    } catch {
      ok = false;
    }
    log('claude', 'claude-agent-stop', { detail: { agentId, ok } });
    await this.refresh('mutate');
  }
}
