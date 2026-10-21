import { notificationStore } from './notifications';
import { allOpenPullRequests } from './prs';
import { deriveNotifications } from '../core/notificationModel';
import { DevinApiClient, DevinApiError, sanitizeMessage } from '../core/devinApi';
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  archivedScopes,
  backoffMs,
  catchUpPullRequests,
  newPullRequests,
  openPullRequests,
  pollInterval,
} from '../core/notifyModel';
import { visiblePrs } from '../core/prPanelModel';
import { sessionUrl } from '../core/sessions';
import { confirmIdentity, type IdentitySource } from '../core/identityModel';
import type { SessionPr, Settings } from '../shared/ipc';
import { identityResolver } from './identity';
import { prLedger } from './prLedger';
import { log } from './log';
import { route } from '../core/linkRouter';
import { prStore } from './prs';
import { prTitles } from './prTitles';
import { handleLink, loadInDevinView, routeContext } from './routing';
import { claudeSessions } from './claude/sessions';
import { claudeScope } from '../core/tabModel';
import { state, testMode } from './state';
import { installUpdate } from './updater';
import { refreshAnalyticsView } from './analytics';
import {
  activateWindow,
  applyLayout,
  focusContents,
  notifyShell,
  setNotificationsPanel,
  setPrsPanel,
} from './window';

const PAGE_SIZE = 100;

function kindEnabled() {
  const k = state.settings?.current.notifications.kinds;
  return {
    waiting: k?.waiting ?? true,
    approval: k?.approval ?? true,
    blocked: k?.blocked ?? true,
    finished: k?.finished ?? false,
    'pr-opened': k?.prOpened ?? true,
    'pr-completed': k?.prCompleted ?? true,
    update: k?.update ?? true,
    identity: true,
    auth: true,
    usage: k?.usage ?? true,
  };
}

// Test-only overrides: a short poll interval and a fixture API base.
function pollBase(): { active: number; idle: number } {
  if (testMode && process.env.AGENT_WORKSPACE_POLL_MS) {
    const ms = Math.max(50, Number(process.env.AGENT_WORKSPACE_POLL_MS) || 0);
    return { active: ms, idle: ms };
  }
  return { active: ACTIVE_POLL_MS, idle: IDLE_POLL_MS };
}

export function apiBase(): string {
  if (testMode && process.env.AGENT_WORKSPACE_API_BASE) return process.env.AGENT_WORKSPACE_API_BASE;
  return state.settings?.current.apiBase ?? 'https://api.devin.ai';
}

// P6: the poller runs whenever a token is present — the session list feeds
// notifications, PR quick-open and archived-scope cleanup regardless.
// autoOpenTabs only controls tab opening, not polling.
function autoOpenEnabled(): boolean {
  return state.settings?.current.prs.autoOpenTabs ?? true;
}

