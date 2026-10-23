import type { SessionPrLink } from './notifyModel';

// PR panel records: one per observed open-PR URL. `readAt === null` means
// unread (every PR starts unread, including ones on the first poll);
// `dismissedAt !== null` hides it from the panel/badge for as long as the PR
// stays open. Records are dropped when the URL leaves the open list, so a
// reopened PR shows again — but only with `prune` (the caller passes false
// while some provider has not listed its PRs yet this run, so an absent URL
// proves nothing).
export interface PrRecord {
  url: string;
  firstSeenAt: number;
  readAt: number | null;
  dismissedAt: number | null;
}

export function reconcilePrRecords(
  records: readonly PrRecord[],
  open: readonly SessionPrLink[],
  now: number,
  prune = true,
): PrRecord[] {
  const openUrls = new Set(open.map((pr) => pr.url));
  const kept = prune ? records.filter((record) => openUrls.has(record.url)) : [...records];
  const known = new Set(kept.map((record) => record.url));
  const added = open
    .filter((pr) => !known.has(pr.url))
    .map((pr) => ({ url: pr.url, firstSeenAt: now, readAt: null, dismissedAt: null }));
  return [...kept, ...added];
}

export function markPrRead(records: readonly PrRecord[], url: string, now: number): PrRecord[] {
  return records.map((record) =>
    record.url === url && record.readAt === null ? { ...record, readAt: now } : record,
  );
}

export function markAllPrsRead(records: readonly PrRecord[], now: number): PrRecord[] {
  return records.map((record) => (record.readAt === null ? { ...record, readAt: now } : record));
}

export function dismissPr(records: readonly PrRecord[], url: string, now: number): PrRecord[] {
  return records.map((record) =>
    record.url === url && record.dismissedAt === null ? { ...record, dismissedAt: now } : record,
  );
}

export function dismissAllPrs(records: readonly PrRecord[], now: number): PrRecord[] {
  return records.map((record) =>
    record.dismissedAt === null ? { ...record, dismissedAt: now } : record,
  );
}

export function visiblePrs(
  records: readonly PrRecord[],
  open: readonly SessionPrLink[],
): (SessionPrLink & { readAt: number | null })[] {
  const byUrl = new Map(records.map((record) => [record.url, record]));
  return open
    .filter((pr) => byUrl.get(pr.url)?.dismissedAt == null)
    .map((pr) => ({ ...pr, readAt: byUrl.get(pr.url)?.readAt ?? null }));
}

export function unreadPrCount(records: readonly PrRecord[], open: readonly SessionPrLink[]): number {
  return visiblePrs(records, open).filter((pr) => pr.readAt === null).length;
}
