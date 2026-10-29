// Tab Review: one `claude` pty per reviewed GitHub PR tab, keyed by tab id.
// The verdict comes from the review session's Stop hook (or its transcript),
// with the pty's exit as the backstop. Review ptys are not chat sessions: they
// skip the claudeGate handoff, every PR side effect and the generic hook
// notifications (terminalHost.reviewGate, hooks.ts onEvent).

import { randomUUID } from 'node:crypto';
import type { ClaudeHookEvent } from '../../core/claudeActivity';
import type { HostId } from '../../core/execHost';
import { reviewNotification } from '../../core/notificationModel';
import { scopeOf } from '../../core/tabModel';
import {
  REVIEW_VERDICT_RETRY_MS,
  buildReviewPrompt,
  canonicalPrUrl,
  lastAssistantText,
  parseVerdict,
  reduceReview,
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
import { notifyShell } from '../window';
import { resolveReviewHost } from './host';
import { ensureReviewsWorkspace } from './workspace';

export type ReviewStartResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-pr' | 'running' | 'distro-unavailable' | 'helper-not-ready' | 'no-claude' | 'spawn';
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
    if (!this.claudeResolvable(host.hostId)) return this.refuse('no-claude');
    this.starting.add(tabId);
    try {
      const workspace = await ensureReviewsWorkspace(host.hostId);
      if (!workspace.ok) {
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
        ptyId: null,
        prUrl,
        originScope: scopeOf(tab),
        status: 'reviewing',
        startedAt: Date.now(),
        finishedAt: null,
        terminalOpen: true,
      };
      this.records.set(tabId, record);
      const injection = claudeSessions().hookInjection(sessionId, 'new', host.hostId);
      const opened = await terminalHost.open({
        kind: 'claude',
        mode: 'review',
        sessionId,
        hostId: host.hostId,
        cwd: workspace.cwd,
        extraArgs: [...(injection?.extraArgs ?? []), buildReviewPrompt(prUrl)],
        extraEnv: injection?.extraEnv ?? {},
      });
      if (!opened.ok) {
        this.update(tabId, sessionId, { type: 'exit', at: Date.now() });
        log('claude', 'review-ended', { detail: { sessionId, reason: 'exit' } });
        return this.refuse('spawn');
      }
      const current = this.records.get(tabId);
      if (current?.sessionId === sessionId) this.records.set(tabId, { ...current, ptyId: opened.id });
      log('claude', 'review-start', { detail: { tabId, sessionId, host: host.hostId } });
      notifyShell();
      return { ok: true };
    } finally {
      this.starting.delete(tabId);
    }
  }

  async onStop(sessionId: string, payload: ReviewStopPayload): Promise<void> {
    if (!this.reviewing(sessionId)) return;
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
    // The transcript may land after the Stop — re-read on a fixed schedule;
    // a later Stop, the pty's exit or a close cancels it.
    const timers = REVIEW_VERDICT_RETRY_MS.map((ms) => {
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
    notifyShell();
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
    notifyShell();
  }

  showTerminal(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record || record.terminalOpen) return;
    this.update(tabId, record.sessionId, { type: 'show-terminal' });
    log('claude', 'review-terminal', { detail: { tabId, op: 'show' } });
    notifyShell();
  }

  /** Runs on every applyLayout — O(1) while there are no reviews. */
  reconcileTabs(liveTabIds: ReadonlySet<string>): void {
    if (this.records.size === 0) return;
    for (const [tabId, record] of this.records) {
      if (liveTabIds.has(tabId)) continue;
      this.stopRecord(record);
      if (record.status === 'reviewing') {
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

  /** The review pty for this session is alive — it is the transcript's writer. */
  isRunning(id: string): boolean {
    const record = this.recordFor(id);
    return record !== null && record.ptyId !== null;
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
    notifyShell();
  }
}

let controller: ReviewController | null = null;

export function reviews(): ReviewController {
  controller ??= new ReviewController();
  return controller;
}
