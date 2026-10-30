// Tab Review: one `claude` or `devin` pty per reviewed GitHub PR tab, keyed by
// tab id. A Claude verdict comes from the review session's Stop hook (or its
// transcript), a Devin verdict from the pty output (ReviewOutputScanner); the
// pty's exit is the backstop for both. Review ptys are not chat sessions: they
// skip the claudeGate handoff, every PR side effect and the generic hook
// notifications (terminalHost.reviewGate, hooks.ts onEvent).

import { randomUUID } from 'node:crypto';
import type { ClaudeHookEvent } from '../../core/claudeActivity';
import type { HostId } from '../../core/execHost';
import { reviewNotification } from '../../core/notificationModel';
import { ReviewOutputScanner } from '../../core/reviewOutput';
import { scopeOf } from '../../core/tabModel';
import {
  buildReviewPrompt,
  canonicalPrUrl,
  finishedDevinReviewsIn,
  lastAssistantText,
  parseVerdict,
  reduceReview,
  reviewPromptArg,
  reviewRetryDelays,
  verdictSource,
  type ReviewEvent,
  type ReviewRecord,
  type ReviewRefusalReason,
  type ReviewStatus,
  type ReviewVerdict,
} from '../../core/tabReview';
import { claudeSessions } from '../claude/sessions';
import { hosts } from '../hosts';
import { resolveDevinPath } from '../local/acpHost';
import { terminalHost } from '../local/terminalHost';
import { log } from '../log';
import { notificationStore } from '../notifications';
import { state, testMode } from '../state';
import { applyLayout } from '../window';
import { resolveReviewHost } from './host';
import { ensureReviewWorkspace } from './workspace';

export type ReviewStartResult = { ok: true } | { ok: false; reason: ReviewRefusalReason };

/** A Devin verdict settles once the pty has been quiet this long after a
 * committed marker (the TUI may still redraw — the last marker wins). */
const PTY_VERDICT_QUIET_MS = 2000;

/** Upper bound on waiting for released review ptys to exit before a load. */
const RELEASE_EXIT_CAP_MS = 3000;

type Verdict = { verdict: ReviewVerdict; via: 'marker' | 'assessment' | 'pty' };
export type ReviewStopPayload = ClaudeHookEvent & { last_assistant_message?: string };

class ReviewController {
  private readonly records = new Map<string, ReviewRecord>();
  // Every review session id of this run — hooks stay filtered after exit.
  private readonly sessionIds = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout[]>();
  // Devin reviews: the pty-output scanner and its quiescence timer, by session id.
  private readonly scanners = new Map<string, ReviewOutputScanner>();
  private readonly quietTimers = new Map<string, NodeJS.Timeout>();
  // Resolvers of releaseFinishedInWorkspace, by session id � fired on pty exit.
  private readonly exitWaiters = new Map<string, () => void>();
  private disposed = false;