class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private running = false;
  private failures = 0;
  private orgId: string | null = null;
  private userId: string | null = null;
  private identitySource: IdentitySource | null = null;
  private identityConfirmed = false;
  private identityNotified = false;
  private authNotified = false;
  private observedSessionIds = new Set<string>();
  private orgMismatchLogged = false;
  private pollAgain = false;
  private pendingSessionId: string | null = null;
  private generation = 0;
  private notBefore = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    log('shell', 'notifier-start', {
      detail: {
        collect: state.settings?.current.notifications.collect ?? true,
        autoOpenTabs: autoOpenEnabled(),
        hasToken: state.secrets?.hasPat() ?? false,
      },
    });
    this.schedule(0);
  }

  stop(reason = 'stop'): void {
    if (!this.running && !this.timer) return;
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log('shell', 'notifier-stop', { detail: { reason } });
  }

  // Token or settings changed: forget cached org/snapshot and poll again now.
  restart(reason: string): void {
    this.stop(reason);
    this.orgId = null;
    this.userId = null;
    this.identitySource = null;
    this.identityConfirmed = false;
    this.identityNotified = false;
    this.authNotified = false;
    this.observedSessionIds.clear();
    this.orgMismatchLogged = false;
    this.pollAgain = false;
    this.pendingSessionId = null;
    this.failures = 0;
    this.notBefore = 0;
    state.apiSessions = [];
    state.notifications = {
      lastPollAt: null,
      authError: false,
      lastError: null,
      noUserIdentity: false,
      identity: { source: null, resolved: false },
    };
    identityResolver().resetGeneration();
    this.start();
    // Re-observe the session the devin view is already on — a token/settings
    // change shouldn't lose the inference signal for it.
    if (state.currentSessionId) this.pendingSessionId = state.currentSessionId;
    notifyShell();
  }

  onSettingsChanged(previous: Settings, next: Settings): void {
    if (
      previous.apiBase !== next.apiBase ||
      previous.notifications.orgId !== next.notifications.orgId ||
      previous.notifications.userId !== next.notifications.userId ||
      previous.local.devinPath !== next.local.devinPath
    ) {
      this.restart('settings-changed');
    }
  }

  // Service-user identity inference: when the devin view navigates to a
  // session while we have no user id yet, fetch that session and feed its
  // user_id/created_at into the observation list.
  onSessionChanged(sessionId: string | null): void {
    if (!sessionId || this.userId !== null) return;
    const pat = state.secrets?.getPat() ?? null;
    if (!pat) return;
    // orgId not resolved yet (first poll still in flight): remember the
    // session and observe it once poll() has an org id.
    if (!this.orgId) {
      this.pendingSessionId = sessionId;
      return;
    }
    if (this.observedSessionIds.has(sessionId)) return;
    this.observedSessionIds.add(sessionId);
    const client = new DevinApiClient({
      apiBase: apiBase(),
      token: pat,
      fetch: (url, init) => fetch(url, { ...init, signal: init.signal ?? null }),
    });
    const orgId = this.orgId;
    void client
      .getSession(orgId, sessionId)
      .then((session) => {
        const resolved = identityResolver().observe(sessionId, {
          user_id: session.user_id,
          created_at: session.created_at,
        });
        if (resolved) {
          // A poll may be in flight — flag a follow-up so the resolved
          // identity is picked up immediately, not on the idle schedule.
          this.pollAgain = true;
          void this.poll();
        }
      })
      .catch((error: unknown) => {
        const apiError = error instanceof DevinApiError ? error : null;
        if (apiError?.status === 404) return;
        log('shell', 'identity-observe-error', {
          detail: { kind: apiError?.kind ?? 'unknown', status: apiError?.status ?? null },
        });
      });
  }

  pollNow(): Promise<void> {
    return this.poll();
  }

  // Regaining focus while the poller is in error: drop the backoff and poll
  // now so a recovered API (or replaced token) is noticed immediately.
  onWindowFocus(): void {
    if (!this.running || this.inFlight) return;
    if (!state.notifications.authError && this.failures <= 0) return;
    this.notBefore = 0;
    this.failures = 0;
    log('shell', 'notifier-focus-poll');
    void this.poll();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.inFlight || !this.running || state.shuttingDown) return;
    const pat = state.secrets?.getPat() ?? null;
    if (!pat) {
      // Nothing to do; re-check occasionally in case a token arrives via restart().
      this.schedule(pollBase().idle);
      return;
    }
    const now = Date.now();
    if (now < this.notBefore) {
      this.schedule(this.notBefore - now);
      return;
    }
    this.inFlight = true;
    this.pollAgain = false;
    const base = pollBase();
    let delay = base.idle;
    const started = Date.now();
    try {
      const client = new DevinApiClient({
        apiBase: apiBase(),
        token: pat,
        fetch: (url, init) => fetch(url, { ...init, signal: init.signal ?? null }),
      });
      if (!this.orgId) {
        const override = state.settings?.current.notifications.orgId?.trim();
        const self = await client.getSelf();
        if (self.userId) {
          this.userId = self.userId;
          this.identitySource = 'self';
          this.identityConfirmed = true;
          identityResolver().setSelfIdentity(self.userId);
        }
        // First poll of this identity resolution: drop persisted entries that
        // were derived for a different token user (or a pre-owner build).
        notificationStore().reconcile(this.userId);
        log('shell', 'notifier-self', {
          detail: { principalType: self.principalType, hasUserId: self.userId !== null },
        });
        this.orgId = override || self.orgId;
        if (!this.orgId) {
          throw new DevinApiError('http', 'no org id for this token (set notifications.orgId)', {
            op: 'self',
          });
        }
        log('shell', 'notifier-org', { detail: { source: override ? 'settings' : 'self' } });
        // Observe the session the devin view was already on when this poll ran.
        if (this.pendingSessionId) {
          const pending = this.pendingSessionId;
          this.pendingSessionId = null;
          this.onSessionChanged(pending);
        }
      }
      // Service-user token: resolve the signed-in user (manual → CLI →
      // persisted → inferred). Retried every poll while unresolved — cheap
      // because the CLI result is cached per generation.
      if (this.userId === null) {
        const resolved = await identityResolver().resolve({
          manualUserId: state.settings?.current.notifications.userId ?? '',
          devinPathOverride: state.settings?.current.local.devinPath,
        });
        if (resolved) {
          this.userId = resolved.userId;
          this.identitySource = resolved.source;
          this.identityConfirmed = resolved.source === 'manual';
          notificationStore().reconcile(this.userId);
        }
        // Once per generation: does the CLI's primary org match the token's?
        const cliOrg = identityResolver().cliOrgId();
        if (cliOrg && !this.orgMismatchLogged) {
          this.orgMismatchLogged = true;
          const matches = cliOrg === this.orgId;
          identityResolver().setCliOrgMismatch(!matches);
          log('shell', 'notifier-org-mismatch', { detail: { cliMatchesToken: matches } });
        }
      }
      if (!this.userId) {
        // Service-user token with no resolvable identity: "my sessions" is empty.
        state.apiSessions = [];
        state.notifications = {
          lastPollAt: new Date().toISOString(),
          authError: false,
          lastError: null,
          noUserIdentity: true,
          identity: { source: null, resolved: false },
        };
        if (!this.identityNotified) {
          this.identityNotified = true;
          notificationStore().add({
            kind: 'identity',
            sessionId: null,
            ownerUserId: null,
            sessionTitle: 'Agent Workspace',
            title: 'Could not determine your user',
            body: 'Could not determine your user — sign in with the Devin CLI (devin auth login) or set your user id in Settings.',
            createdAt: Date.now(),
          });
        }
        delay = base.idle;
        log('shell', 'poll', { detail: { sessions: 0, noUserIdentity: true } });
        return;
      }
      const page = await client.listSessions({
        orgId: this.orgId,
        first: PAGE_SIZE,
        userIds: [this.userId],
      });
      // First poll after a cli/inferred resolution must confirm the id: a
      // matching session, or a genuinely idle user (empty single page).
      if (!this.identityConfirmed && !confirmIdentity(this.userId, page)) {
        const rejectedSource = this.identitySource;
        if (rejectedSource) identityResolver().reject(rejectedSource);
        this.userId = null;
        this.identitySource = null;
        state.apiSessions = [];
        state.notifications = {
          lastPollAt: new Date().toISOString(),
          authError: false,
          lastError: null,
          noUserIdentity: true,
          identity: { source: null, resolved: false },
        };
        delay = 0;
        log('shell', 'poll', { detail: { sessions: 0, noUserIdentity: true, rejected: true } });
        return;
      }
      this.identityConfirmed = true;
      // Defensive: keep only the token user's sessions even if the server
      // ignores user_ids.
      const sessions = page.sessions.filter((session) => session.user_id === this.userId);
      this.failures = 0;
      this.authNotified = false;
      // P8/Q3: close tabs whose session archived, or vanished from a complete
      // (single-page) list — a partial page can't prove absence.
      const previousSessions = state.apiSessions;
      state.apiSessions = sessions;
      prStore().reconcile(allOpenPullRequests(), Date.now());
      for (const scope of archivedScopes(previousSessions, sessions, !page.hasNextPage)) {
        void state.tabManager?.closeScope(scope).then(() => {
          log('shell', 'tabs-scope-archived', { detail: { scope } });
        });
      }
      // F1: a session gained a PR since the last poll -> lazy background tab
      // in that session's scope. Only GitHub-class URLs become tabs. A baseline
      // poll (restart/outage) diffs against the persisted ledger instead, so
      // PRs that appeared while the poller was down still open once.
      if (autoOpenEnabled() && state.tabManager) {
        const baseline = previousSessions.length === 0;
        const candidates = baseline
          ? catchUpPullRequests(sessions, prLedger().seen(), {
              lastGoodAt: prLedger().lastGoodAt(),
              now: Date.now(),
            })
          : newPullRequests(previousSessions, sessions);
        if (baseline && candidates.length > 0) {
          log('shell', 'pr-catch-up', {
            detail: { count: candidates.length, lastGoodAgeMs: Date.now() - prLedger().lastGoodAt() },
          });
        }
        let opened = 0;
        for (const pr of candidates) {
          const decision = route(pr.url, 'shell', 'new-window', routeContext());
          if (decision.kind !== 'gh-tab') continue;
          state.tabManager.open(pr.url, {
            background: true,
            originSessionId: pr.sessionId,
            lazy: true,
          });
          log('shell', 'pr-auto-open', {
            url: pr.url,
            detail: { sessionId: pr.sessionId, catchUp: baseline },
          });
          opened += 1;
        }
        if (opened > 0) applyLayout();
      }
      // Every successful poll feeds the ledger — lastGoodAt tracks poller
      // health regardless of the autoOpenTabs toggle.
      prLedger().record(
        sessions.flatMap((session) => session.pull_requests.map((pr) => pr.pr_url)),
        Date.now(),
      );
      // P6: derive in-app notifications from the session diff (baseline =
      // sessions absent from the previous poll).
      if (state.settings?.current.notifications.collect ?? true) {
        for (const entry of deriveNotifications(previousSessions, sessions, {
          enabled: kindEnabled(),
          now: Date.now(),
          ownerUserId: this.userId,
        })) {
          notificationStore().add(entry);
        }
      }
      prTitles.ensure(openPullRequests(sessions).map((pr) => pr.url));
      state.notifications = {
        lastPollAt: new Date().toISOString(),
        authError: false,
        lastError: null,
        noUserIdentity: false,
        identity: { source: this.identitySource, resolved: true },
      };
      delay = pollInterval(sessions, base);
      log('shell', 'poll', {
        detail: {
          sessions: sessions.length,
          hasNextPage: page.hasNextPage,
          intervalMs: delay,
          durationMs: Date.now() - started,
        },
      });
    } catch (error) {
      this.failures += 1;
      const apiError = error instanceof DevinApiError ? error : null;
      const kind = apiError?.kind ?? 'unknown';
      if (kind === 'auth' || kind === 'forbidden') {
        state.notifications = {
          ...state.notifications,
          authError: true,
          lastError: kind === 'auth' ? 'unauthorized' : 'forbidden',
        };
        if (!this.authNotified) {
          this.authNotified = true;
          notificationStore().add({
            kind: 'auth',
            sessionId: null,
            ownerUserId: null,
            sessionTitle: 'Agent Workspace',
            title: 'Devin API token rejected',
            body:
              kind === 'forbidden'
                ? 'The API returned 403 Forbidden for this token — PR tabs and notifications are paused. Check the token in Settings (it must be a Devin v3 personal API token).'
                : 'The API returned 401 Unauthorized for this token — PR tabs and notifications are paused. Check the token in Settings.',
            createdAt: Date.now(),
          });
        }
        // Do not clear a stale orgId/snapshot on auth errors; just slow down.
        delay = Math.max(base.idle, backoffMs(this.failures, base.active));
      } else if (kind === 'rateLimited') {
        const retryAfter = apiError?.retryAfterMs ?? null;
        delay = Math.max(retryAfter ?? backoffMs(this.failures, base.active), base.active);
        this.notBefore = Date.now() + delay;
        state.notifications = { ...state.notifications, lastError: 'rate limited' };
      } else {
        delay = backoffMs(this.failures, base.active);
        state.notifications = {
          ...state.notifications,
          lastError: sanitizeMessage(apiError?.message ?? String(error), pat),
        };
      }
      log('shell', 'poll-error', {
        detail: {
          kind,
          op: apiError?.op ?? null,
          status: apiError?.status ?? null,
          retryAfterMs: apiError?.retryAfterMs ?? null,
          failures: this.failures,
          nextInMs: delay,
          message: sanitizeMessage(apiError?.message ?? String(error), pat),
        },
      });
    } finally {
      this.inFlight = false;
      notifyShell();
      if (this.pollAgain) {
        this.pollAgain = false;
        this.schedule(0);
      } else {
        this.schedule(delay);
      }
    }
  }

}

