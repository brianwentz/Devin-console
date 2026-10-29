import type { HostId } from './execHost';
import { pullRequestKey } from './tabModel';

export type ReviewVerdict = 'approved' | 'changes' | 'discussion';
export type ReviewStatus = 'reviewing' | ReviewVerdict | 'ended';

export interface ReviewRecord {
  tabId: string;
  sessionId: string;
  hostId: HostId;
  ptyId: string | null;
  prUrl: string;
  originScope: string;
  status: ReviewStatus;
  startedAt: number;
  finishedAt: number | null;
  terminalOpen: boolean;
}

export type ReviewEvent =
  | { type: 'verdict'; verdict: ReviewVerdict; at: number }
  | { type: 'exit'; at: number }
  | { type: 'close-terminal'; at: number }
  | { type: 'show-terminal' };

export function reduceReview(r: ReviewRecord, e: ReviewEvent): ReviewRecord {
  const reviewing = r.status === 'reviewing';
  switch (e.type) {
    case 'verdict':
      return reviewing ? { ...r, status: e.verdict, finishedAt: e.at } : r;
    case 'exit':
      return reviewing
        ? { ...r, status: 'ended', ptyId: null, finishedAt: e.at }
        : { ...r, ptyId: null };
    case 'close-terminal':
      return reviewing
        ? { ...r, status: 'ended', terminalOpen: false, finishedAt: e.at }
        : { ...r, terminalOpen: false };
    case 'show-terminal':
      return { ...r, terminalOpen: true };
  }
}

const MARKER_LINE = /^[\s*`_>]*AW_REVIEW_VERDICT:\s*(approved|changes|discussion)[\s*`_.]*$/i;
const ASSESSMENT = /Overall Assessment:\**\s*(Approved|Changes Requested|Needs Discussion)/gi;

const ASSESSMENT_VERDICT: Record<string, ReviewVerdict> = {
  approved: 'approved',
  'changes requested': 'changes',
  'needs discussion': 'discussion',
};

export function parseVerdict(
  assistantText: string,
): { verdict: ReviewVerdict; via: 'marker' | 'assessment' } | null {
  const lines = assistantText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARKER_LINE.exec(lines[i] ?? '');
    if (m) return { verdict: (m[1] ?? '').toLowerCase() as ReviewVerdict, via: 'marker' };
  }
  let last: ReviewVerdict | undefined;
  for (const m of assistantText.matchAll(ASSESSMENT)) {
    last = ASSESSMENT_VERDICT[(m[1] ?? '').toLowerCase()] ?? last;
  }
  return last ? { verdict: last, via: 'assessment' } : null;
}

export function buildReviewPrompt(prUrl: string): string {
  return (
    `/cb:review ${prUrl}\n\n` +
    'When the review is complete, end your final message with exactly one line:\n' +
    'AW_REVIEW_VERDICT: approved | changes | discussion'
  );
}

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

// Scheme, host (with port) and owner/repo case are kept from the input so the
// canonical URL matches the tab's own URL (fixture origins are http://127.0.0.1:<port>).
function parsePr(rawUrl: string): { base: string; owner: string; repo: string; n: string } | null {
  if (!pullRequestKey(rawUrl)) return null;
  const url = new URL(rawUrl);
  const m = PR_PATH.exec(url.pathname);
  if (!m) return null;
  return { base: `${url.protocol}//${url.host}`, owner: m[1] ?? '', repo: m[2] ?? '', n: m[3] ?? '' };
}

export function canonicalPrUrl(url: string): string | null {
  const pr = parsePr(url);
  return pr ? `${pr.base}/${pr.owner}/${pr.repo}/pull/${pr.n}` : null;
}

export function prLabel(prUrl: string): string {
  const pr = parsePr(prUrl);
  return pr ? `${pr.owner}/${pr.repo}#${pr.n}` : prUrl;
}

const DOT_LABEL: Record<ReviewStatus, string> = {
  reviewing: 'Reviewing…',
  approved: 'Review: approved',
  changes: 'Review: changes requested',
  discussion: 'Review: needs discussion',
  ended: 'Review ended',
};

export function reviewDotLabel(s: ReviewStatus): string {
  return DOT_LABEL[s];
}

export interface TabMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  action: 'copy' | 'review' | 'rerun' | 'show-review';
}

export function tabMenuModel(
  url: string,
  status: ReviewStatus | null,
  terminalOpen: boolean,
): TabMenuItem[] {
  const items: TabMenuItem[] = [
    { id: 'copy-address', label: 'Copy address', enabled: true, action: 'copy' },
  ];
  if (!canonicalPrUrl(url)) {
    items.push({ id: 'review', label: 'Review pull request', enabled: false, action: 'review' });
    return items;
  }
  if (status === null) {
    items.push({ id: 'review', label: 'Review pull request', enabled: true, action: 'review' });
  } else if (status === 'reviewing') {
    items.push({ id: 'review', label: 'Review pull request', enabled: false, action: 'review' });
    if (!terminalOpen) {
      items.push({
        id: 'show-review',
        label: 'Show review terminal',
        enabled: true,
        action: 'show-review',
      });
    }
  } else {
    items.push({ id: 'rerun', label: 'Re-run review', enabled: true, action: 'rerun' });
  }
  return items;
}

export function resolveReviewHostPure(
  setting: string,
  platform: NodeJS.Platform,
  distro: { listed: boolean; enabled: boolean; fsReady: boolean } | null,
):
  | { ok: true; hostId: HostId }
  | { ok: false; reason: 'distro-unavailable' | 'helper-not-ready' } {
  if (platform !== 'win32' || !setting.startsWith('wsl:')) return { ok: true, hostId: 'local' };
  if (!distro || !distro.listed || !distro.enabled) {
    return { ok: false, reason: 'distro-unavailable' };
  }
  if (!distro.fsReady) return { ok: false, reason: 'helper-not-ready' };
  return { ok: true, hostId: setting as HostId };
}
