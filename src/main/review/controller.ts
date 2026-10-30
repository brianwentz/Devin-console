// Tab Review: one `claude` pty per reviewed GitHub PR tab, keyed by tab id.
// The verdict comes from the review session's Stop hook (or its transcript),
// with the pty's exit as the backstop. Review ptys are not chat sessions: they
// skip the claudeGate handoff, every PR side effect and the generic hook
// notifications (terminalHost.reviewGate, hooks.ts onEvent).

import { randomUUID } from 'node:crypto';
import type { ClaudeHookEvent } from '../../core/claudeActivity';
import type { HostId } from '../../core/execHost';
import { reviewNotification } from '../../core/notificationModel';
import { DEFAULT_REVIEW_COMMAND } from '../../core/reviewSettings';
import { scopeOf } from '../../core/tabModel';
import {
  buildReviewPrompt,
  canonicalPrUrl,
  lastAssistantText,
  parseVerdict,
  reduceReview,
  reviewPromptArg,
  reviewRetryDelays,
  verdictSource,
  type ReviewEvent,
  type ReviewRecord,
  type ReviewStatus,
} from '../../core/tabReview';
import { claudeSessions } from '../claude/sessions';
import { hosts } from '../hosts';
import { terminalHost } from '../local/terminalHost';
import { log } from '../log';
import { notificationStore } from '../notifications';
import { state, testMode } from '../state';
import { applyLayout } from '../window';
import { resolveReviewHost } from './host';
import { ensureReviewsWorkspace } from './workspace';

/** Reviews run unattended in a strip, so they must not park on permission prompts. */
const REVIEW_PERMISSION_MODE = 'auto';

export type ReviewStartResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not-pr'
        | 'running'
        | 'distro-unavailable'
        | 'distro-stopped'
        | 'helper-not-ready'
        | 'no-claude'
        | 'spawn';
    };

type Verdict = NonNullable<ReturnType<typeof parseVerdict>>;
export type ReviewStopPayload = ClaudeHookEvent & { last_assistant_message?: string };

class ReviewController {
  private readonly records = new Map<string, ReviewRecord>();
  // Every review session id of this run — hooks stay filtered after exit.
  private readonly sessionIds = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout[]>();
  private disposed = false;

  async start(tabId: string): Promise<ReviewStartResult> {
    const tab = state.tabManager?.getTab(tabId);
    const prUrl = tab ? canonicalPrUrl(tab.url) : null;
    if (!tab || !prUrl) return this.refuse('not-pr');
    const previous = this.records.get(tabId);
    if (this.starting.has(tabId) || previous?.status === 'reviewing') return this.refuse('running');
    const host = resolveReviewHost();
    if (!host.ok) return this.refuse(host.reason);
    this.starting.add(tabId);
    try {
      if (host.start && !(await this.startDistro(host.hostId))) return this.refuse('distro-stopped');
      if (!this.claudeResolvable(host.hostId)) return this.refuse('no-claude');
      // The mkdir is an explicit exec — on a Stopped distro it is what boots it.
      const workspace = await ensureReviewsWorkspace(host.hostId);
      if (!workspace.ok) {
        if (host.start) return this.refuse('distro-stopped');
        return this.refuse(workspace.reason === 'io' ? 'spawn' : 'helper-not-ready');
      }
      if (workspace.created) claudeSessions().workspacesChanged();
      if (this.disposed) return this.refuse('spawn');
      // Re-run: the earlier pty (and any pending verdict read) goes first.
      const old = this.records.get(tabId);
      if (old) this.stopRecord(old);
      const sessionId = randomUUID();
      this.sessionIds.add(sessionId);
      const record: ReviewRecord = {
        tabId,
        sessionId,
        hostId: host.hostId,
        agent: 'claude',
        workspacePath: workspace.workspacePath,
        ptyId: null,
        prUrl,
        originScope: scopeOf(tab),
        status: 'reviewing',
        startedAt: Date.now(),
        finishedAt: null,
        terminalOpen: true,
      };
      this.records.set(tabId, record);
      const injection = claudeSessions().hookInjection(sessionId, 'new', host.hostId, REVIEW_PERMISSION_MODE);
      const opened = await terminalHost.open({
        kind: 'claude',
        mode: 'review',
        sessionId,
        hostId: host.hostId,
        cwd: workspace.cwd,
        extraArgs: [
          ...(injection?.extraArgs ?? []),
          reviewPromptArg(
            buildReviewPrompt(DEFAULT_REVIEW_COMMAND, prUrl),
            host.hostId === 'local' ? claudeSessions().claudeCliPath() : null,
          ),
        ],
        extraEnv: injection?.extraEnv ?? {},
      });
      if (!opened.ok) {
        this.update(tabId, sessionId, { type: 'exit', at: Date.now() });
        log('claude', 'review-ended', { detail: { sessionId, reason: 'exit' } });
        return this.refuse('spawn');
      }
      const current = this.records.get(tabId);
      if (this.disposed || current?.sessionId !== sessionId) {
        // The tab closed (or the app quit) while the pty spawned — nothing
        // tracks it any more, so it must not keep running. At quit the
        // taskkill teardown of terminalHost.dispose() (later in shutdown)
        // takes it instead of a plain kill.
        if (!this.disposed) terminalHost.close(opened.id, { reclaim: false });
        log('claude', 'review-ended', { detail: { sessionId, reason: 'tab-closed' } });
        return this.refuse('spawn');
      }
      this.records.set(tabId, { ...current, ptyId: opened.id });
      log('claude', 'review-start', { detail: { tabId, sessionId, host: host.hostId } });
      applyLayout();
      return { ok: true };
    } finally {
      this.starting.delete(tabId);
    }
  }

