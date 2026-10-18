import { session } from 'electron';
import { routeUrl } from '../core/linkRouter';
import { parsePrState, parsePrTitle, type PrState } from '../core/prTitle';
import { log } from './log';
import { routeContext } from './routing';
import { notifyShell } from './window';

// Resolves GitHub PR titles + states (from the page <title>/HTML) for the PR
// panel, quick-open menu and Claude PR tracking. Fetches go through the
// persist:github partition so the user's GitHub cookies apply; only URLs that
// route as 'github' are ever fetched. Titles are never logged — only
// status/length and the state enum.
const NULL_RETRY_MS = 10 * 60_000;
const OK_REFRESH_MS = 6 * 60 * 60_000;
const MAX_CONCURRENT = 3;
const FETCH_TIMEOUT_MS = 15_000;

export interface PrInfo {
  title: string | null;
  state: PrState | null;
}

interface CacheEntry {
  title: string | null;
  state: PrState | null;
  fetchedAt: number;
}

class PrTitleCache {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Set<string>();
  private queue: string[] = [];
  private changeTimer: NodeJS.Timeout | null = null;
  /** Single subscription — Claude sessions wire cache landings to setPrState. */
  onChange: (() => void) | null = null;

  get(url: string): string | null {
    return this.cache.get(url)?.title ?? null;
  }

  getInfo(url: string): PrInfo | null {
    const entry = this.cache.get(url);
    return entry ? { title: entry.title, state: entry.state } : null;
  }

  // `maxAgeMs` shortens the re-fetch window for non-final states (Claude PR
  // tracking polls every 10 min); merged/closed are final (OK_REFRESH_MS).
  ensure(urls: readonly string[], opts?: { maxAgeMs?: number }): void {
    const now = Date.now();
    for (const url of urls) {
      if (this.inFlight.has(url) || this.queue.includes(url)) continue;
      const cached = this.cache.get(url);
      if (cached) {
        const staleMs =
          cached.state === 'merged' || cached.state === 'closed'
            ? OK_REFRESH_MS
            : (opts?.maxAgeMs ??
              (cached.title === null ? NULL_RETRY_MS : OK_REFRESH_MS));
        if (now - cached.fetchedAt < staleMs) continue;
      }
      if (routeUrl(url, routeContext()) !== 'github') continue;
      this.queue.push(url);
    }
    this.pump();
  }

  // Test-mode seed: an e2e can flip a URL's state without a real GitHub fetch.
  seed(url: string, info: PrInfo): void {
    this.cache.set(url, { ...info, fetchedAt: Date.now() });
    this.changed();
  }

  private pump(): void {
    while (this.inFlight.size < MAX_CONCURRENT && this.queue.length > 0) {
      const url = this.queue.shift();
      if (!url || this.inFlight.has(url)) continue;
      this.inFlight.add(url);
      void this.fetchTitle(url).finally(() => {
        this.inFlight.delete(url);
        this.pump();
      });
    }
  }

  private changed(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.onChange?.();
      notifyShell();
    }, 150);
    this.changeTimer.unref?.();
  }

  private async fetchTitle(url: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let status: number | null = null;
    let title: string | null = null;
    let state: PrState | null = null;
    try {
      const response = await session.fromPartition('persist:github').fetch(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        headers: { accept: 'text/html' },
        signal: controller.signal,
      });
      status = response.status;
      if (status >= 200 && status < 300) {
        const html = await response.text();
        title = parsePrTitle(html);
        state = parsePrState(html);
      }
    } catch {
      status = null;
      title = null;
    } finally {
      clearTimeout(timer);
    }
    // A fetch that fails or can't determine the state must not regress a
    // known one — keep the previous (title same rule).
    const previous = this.cache.get(url);
    this.cache.set(url, {
      title: title ?? previous?.title ?? null,
      state: state ?? previous?.state ?? null,
      fetchedAt: Date.now(),
    });
    this.changed();
    log('shell', 'pr-title', {
      url,
      detail: { ok: status !== null && status >= 200 && status < 300, status, length: title?.length ?? 0, state },
    });
  }
}

export const prTitles = new PrTitleCache();