export const notifier = new Notifier();

// Visible (open, not dismissed) PRs across the token user's sessions and
// recorded Claude sessions, with GitHub titles when the prTitles cache has
// resolved them and per-URL read state from the PR store.
export function openPrs(): SessionPr[] {
  return visiblePrs(prStore().records(), allOpenPullRequests()).map((pr) => ({
    ...pr,
    source: pr.source ?? 'devin',
    title: prTitles.get(pr.url),
  }));
}

// PR panel "open" action: mark the row read, close the panel, then route by
// source — Claude rows go to the Claude surface, Devin rows to the cloud view.
export function openPr(sessionId: string, url: string): void {
  prStore().markRead(url);
  setPrsPanel(false);
  const entry = allOpenPullRequests().find((pr) => pr.url === url);
  if (entry?.source === 'claude') {
    openClaudeSessionPr(sessionId, url);
    return;
  }
  openSessionPr(sessionId, url);
}

// Claude PR / notification routing: select the session on the claude surface,
// then open the PR in its `claude:<id>` tab scope (openSessionPr's analogue).
function openClaudeSessionPr(sessionId: string, prUrl?: string): void {
  state.surface = 'claude';
  claudeSessions().open(sessionId);
  applyLayout();
  if (prUrl) {
    state.tabManager?.open(prUrl, { originSessionId: claudeScope(sessionId) });
  }
  activateWindow('claude-session-pr');
}

