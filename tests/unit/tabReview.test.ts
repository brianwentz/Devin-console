import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  canonicalPrUrl,
  parseVerdict,
  prLabel,
  reduceReview,
  resolveReviewHostPure,
  reviewDotLabel,
  tabMenuModel,
  type ReviewRecord,
} from '../../src/core/tabReview';

const rec = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({
  tabId: 't1',
  sessionId: 's1',
  hostId: 'local',
  ptyId: 'p1',
  prUrl: 'https://github.com/o/r/pull/12',
  originScope: 'claude:abc',
  status: 'reviewing',
  startedAt: 1,
  finishedAt: null,
  terminalOpen: true,
  ...over,
});

describe('parseVerdict', () => {
  it('reads the marker', () => {
    expect(parseVerdict('done\nAW_REVIEW_VERDICT: changes')).toEqual({
      verdict: 'changes',
      via: 'marker',
    });
  });
  it('last marker wins', () => {
    expect(parseVerdict('AW_REVIEW_VERDICT: approved\nmore\nAW_REVIEW_VERDICT: discussion')?.verdict).toBe(
      'discussion',
    );
  });
  it('rejects the template line', () => {
    expect(parseVerdict('AW_REVIEW_VERDICT: approved | changes | discussion')).toBeNull();
  });
  it('ignores case and decoration', () => {
    expect(parseVerdict('**`aw_review_verdict: Approved`**')).toEqual({
      verdict: 'approved',
      via: 'marker',
    });
  });
  it('falls back to the assessment', () => {
    expect(parseVerdict('**Overall Assessment:** Approved')?.verdict).toBe('approved');
    expect(parseVerdict('**Overall Assessment:** Changes Requested')).toEqual({
      verdict: 'changes',
      via: 'assessment',
    });
    expect(parseVerdict('Overall Assessment: Needs Discussion')?.verdict).toBe('discussion');
  });
  it('returns null when neither is present', () => {
    expect(parseVerdict('looks fine to me')).toBeNull();
  });
  it('the built prompt carries no standalone marker', () => {
    expect(parseVerdict(buildReviewPrompt('https://github.com/o/r/pull/1'))).toBeNull();
  });
});

describe('buildReviewPrompt', () => {
  it('starts with the command and has the marker instruction', () => {
    const u = 'https://github.com/o/r/pull/12';
    const p = buildReviewPrompt(u);
    expect(p.startsWith(`/cb:review ${u}\n`)).toBe(true);
    expect(p).toContain('AW_REVIEW_VERDICT: approved | changes | discussion');
  });
});

describe('canonicalPrUrl / prLabel', () => {
  it('strips sub-path, query and hash', () => {
    expect(canonicalPrUrl('https://github.com/o/r/pull/12/files?w=1#x')).toBe(
      'https://github.com/o/r/pull/12',
    );
  });
  it('is null for a non-PR url', () => {
    expect(canonicalPrUrl('https://github.com/o/r')).toBeNull();
  });
  it('labels owner/repo#n', () => {
    expect(prLabel('https://github.com/o/r/pull/12')).toBe('o/r#12');
  });
});

describe('reduceReview', () => {
  it('verdict while reviewing', () => {
    const r = reduceReview(rec(), { type: 'verdict', verdict: 'changes', at: 9 });
    expect(r.status).toBe('changes');
    expect(r.finishedAt).toBe(9);
  });
  it('verdict on a finished record is ignored', () => {
    const done = rec({ status: 'approved', finishedAt: 5 });
    expect(reduceReview(done, { type: 'verdict', verdict: 'changes', at: 9 })).toEqual(done);
  });
  it('exit while reviewing ends it', () => {
    const r = reduceReview(rec(), { type: 'exit', at: 9 });
    expect(r.status).toBe('ended');
    expect(r.ptyId).toBeNull();
  });
  it('exit after a verdict keeps the status', () => {
    const r = reduceReview(rec({ status: 'approved', finishedAt: 5 }), { type: 'exit', at: 9 });
    expect(r.status).toBe('approved');
    expect(r.ptyId).toBeNull();
    expect(r.finishedAt).toBe(5);
  });
  it('close-terminal while reviewing ends it', () => {
    const r = reduceReview(rec(), { type: 'close-terminal', at: 9 });
    expect(r.status).toBe('ended');
    expect(r.terminalOpen).toBe(false);
  });
  it('close-terminal after a verdict keeps the status', () => {
    const r = reduceReview(rec({ status: 'changes' }), { type: 'close-terminal', at: 9 });
    expect(r.status).toBe('changes');
    expect(r.terminalOpen).toBe(false);
  });
  it('show-terminal reopens', () => {
    expect(reduceReview(rec({ terminalOpen: false }), { type: 'show-terminal' }).terminalOpen).toBe(true);
  });
});

describe('tabMenuModel', () => {
  const pr = 'https://github.com/o/r/pull/12';
  it('non-PR disables review', () => {
    const m = tabMenuModel('https://example.com/', null, false);
    expect(m.map((i) => [i.label, i.enabled])).toEqual([
      ['Copy address', true],
      ['Review pull request', false],
    ]);
  });
  it('PR with no review enables review', () => {
    expect(tabMenuModel(pr, null, false)[1]).toMatchObject({ action: 'review', enabled: true });
  });
  it('reviewing disables review and offers the terminal when hidden', () => {
    const m = tabMenuModel(pr, 'reviewing', false);
    expect(m[1]).toMatchObject({ action: 'review', enabled: false });
    expect(m[2]).toMatchObject({ action: 'show-review', label: 'Show review terminal' });
    expect(tabMenuModel(pr, 'reviewing', true)).toHaveLength(2);
  });
  it('finished review offers re-run', () => {
    expect(tabMenuModel(pr, 'approved', false)[1]).toMatchObject({
      action: 'rerun',
      label: 'Re-run review',
      enabled: true,
    });
  });
});

describe('reviewDotLabel', () => {
  it('has a label per status', () => {
    expect(reviewDotLabel('reviewing')).toBe('Reviewing…');
    expect(reviewDotLabel('approved')).toBe('Review: approved');
    expect(reviewDotLabel('changes')).toBe('Review: changes requested');
    expect(reviewDotLabel('discussion')).toBe('Review: needs discussion');
    expect(reviewDotLabel('ended')).toBe('Review ended');
  });
});

describe('resolveReviewHostPure', () => {
  const ready = { listed: true, enabled: true, fsReady: true };
  it('ignores a stale wsl setting off Windows', () => {
    expect(resolveReviewHostPure('wsl:D', 'darwin', null)).toEqual({ ok: true, hostId: 'local' });
  });
  it('local on win32', () => {
    expect(resolveReviewHostPure('local', 'win32', null)).toEqual({ ok: true, hostId: 'local' });
  });
  it('unlisted or disabled distro', () => {
    const bad = { reason: 'distro-unavailable', ok: false };
    expect(resolveReviewHostPure('wsl:D', 'win32', null)).toEqual(bad);
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...ready, listed: false })).toEqual(bad);
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...ready, enabled: false })).toEqual(bad);
  });
  it('helper not ready', () => {
    expect(resolveReviewHostPure('wsl:D', 'win32', { ...ready, fsReady: false })).toEqual({
      ok: false,
      reason: 'helper-not-ready',
    });
  });
  it('ready distro', () => {
    expect(resolveReviewHostPure('wsl:D', 'win32', ready)).toEqual({ ok: true, hostId: 'wsl:D' });
  });
});
