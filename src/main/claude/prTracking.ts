// Claude PR tracking — one funnel for every detected PR URL (chat link
// scanner, claude-pty output, PostToolUse hook) records it on the registry
// entry before any auto-open, so the PR panel + sidebar badges see it even
// without a Devin token.
import {
  openPrsOf,
  recordPr as recordRegistryPr,
  setPrState,
  type ClaudePrState,
} from '../../core/claudeRegistry';
import { prTitle, type SessionPrLink } from '../../core/notifyModel';
import { log } from '../log';
import { state } from '../state';
import { notificationStore } from '../notifications';
import { allOpenPullRequests, prStore } from '../prs';
import { prTitles } from '../prTitles';
import { hosts } from '../hosts';
import type { HostId } from '../../core/execHost';
import type { ClaudeSessions } from './sessions';

// Claude PR state refresh: every 10 min while the window is focused, and
// again each time the PR panel opens (setPrsPanel seam).
const PR_STATE_REFRESH_MS = 10 * 60_000;

export class ClaudePrTracking {
  private prRefreshTimer: NodeJS.Timeout | null = null;
  private unsubscribeCache: (() => void) | null = null;

  constructor(private readonly owner: ClaudeSessions) {}

  start(): void {
    // Title/state cache landings feed setPrState; refresh non-final entries
    // every 10 min while focused.
    this.unsubscribeCache?.();
    this.unsubscribeCache = prTitles.addChangeListener(this.onCacheChange);
    // Prefer the PR-owning session's host for the `gh` fallback — on this
    // machine gh is authenticated inside WSL, not on Windows.
    prTitles.ghResolver = async (url: string) => {
      const entry = Object.values(this.owner.registry.entries).find((e) =>
        e.prs.some((pr) => pr.url === url),
      );
      const hostId = (entry?.host ?? 'local') as HostId;
      if (hostId === 'local') return null;
      // A background refresh: re-read a stale enumeration before spawning
      // into the distro (ghSpec itself refuses a stopped/disabled one).
      const host = hosts().hostById(hostId);
      if (!host || !(await hosts().backgroundReady(host))) return null;
      return hosts().ghSpec(hostId);
    };
    this.prRefreshTimer = setInterval(() => {
      if (state.windowRef?.isFocused()) this.refreshPrStates('timer');
    }, PR_STATE_REFRESH_MS);
    this.prRefreshTimer.unref?.();
  }

  stop(): void {
    if (this.prRefreshTimer) clearInterval(this.prRefreshTimer);
    this.prRefreshTimer = null;
    this.unsubscribeCache?.();
    this.unsubscribeCache = null;
    prTitles.ghResolver = null;
  }

  private readonly onCacheChange = (): void => {
    // prTitles cache landed/changed — push fresh states into the registry;
    // a first flip to merged|closed raises one pr-completed notification.
    let registry = this.owner.registry;
    let changed = false;
    for (const [id, entry] of Object.entries(registry.entries)) {
      for (const pr of entry.prs) {
        const info = prTitles.getInfo(pr.url);
        if (!info || info.state === pr.state) continue;
        const result = setPrState(registry, id, pr.url, info.state, Date.now());
        registry = result.registry;
        changed = true;
        if (result.completed) this.notifyPrCompleted(id, pr.url, info.state);
      }
    }
    if (!changed) return;
    this.owner.saveRegistry(registry);
    prStore().reconcile(allOpenPullRequests(), Date.now());
    this.owner.emit();
  };

  recordPr(sessionId: string, url: string, source: 'chat' | 'terminal' | 'hook'): void {
    const { registry, added } = recordRegistryPr(
      this.owner.registry,
      sessionId,
      url,
      source,
      Date.now(),
    );
    if (!added) return;
    this.owner.saveRegistry(registry);
    prTitles.ensure([url]);
    prStore().reconcile(allOpenPullRequests(), Date.now());
    this.owner.emit();
  }

  // Claude open PRs for the panel: non-removed, non-missing sessions, newest
  // seenAt first (openPrsOf already drops merged/closed). Unknown state
  // counts as open.
  claudeOpenPullRequests(): SessionPrLink[] {
    const missing = new Set(
      this.owner.sessions.filter((s) => s.missing).map((s) => s.id),
    );
    return openPrsOf(this.owner.registry)
      .filter(({ sessionId }) => !missing.has(sessionId))
      .map(({ sessionId, pr }) => ({
        sessionId,
        sessionTitle: this.owner.titleFor(sessionId, undefined),
        ref: prTitle(pr.url),
        url: pr.url,
        state: pr.state,
        source: 'claude' as const,
      }));
  }

  // Re-fetch non-final Claude PR states (title cache fetch → setPrState via
  // the onChange subscription).
  refreshPrStates(reason: string): void {
    const urls = openPrsOf(this.owner.registry).map(({ pr }) => pr.url);
    if (urls.length === 0) return;
    log('claude', 'claude-pr-refresh', { detail: { count: urls.length, reason } });
    prTitles.ensure(urls, { maxAgeMs: PR_STATE_REFRESH_MS });
  }

  prsOf(sessionId: string): { url: string; state: string | null }[] {
    return (this.owner.registry.entries[sessionId]?.prs ?? []).map((pr) => ({
      url: pr.url,
      state: pr.state,
    }));
  }

  private notifyPrCompleted(
    sessionId: string,
    url: string,
    prState: ClaudePrState | null,
  ): void {
    if (prState !== 'merged' && prState !== 'closed') return;
    if (!(state.settings?.current.notifications.collect ?? true)) return;
    if (!(state.settings?.current.notifications.kinds.prCompleted ?? true)) return;
    const sessionTitle = this.owner.titleFor(sessionId, undefined);
    notificationStore().add({
      kind: 'pr-completed',
      sessionId,
      source: 'claude',
      ownerUserId: null,
      sessionTitle,
      prUrl: url,
      prState,
      title: `PR ${prTitle(url)} ${prState}`,
      body: sessionTitle,
      createdAt: Date.now(),
    });
  }
}