  async onStop(sessionId: string, payload: ReviewStopPayload): Promise<void> {
    if (!this.reviewing(sessionId)) return;
    const stopAt = Date.now();
    this.cancelRetries(sessionId);
    const source = verdictSource(payload);
    if (source.kind === 'payload') {
      const verdict = parseVerdict(source.text);
      if (verdict) this.applyVerdict(sessionId, verdict);
      return;
    }
    const verdict = await this.readTranscript(sessionId);
    if (verdict) {
      this.applyVerdict(sessionId, verdict);
      return;
    }
    // The read awaited: a later Stop, the exit or a close may have moved on.
    if (!this.reviewing(sessionId)) return;
    // The transcript may land after the Stop — re-read 1 s / 3 s / 7 s after
    // it; a later Stop, the pty's exit or a close cancels the schedule.
    this.cancelRetries(sessionId);
    const timers = reviewRetryDelays(Date.now() - stopAt).map((ms) => {
      const timer = setTimeout(() => void this.retryRead(sessionId), ms);
      timer.unref?.();
      return timer;
    });
    this.retryTimers.set(sessionId, timers);
  }

  async onPtyExit(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const record = this.recordFor(sessionId);
    if (!record) return;
    this.cancelRetries(sessionId);
    if (record.status === 'reviewing') {
      const verdict = await this.readTranscript(sessionId);
      if (verdict) this.applyVerdict(sessionId, verdict);
      else if (this.reviewing(sessionId)) {
        log('claude', 'review-ended', { detail: { sessionId, reason: 'exit' } });
      }
    }
    this.update(record.tabId, sessionId, { type: 'exit', at: Date.now() });
    void claudeSessions().refresh('review', [record.hostId]);
    applyLayout();
  }

  closeTerminal(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    const running = record.status === 'reviewing';
    if (running) {
      this.cancelRetries(record.sessionId);
      if (record.ptyId) terminalHost.close(record.ptyId, { reclaim: false });
      log('claude', 'review-ended', { detail: { sessionId: record.sessionId, reason: 'closed' } });
    }
    this.update(tabId, record.sessionId, { type: 'close-terminal', at: Date.now() });
    log('claude', 'review-terminal', { detail: { tabId, op: running ? 'close' : 'hide' } });
    applyLayout();
  }

