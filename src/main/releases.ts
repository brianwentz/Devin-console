import { net } from 'electron';
import {
  parseReleaseResponse,
  releaseTagUrl,
  type ReleaseNotes,
} from '../core/releaseNotes';
import { log } from './log';
import { testMode } from './state';

// Matches build.publish[0] in package.json — the GitHub Releases feed that
// electron-builder bakes into app-update.yml.
export const RELEASE_REPO = { owner: 'brianwentz', repo: 'agent-workspace' } as const;

const NULL_RETRY_MS = 10 * 60_000;
const OK_REFRESH_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  notes: ReleaseNotes | null;
  fetchedAt: number;
}

function apiBase(): string {
  if (testMode && process.env.AGENT_WORKSPACE_TEST_RELEASES_URL) {
    return process.env.AGENT_WORKSPACE_TEST_RELEASES_URL;
  }
  return 'https://api.github.com';
}

export class ReleaseNotesCache {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<ReleaseNotes | null>>();

  async get(version: string): Promise<ReleaseNotes | null> {
    const now = Date.now();
    const cached = this.cache.get(version);
    if (cached) {
      const staleMs = cached.notes === null ? NULL_RETRY_MS : OK_REFRESH_MS;
      if (now - cached.fetchedAt < staleMs) return cached.notes;
    }
    const pending = this.inFlight.get(version);
    if (pending) return pending;
    const request = this.fetchNotes(version).finally(() => {
      this.inFlight.delete(version);
    });
    this.inFlight.set(version, request);
    return request;
  }

  private async fetchNotes(version: string): Promise<ReleaseNotes | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const url = releaseTagUrl(apiBase(), RELEASE_REPO.owner, RELEASE_REPO.repo, version);
    let status: number | null = null;
    let notes: ReleaseNotes | null = null;
    try {
      const response = await net.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-workspace' },
        signal: controller.signal,
      });
      status = response.status;
      if (status >= 200 && status < 300) {
        notes = parseReleaseResponse(await response.json(), version);
      }
    } catch {
      status = null;
      notes = null;
    } finally {
      clearTimeout(timer);
    }
    this.cache.set(version, { notes, fetchedAt: Date.now() });
    log('shell', 'release-notes', {
      detail: {
        version,
        ok: status !== null && status >= 200 && status < 300,
        status,
        length: notes?.body.length ?? 0,
      },
    });
    return notes;
  }
}

export const releaseNotesCache = new ReleaseNotesCache();

// Notes extracted from electron-updater's UpdateInfo — preferred over the
// network fetch for the pending update.
let availableNotes: ReleaseNotes | null = null;

export function setAvailableReleaseNotes(notes: ReleaseNotes | null): void {
  availableNotes = notes;
}

export function getAvailableReleaseNotes(): ReleaseNotes | null {
  return availableNotes;
}