// Open a PR for a specific session: navigate the devin view to that session
// (its scope's tabs come along via the did-navigate scope switch), then open
// the PR in that scope.
export function openSessionPr(sessionId: string, prUrl: string): void {
  log('shell', 'pr-open', { url: prUrl, detail: { sessionId } });
  if (sessionId !== state.currentSessionId) {
    loadInDevinView(sessionUrl(state.tenantUrl, sessionId));
  }
  state.surface = 'cloud';
  applyLayout();
  state.tabManager?.open(prUrl, { originSessionId: sessionId });
  activateWindow('session-pr');
  focusContents(state.devinView?.webContents, 'session-pr');
}

// P6: opening a notification marks it read, navigates the devin view to the
// session (or installs the downloaded update), and a PR notification also
// focuses the PR tab in that session's pane.
export function openNotification(id: string): void {
  const store = notificationStore();
  const entry = store.entries().find((item) => item.id === id);
  if (!entry) return;
  store.markRead(id);
  setNotificationsPanel(false);
  log('shell', 'notification-open', {
    detail: { id, kind: entry.kind, sessionId: entry.sessionId },
  });
  if (entry.kind === 'update') {
    installUpdate();
    return;
  }
  if (entry.kind === 'identity' || entry.kind === 'auth') {
    state.surface = 'settings';
    applyLayout();
    return;
  }
  if (entry.kind === 'usage') {
    state.settings?.merge({
      analytics: { tab: entry.source === 'claude' ? 'claude' : 'devin' },
    });
    state.surface = 'analytics';
    refreshAnalyticsView();
    applyLayout();
    activateWindow('notification-open');
    return;
  }
  // Claude entries select the session on the Claude surface; a PR opens in
  // the session's `claude:<id>` tab scope like openSessionPr does for Devin.
  if (entry.source === 'claude' && entry.sessionId) {
    openClaudeSessionPr(entry.sessionId, entry.prUrl);
    return;
  }
  if (entry.sessionId && entry.prUrl) {
    openSessionPr(entry.sessionId, entry.prUrl);
    return;
  }
  if (entry.sessionId) loadInDevinView(sessionUrl(state.tenantUrl, entry.sessionId));
  state.surface = 'cloud';
  applyLayout();
  if (entry.prUrl) {
    handleLink(entry.prUrl, 'shell');
  }
  activateWindow('notification-open');
  focusContents(state.devinView?.webContents, 'notification-open');
}
