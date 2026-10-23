import { describe, expect, it } from 'vitest';
import type { SessionPrLink } from '../../src/core/notifyModel';
import {
  dismissAllPrs,
  dismissPr,
  markAllPrsRead,
  markPrRead,
  reconcilePrRecords,
  unreadPrCount,
  visiblePrs,
  type PrRecord,
} from '../../src/core/prPanelModel';

function link(url: string, sessionId = 'sess-1'): SessionPrLink {
  return { sessionId, sessionTitle: 'Session', ref: url, url, state: 'open' };
}

describe('reconcilePrRecords', () => {
  it('adds records for new open PR URLs, unread and not dismissed', () => {
    const records = reconcilePrRecords([], [link('u1'), link('u2')], 1000);
    expect(records).toEqual([
      { url: 'u1', firstSeenAt: 1000, readAt: null, dismissedAt: null },
      { url: 'u2', firstSeenAt: 1000, readAt: null, dismissedAt: null },
    ]);
  });

  it('drops records whose URL is no longer open and preserves read/dismissed state', () => {
    const records: PrRecord[] = [
      { url: 'u1', firstSeenAt: 100, readAt: 200, dismissedAt: null },
      { url: 'u2', firstSeenAt: 100, readAt: null, dismissedAt: 300 },
      { url: 'u3', firstSeenAt: 100, readAt: null, dismissedAt: null },
    ];
    const next = reconcilePrRecords(records, [link('u1'), link('u2'), link('u4')], 400);
    expect(next).toEqual([
      { url: 'u1', firstSeenAt: 100, readAt: 200, dismissedAt: null },
      { url: 'u2', firstSeenAt: 100, readAt: null, dismissedAt: 300 },
      { url: 'u4', firstSeenAt: 400, readAt: null, dismissedAt: null },
    ]);
  });

  it('prune=false keeps a dismissed record that is not in the open list, and still adds new ones', () => {
    const records: PrRecord[] = [{ url: 'devin', firstSeenAt: 100, readAt: 150, dismissedAt: 200 }];
    const next = reconcilePrRecords(records, [link('oh')], 400, false);
    expect(next).toEqual([
      { url: 'devin', firstSeenAt: 100, readAt: 150, dismissedAt: 200 },
      { url: 'oh', firstSeenAt: 400, readAt: null, dismissedAt: null },
    ]);
  });

  it('prune=true (the default) drops it', () => {
    const records: PrRecord[] = [{ url: 'devin', firstSeenAt: 100, readAt: 150, dismissedAt: 200 }];
    expect(reconcilePrRecords(records, [link('oh')], 400, true).map((r) => r.url)).toEqual(['oh']);
    expect(reconcilePrRecords(records, [link('oh')], 400).map((r) => r.url)).toEqual(['oh']);
  });
});

describe('markPrRead / markAllPrsRead', () => {
  it('marks one record read and is idempotent', () => {
    let records = reconcilePrRecords([], [link('u1')], 100);
    records = markPrRead(records, 'u1', 200);
    expect(records[0]!.readAt).toBe(200);
    expect(markPrRead(records, 'u1', 300)[0]!.readAt).toBe(200);
    expect(markPrRead(records, 'missing', 300)).toEqual(records);
  });

  it('marks all unread records read', () => {
    const records: PrRecord[] = [
      { url: 'u1', firstSeenAt: 100, readAt: 150, dismissedAt: null },
      { url: 'u2', firstSeenAt: 100, readAt: null, dismissedAt: null },
    ];
    const next = markAllPrsRead(records, 200);
    expect(next[0]!.readAt).toBe(150);
    expect(next[1]!.readAt).toBe(200);
  });
});

describe('dismiss', () => {
  it('hides the PR from visiblePrs and unreadPrCount', () => {
    let records = reconcilePrRecords([], [link('u1'), link('u2')], 100);
    records = dismissPr(records, 'u1', 200);
    expect(visiblePrs(records, [link('u1'), link('u2')]).map((pr) => pr.url)).toEqual(['u2']);
    expect(unreadPrCount(records, [link('u1'), link('u2')])).toBe(1);
  });

  it('dismissAll hides every open PR', () => {
    let records = reconcilePrRecords([], [link('u1'), link('u2')], 100);
    records = dismissAllPrs(records, 200);
    expect(visiblePrs(records, [link('u1'), link('u2')])).toEqual([]);
    expect(unreadPrCount(records, [link('u1'), link('u2')])).toBe(0);
  });

  it('a dismissed URL that leaves open is dropped and re-added unread on reappearance', () => {
    let records = reconcilePrRecords([], [link('u1')], 100);
    records = dismissPr(records, 'u1', 200);
    records = reconcilePrRecords(records, [], 300);
    expect(records).toEqual([]);
    records = reconcilePrRecords(records, [link('u1')], 400);
    expect(records).toEqual([{ url: 'u1', firstSeenAt: 400, readAt: null, dismissedAt: null }]);
    expect(visiblePrs(records, [link('u1')])).toHaveLength(1);
    expect(unreadPrCount(records, [link('u1')])).toBe(1);
  });
});

describe('visiblePrs', () => {
  it('keeps open order and annotates readAt (null when no record)', () => {
    const records: PrRecord[] = [{ url: 'u2', firstSeenAt: 100, readAt: 200, dismissedAt: null }];
    expect(visiblePrs(records, [link('u1'), link('u2')])).toEqual([
      { ...link('u1'), readAt: null },
      { ...link('u2'), readAt: 200 },
    ]);
  });
});