  showTerminal(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record || record.terminalOpen || record.ptyId === null) return;
    this.update(tabId, record.sessionId, { type: 'show-terminal' });
    log('claude', 'review-terminal', { detail: { tabId, op: 'show' } });
    applyLayout();
  }

  /** Runs on every applyLayout — O(1) while there are no reviews. */
  reconcileTabs(liveTabIds: ReadonlySet<string>): void {
    if (this.records.size === 0) return;
    for (const [tabId, record] of this.records) {
      if (liveTabIds.has(tabId)) continue;
      this.stopRecord(record);
      // ptyId null while reviewing = mid-spawn: start() logs the end itself.
      if (record.status === 'reviewing' && record.ptyId !== null) {
        log('claude', 'review-ended', { detail: { sessionId: record.sessionId, reason: 'tab-closed' } });
      }
      this.records.delete(tabId);
    }
  }

  statusFor(tabId: string): ReviewStatus | null {
    return this.records.get(tabId)?.status ?? null;
  }

  active(tabId: string): ReviewRecord | null {
    return this.records.get(tabId) ?? null;
  }

  isReviewSession(id: string): boolean {
    return this.sessionIds.has(id);
  }

  /** The review is still working in its live pty — it is the transcript's
   * writer, so chat must not open the session. After a verdict the pty idles
   * and the session may be opened (releaseFinished ends that pty first). */
  isRunning(id: string): boolean {
    const record = this.recordFor(id);
    return record !== null && record.status === 'reviewing' && record.ptyId !== null;
  }

  /**
   * A finished review's pty still runs claude on the session — a second
   * writer once the session is opened in chat, prompted or resumed in a
   * terminal. End it first (the strip collapses with it). No-op otherwise.
   */
  releaseFinished(id: string): void {
    const record = this.recordFor(id);
    if (!record || record.status === 'reviewing' || record.ptyId === null) return;
    terminalHost.close(record.ptyId, { reclaim: false });
    this.update(record.tabId, id, { type: 'exit', at: Date.now() });
    log('claude', 'review-terminal', { detail: { tabId: record.tabId, op: 'release' } });
    applyLayout();
  }

  hooksReachable(hostId: HostId): boolean {
    if (hostId === 'local') return claudeSessions().hookInfo() !== null;
    return hosts().status(hostId)?.hooks !== 'unreachable';
  }

  /** Quit: pending reads stop; terminalHost.dispose() tears the ptys down. */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.retryTimers.keys()]) this.cancelRetries(sessionId);
  }

  private refuse(reason: Extract<ReviewStartResult, { ok: false }>['reason']): ReviewStartResult {
    log('claude', 'review-refused', { detail: { reason } });
    return { ok: false, reason };
  }

  // A Stopped review distro: the user asked for a review there, so start it.
  // shellEnv({explicit}) probes a distro never probed this run (the probe's
  // `wsl.exe -d` boots it) and re-reads the table afterwards; the probe yields
  // the home, the claude path and the hook reachability. No home = it could
  // not be started.
  private async startDistro(hostId: HostId): Promise<boolean> {
    const host = hosts().hostById(hostId);
    if (!host) return false;
    try {
      await hosts().shellEnv(host, { explicit: true });
    } catch {
      return false;
    }
    return Boolean(hosts().status(hostId)?.home);
  }

  // Local: the resolved claude binary — in test mode the fake pty command
  // stands in for a PATH lookup, but a configured claude.path must exist.
  // WSL: the probe's CLI path.
  private claudeResolvable(hostId: HostId): boolean {
    if (hostId !== 'local') return Boolean(hosts().status(hostId)?.claude.path);
    if (claudeSessions().claudeCliPath()) return true;
    return (
      testMode &&
      !state.settings?.current.claude.path &&
      Boolean(process.env.AGENT_WORKSPACE_TEST_TERMINAL_CMD)
    );
  }

  private recordFor(sessionId: string): ReviewRecord | null {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return null;
  }

  private reviewing(sessionId: string): boolean {
    return !this.disposed && this.recordFor(sessionId)?.status === 'reviewing';
  }

  private update(tabId: string, sessionId: string, event: ReviewEvent): void {
    const record = this.records.get(tabId);
    if (record?.sessionId === sessionId) this.records.set(tabId, reduceReview(record, event));
  }

  private stopRecord(record: ReviewRecord): void {
    this.cancelRetries(record.sessionId);
    if (record.ptyId) terminalHost.close(record.ptyId, { reclaim: false });
  }

  private async readTranscript(sessionId: string): Promise<Verdict | null> {
    const record = this.recordFor(sessionId);
    if (!record) return null;
    try {
      const text = lastAssistantText(await claudeSessions().messagesOn(record.hostId, sessionId));
      return text ? parseVerdict(text) : null;
    } catch (error) {
      const code =
        (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.name : 'unknown');
      log('claude', 'review-verdict-read-error', { detail: { code: String(code) } });
      return null;
    }
  }

  private async retryRead(sessionId: string): Promise<void> {
    if (!this.reviewing(sessionId)) return;
    const verdict = await this.readTranscript(sessionId);
    if (verdict) {
      this.cancelRetries(sessionId);
      this.applyVerdict(sessionId, verdict);
    }
  }

  private cancelRetries(sessionId: string): void {
    for (const timer of this.retryTimers.get(sessionId) ?? []) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
  }

  private applyVerdict(sessionId: string, verdict: Verdict): void {
    const record = this.recordFor(sessionId);
    if (!record || record.status !== 'reviewing' || this.disposed) return;
    const now = Date.now();
    this.records.set(record.tabId, reduceReview(record, { type: 'verdict', verdict: verdict.verdict, at: now }));
    log('claude', 'review-verdict', {
      detail: { sessionId, verdict: verdict.verdict, via: verdict.via, ms: now - record.startedAt },
    });
    const notifications = state.settings?.current.notifications;
    if ((notifications?.collect ?? true) && (notifications?.kinds.review ?? true)) {
      notificationStore().add(reviewNotification(record, verdict.verdict, now));
    }
    void claudeSessions().refresh('review', [record.hostId]);
    applyLayout();
  }
}

let controller: ReviewController | null = null;

export function reviews(): ReviewController {
  controller ??= new ReviewController();
  return controller;
}
