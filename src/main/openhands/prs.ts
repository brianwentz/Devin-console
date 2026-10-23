// OpenHands pull requests: per-conversation PR URLs from the list rows
// (`pr_number` -> prUrl) plus URLs found in a finished conversation's events.
// Electron-free: the gated transport and the side effects are injected; the
// runtime (../providers/openhands.ts) builds one tracker per base URL, so a
// base change starts from an empty set and a fresh baseline.
//
// Never logs or keeps event text or titles beyond the in-memory row title the
// PR panel shows — logs carry counts / error codes only.

import { UNTITLED, type OhRow } from '../../core/openhands';
import { extractPullRequestUrls } from '../../core/prLinks';
import { prTitle, type SessionPrLink } from '../../core/notifyModel';
import type { OpenHandsFetch } from './fetch';

export const PRS_PER_CONVERSATION = 20;
export const EVENTS_SCAN_LIMIT = 100;
// URLs ever added to a conversation (so a capped-out one is never re-added
// and re-announced on the next poll); bounded so a long run cannot grow it.
const SEEN_PER_CONVERSATION = 200;

export interface OpenHandsPrTrackerDeps {
  /** The same redirect-safe gated fetch the list uses. */
  fetch: OpenHandsFetch;
  /** Extra GitHub origins (test fixtures). */
  githubOrigins?: readonly string[];
  /** A URL first seen after the baseline (rows or events). */
  autoOpen(url: string, sessionId: string): void;
  /** The PR set changed; `added` = URLs new to the tracker. */
  onChange(added: string[]): void;
  /** Known PR state (prTitles cache); merged/closed are left out. */
  stateOf?(url: string): string | null;
  log(event: string, detail: Record<string, unknown>): void;
}

export interface OpenHandsPrTracker {
  onRows(rows: readonly OhRow[]): void;
  onFinished(id: string): Promise<void>;
  openPullRequests(): SessionPrLink[];
  stop(): void;
}

interface Conversation {
  title: string;
  updatedAt: number;
  urls: Set<string>; // insertion order = oldest first
  seen: Set<string>;
}

function eventsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
    return (body as { items: unknown[] }).items;
  }
  return [];
}

export function createOpenHandsPrTracker(deps: OpenHandsPrTrackerDeps): OpenHandsPrTracker {
  const conversations = new Map<string, Conversation>();
  const scanning = new Set<string>();
  let baselined = false;
  let stopped = false;

  // Adds `urls` (oldest first) to a conversation; returns the ones it never
  // had. Only the newest PRS_PER_CONVERSATION of a batch are considered, and a
  // URL evicted by the cap is not added again.
  const add = (conv: Conversation, urls: readonly string[]): string[] => {
    const added: string[] = [];
    for (const url of urls.slice(-PRS_PER_CONVERSATION)) {
      if (conv.seen.has(url)) continue;
      conv.seen.add(url);
      conv.urls.add(url);
      added.push(url);
    }
    while (conv.seen.size > SEEN_PER_CONVERSATION) {
      const oldest = conv.seen.values().next().value as string;
      if (conv.urls.has(oldest)) break;
      conv.seen.delete(oldest);
    }
    while (conv.urls.size > PRS_PER_CONVERSATION) {
      conv.urls.delete(conv.urls.values().next().value as string);
    }
    return added.filter((url) => conv.urls.has(url));
  };

  const announce = (id: string, added: string[], openTabs: boolean): void => {
    if (openTabs) for (const url of added) deps.autoOpen(url, id);
  };

  return {
    onRows(rows) {
      if (stopped) return;
      const openTabs = baselined;
      baselined = true;
      let changed = false;
      const added: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.id);
        let conv = conversations.get(row.id);
        if (!conv) {
          conv = { title: row.title, updatedAt: row.updatedAt, urls: new Set(), seen: new Set() };
          conversations.set(row.id, conv);
        }
        conv.title = row.title;
        conv.updatedAt = row.updatedAt;
        const fresh = add(conv, row.prUrls);
        if (fresh.length > 0) {
          changed = true;
          added.push(...fresh);
          announce(row.id, fresh, openTabs);
        }
      }
      for (const [id, conv] of conversations) {
        if (seen.has(id)) continue;
        conversations.delete(id);
        if (conv.urls.size > 0) changed = true;
      }
      if (changed) deps.onChange(added);
    },

    async onFinished(id) {
      if (stopped || scanning.has(id)) return;
      scanning.add(id);
      try {
        const params = new URLSearchParams({ limit: String(EVENTS_SCAN_LIMIT), sort_order: 'TIMESTAMP_DESC' });
        const result = await deps.fetch(
          `/api/v1/conversation/${encodeURIComponent(id)}/events/search?${params.toString()}`,
        );
        if (result.error || result.status < 200 || result.status >= 300) {
          deps.log('openhands-events-scan-error', { code: result.error ?? `HTTP ${result.status}` });
          return;
        }
        const events = eventsOf(result.body);
        const found: string[] = [];
        for (const event of events) {
          for (const url of extractPullRequestUrls(JSON.stringify(event) ?? '', {
            githubOrigins: deps.githubOrigins ?? [],
          })) {
            if (!found.includes(url)) found.push(url);
          }
        }
        deps.log('openhands-events-scan', { count: events.length, prs: found.length });
        const conv = conversations.get(id);
        if (stopped || !conv || found.length === 0) return;
        // Newest-first events: add oldest first so the cap keeps the newest.
        const fresh = add(conv, found.slice().reverse());
        if (fresh.length === 0) return;
        announce(id, fresh, true);
        deps.onChange(fresh);
      } catch (error) {
        deps.log('openhands-events-scan-error', { code: error instanceof Error ? error.name : 'unknown' });
      } finally {
        scanning.delete(id);
      }
    },

    openPullRequests() {
      const out: SessionPrLink[] = [];
      const ordered = [...conversations.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      for (const [id, conv] of ordered) {
        for (const url of [...conv.urls].reverse()) {
          const prState = deps.stateOf?.(url) ?? null;
          if (prState === 'merged' || prState === 'closed') continue;
          out.push({
            sessionId: id,
            sessionTitle: conv.title.trim() || UNTITLED,
            ref: prTitle(url),
            url,
            state: prState,
            source: 'openhands',
          });
        }
      }
      return out;
    },

    stop() {
      stopped = true;
      conversations.clear();
    },
  };
}