  async start(tabId: string): Promise<ReviewStartResult> {
    const tab = state.tabManager?.getTab(tabId);
    const prUrl = tab ? canonicalPrUrl(tab.url) : null;
    if (!tab || !prUrl) return this.refuse('not-pr');
    const previous = this.records.get(tabId);
    if (this.starting.has(tabId) || previous?.status === 'reviewing') return this.refuse('running');
    const review = state.settings?.current.review;
    if (!review) return this.refuse('spawn');
    const agent = review.agent;
    const host = resolveReviewHost();
    if (!host.ok) return this.refuse(host.reason);
    this.starting.add(tabId);
    try {
      if (host.start && !(await this.startDistro(host.hostId))) return this.refuse('distro-stopped');
      if (agent === 'claude' && !this.claudeResolvable(host.hostId)) return this.refuse('no-claude');
      if (agent === 'devin' && !this.devinResolvable(host.hostId)) return this.refuse('no-devin');
      // The mkdir is an explicit exec — on a Stopped distro it is what boots it.
      // After the resolvability checks, so a refusal pins no workspace.
      const workspace = await ensureReviewWorkspace(host.hostId, agent, review.cwd);
      if (!workspace.ok) {
        if (workspace.reason === 'cwd-missing') return this.refuse('cwd-missing');
        if (host.start) return this.refuse('distro-stopped');
        return this.refuse(workspace.reason === 'io' ? 'spawn' : 'helper-not-ready');
      }
      if (workspace.created && agent === 'claude') claudeSessions().workspacesChanged();
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
        agent,
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
      const prompt = buildReviewPrompt(review.command, prUrl);
      let extraArgs: string[];
      let extraEnv: Record<string, string>;
      if (agent === 'devin') {
        // The review id stays ours: the CLI picks its own session id. No Claude
        // hook injection — the verdict comes from the pty output.
        this.scanners.set(sessionId, new ReviewOutputScanner());
        const devinBinary = host.hostId === 'local' ? this.localDevinPath() : null;
        extraArgs = ['--permission-mode', review.devinMode, '--', reviewPromptArg(prompt, devinBinary)];
        extraEnv = {};
      } else {
        const injection = claudeSessions().hookInjection(sessionId, 'new', host.hostId, review.claudeMode);
        extraArgs = [
          ...(injection?.extraArgs ?? []),
          reviewPromptArg(prompt, host.hostId === 'local' ? claudeSessions().claudeCliPath() : null),
        ];
        extraEnv = injection?.extraEnv ?? {};
      }
      const opened = await terminalHost.open({
        kind: 'claude',
        mode: 'review',
        agent,
        sessionId,
        hostId: host.hostId,
        cwd: workspace.cwd,
        extraArgs,
        extraEnv,
      });
      if (!opened.ok) {
        this.clearScanner(sessionId);
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
      log('claude', 'review-start', { detail: { tabId, sessionId, host: host.hostId, agent } });
      applyLayout();
      return { ok: true };
    } finally {
      this.starting.delete(tabId);
    }
  }

  async onStop(sessionId: string, payload: ReviewStopPayload): Promise<void> {
    // Devin reviews read their verdict from the pty, never from a Claude hook.
    if (!this.reviewing(sessionId) || this.recordFor(sessionId)?.agent !== 'claude') return;
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
    this.exitWaiters.get(sessionId)?.();
    if (this.disposed) return;
    const record = this.recordFor(sessionId);
    if (!record) return;
    this.cancelRetries(sessionId);
    if (record.agent === 'devin') {
      // Settle first (the carried tail counts at exit); never a transcript read.
      const scanner = this.scanners.get(sessionId);
      this.clearScanner(sessionId);
      if (record.status === 'reviewing') {
        scanner?.flush();
        const verdict = scanner?.settle() ?? null;
        if (verdict) this.applyVerdict(sessionId, { verdict, via: 'pty' });
        else log('claude', 'review-ended', { detail: { sessionId, reason: 'exit' } });
      }
    } else if (record.status === 'reviewing') {
      const verdict = await this.readTranscript(sessionId);
      if (verdict) this.applyVerdict(sessionId, verdict);
      else if (this.reviewing(sessionId)) {
        log('claude', 'review-ended', { detail: { sessionId, reason: 'exit' } });
      }
    }
    this.update(record.tabId, sessionId, { type: 'exit', at: Date.now() });
    if (record.agent === 'claude') void claudeSessions().refresh('review', [record.hostId]);
    applyLayout();
  }

  closeTerminal(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    const running = record.status === 'reviewing';
    if (running) {
      this.cancelRetries(record.sessionId);
      this.clearScanner(record.sessionId);
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

  /**
   * Devin reviews: the CLI picks its own session id, so it is unknown here �
   * loading any session in the review workspace first releases the finished
   * reviews' idle ptys there. Resolves once each pty has exited (3 s cap total).
   */
  async releaseFinishedInWorkspace(workspacePath: string): Promise<void> {
    const ids = finishedDevinReviewsIn(this.records.values(), workspacePath);
    if (ids.length === 0) return;
    const exits = ids.map((id) => new Promise<void>((resolve) => this.exitWaiters.set(id, resolve)));
    for (const id of ids) this.releaseFinished(id);
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RELEASE_EXIT_CAP_MS);
    });
    try {
      await Promise.race([Promise.all(exits), cap]);
    } finally {
      clearTimeout(timer);
      for (const id of ids) this.exitWaiters.delete(id);
    }
  }

  /**
   * A flushed chunk of a review pty's output (the data is never logged). Devin
   * reviews only: a committed marker (re)arms the quiescence timer, which
   * settles the verdict. Called unguarded from terminalHost — never throws.
   */
  onPtyOutput(id: string, data: string): void {
    try {
      const scanner = this.scanners.get(id);
      if (!scanner || !this.reviewing(id) || !scanner.scan(data)) return;
      const previous = this.quietTimers.get(id);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.quietTimers.delete(id);
        const verdict = this.scanners.get(id)?.settle() ?? null;
        if (verdict) this.applyVerdict(id, { verdict, via: 'pty' });
      }, PTY_VERDICT_QUIET_MS);
      timer.unref?.();
      this.quietTimers.set(id, timer);
    } catch (error) {
      log('claude', 'review-output-error', {
        detail: { code: error instanceof Error ? error.name : 'unknown' },
      });
    }
  }

  hooksReachable(hostId: HostId): boolean {
    if (hostId === 'local') return claudeSessions().hookInfo() !== null;
    return hosts().status(hostId)?.hooks !== 'unreachable';
  }

  /** Quit: pending reads stop; terminalHost.dispose() tears the ptys down. */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.retryTimers.keys()]) this.cancelRetries(sessionId);
    for (const sessionId of [...this.scanners.keys()]) this.clearScanner(sessionId);
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

  // Local: the resolved devin binary (local.devinPath, else PATH) — in test mode
  // the fake pty command stands in unless AGENT_WORKSPACE_TEST_REVIEW_NO_DEVIN=1.
  // WSL: the probe's CLI path.
  private devinResolvable(hostId: HostId): boolean {
    if (testMode && process.env.AGENT_WORKSPACE_TEST_TERMINAL_CMD) {
      return process.env.AGENT_WORKSPACE_TEST_REVIEW_NO_DEVIN !== '1';
    }
    if (hostId !== 'local') return Boolean(hosts().status(hostId)?.devin.path);
    return this.localDevinPath() !== null;
  }

  private localDevinPath(): string | null {
    return resolveDevinPath(state.settings?.current.local.devinPath);
  }

  private clearScanner(sessionId: string): void {
    const timer = this.quietTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.quietTimers.delete(sessionId);
    this.scanners.delete(sessionId);
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
    this.clearScanner(record.sessionId);
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
    if (record.agent === 'claude') void claudeSessions().refresh('review', [record.hostId]);
    applyLayout();
  }
}

let controller: ReviewController | null = null;

export function reviews(): ReviewController {
  controller ??= new ReviewController();
  return controller;
}
