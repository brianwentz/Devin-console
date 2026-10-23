import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  dismissAllPrs,
  dismissPr,
  markAllPrsRead,
  markPrRead,
  reconcilePrRecords,
  type PrRecord,
} from '../core/prPanelModel';
import type { SessionPrLink } from '../core/notifyModel';
import { allPrsKnown, runtimes } from './providers';
import { log } from './log';
import { notifyShell } from './window';

const PrRecordSchema = z.object({
  url: z.string(),
  firstSeenAt: z.number(),
  readAt: z.number().nullable(),
  dismissedAt: z.number().nullable(),
});

const SAVE_DEBOUNCE_MS = 300;

// PR panel state: persisted per-URL read/dismissed records in prs.json. The
// open-PR list itself is derived from the last poll's apiSessions; records
// for URLs no longer open are dropped on reconcile.
export class PrStore {
  private list: PrRecord[] = [];
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(userData: string) {
    this.file = join(userData, 'prs.json');
    try {
      const parsed = PrRecordSchema.array().safeParse(
        JSON.parse(readFileSync(this.file, 'utf8')),
      );
      this.list = parsed.success ? parsed.data : [];
    } catch {
      this.list = [];
    }
  }

  records(): PrRecord[] {
    return this.list;
  }

  // New open PRs always get a record; records of PRs no longer open are only
  // dropped once every provider has listed this run (`prune`), so a provider
  // that has not listed yet cannot lose its read/dismissed state.
  reconcile(open: readonly SessionPrLink[], now: number, prune = allPrsKnown()): void {
    const next = reconcilePrRecords(this.list, open, now, prune);
    if (JSON.stringify(next) === JSON.stringify(this.list)) return;
    this.list = next;
    this.persist();
    notifyShell();
  }

  markRead(url: string): void {
    if (!this.list.some((record) => record.url === url && record.readAt === null)) return;
    this.list = markPrRead(this.list, url, Date.now());
    this.persist();
    notifyShell();
    log('shell', 'pr-read', { detail: { all: false, count: 1 } });
  }

  markAllRead(): void {
    const unread = this.list.filter((record) => record.readAt === null).length;
    if (unread === 0) return;
    this.list = markAllPrsRead(this.list, Date.now());
    this.persist();
    notifyShell();
    log('shell', 'pr-read', { detail: { all: true, count: unread } });
  }

  dismiss(url: string): void {
    if (!this.list.some((record) => record.url === url && record.dismissedAt === null)) return;
    this.list = dismissPr(this.list, url, Date.now());
    this.persist();
    notifyShell();
    log('shell', 'pr-dismiss', { detail: { all: false, count: 1 } });
  }

  dismissAll(): void {
    const visible = this.list.filter((record) => record.dismissedAt === null).length;
    if (visible === 0) return;
    this.list = dismissAllPrs(this.list, Date.now());
    this.persist();
    notifyShell();
    log('shell', 'pr-dismiss', { detail: { all: true, count: visible } });
  }

  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(join(this.file, '..'), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.list));
      } catch (error) {
        log('shell', 'prs-save-error', { detail: { message: String(error) } });
      }
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.list));
    } catch {
      // best effort at shutdown
    }
  }
}

let store: PrStore | null = null;

export function prStore(userData?: string): PrStore {
  if (!store) {
    if (!userData) throw new Error('prStore not initialised');
    store = new PrStore(userData);
  }
  return store;
}

// The merged open-PR list: Devin session PRs from the poller plus Claude
// session PRs recorded in the Claude registry (works with no Devin token).
export function allOpenPullRequests(): SessionPrLink[] {
  return runtimes().flatMap((r) => r.openPullRequests?.() ?? []);
}

export function prsFlush(): void {
  store?.flush();
}
