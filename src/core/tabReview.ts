import { posix, win32 } from 'node:path';
import type { HostId } from './execHost';
import { REVIEW_URL_TOKEN } from './reviewSettings';
import { PULL_REQUEST_PATH, pullRequestKey } from './tabModel';

export type ReviewVerdict = 'approved' | 'changes' | 'discussion';
export type ReviewStatus = 'reviewing' | ReviewVerdict | 'ended';

export interface ReviewRecord {
  tabId: string;
  sessionId: string;
  hostId: HostId;
  agent: 'claude' | 'devin';
  /** Review workspace directory (host path flavour). */
  workspacePath: string;
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

/** Replaces every `{github-url}` in the command template (literally) and appends the verdict instruction. */
export function buildReviewPrompt(template: string, prUrl: string): string {
  return (
    template.split(REVIEW_URL_TOKEN).join(prUrl) +
    '\n\n' +
    'When the review is complete, end your final message with exactly one line:\n' +
    'AW_REVIEW_VERDICT: approved | changes | discussion'
  );
}

// Scheme, host (with port) and owner/repo case are kept from the input so the
// canonical URL matches the tab's own URL (fixture origins are http://127.0.0.1:<port>).
function parsePr(rawUrl: string): { base: string; owner: string; repo: string; n: string } | null {
  if (!pullRequestKey(rawUrl)) return null;
  const url = new URL(rawUrl);
  const m = PULL_REQUEST_PATH.exec(url.pathname);
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

/** `terminalHidden`: the review pty is alive but its strip was closed — any
 * status (claude keeps running after a verdict). */
export function tabMenuModel(
  url: string,
  status: ReviewStatus | null,
  terminalHidden: boolean,
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
  } else {
    items.push({ id: 'rerun', label: 'Re-run review', enabled: true, action: 'rerun' });
  }
  if (status !== null && terminalHidden) {
    items.push({ id: 'show-review', label: 'Show review terminal', enabled: true, action: 'show-review' });
  }
  return items;
}

export type ReviewRefusalReason =
  | 'not-pr'
  | 'running'
  | 'distro-unavailable'
  | 'distro-stopped'
  | 'helper-not-ready'
  | 'no-claude'
  | 'no-devin'
  | 'cwd-missing'
  | 'spawn';

const REFUSAL_TEXT: Record<ReviewRefusalReason, string> = {
  'not-pr': 'This tab is not a pull request.',
  running: 'A review of this tab is already running.',
  'distro-unavailable': 'The WSL distro chosen for reviews is not available.',
  'distro-stopped': "The WSL distro chosen for reviews is stopped and couldn't be started. Start it and try again.",
  'helper-not-ready': 'The WSL distro chosen for reviews is not ready yet. Try again in a moment.',
  'no-claude': 'The claude CLI was not found on the review host.',
  'no-devin': 'Devin CLI not found on this PC',
  'cwd-missing': 'Review folder not found',
  spawn: 'The review terminal could not be started.',
};

/** The menu's refusal dialog text. `hostLabel`: the review WSL distro's name,
 * null for this PC. */
export function reviewRefusalText(reason: ReviewRefusalReason, hostLabel: string | null): string {
  if (hostLabel !== null && reason === 'distro-stopped') {
    return `The WSL distro ${hostLabel} is stopped and couldn't be started. Start it and try again.`;
  }
  if (hostLabel !== null && reason === 'no-devin') return `Devin CLI not found on ${hostLabel}`;
  return REFUSAL_TEXT[reason];
}

/**
 * `start: true` = the enumeration reports the distro Stopped: a review is a
 * user action, so the controller starts it (an explicit probe / exec boots it)
 * instead of waiting for a helper that never comes up on its own.
 */
export function resolveReviewHostPure(
  setting: string,
  platform: NodeJS.Platform,
  distro: { listed: boolean; enabled: boolean; fsReady: boolean; stopped: boolean } | null,
):
  | { ok: true; hostId: HostId; start?: true }
  | { ok: false; reason: 'distro-unavailable' | 'helper-not-ready' } {
  if (platform !== 'win32' || !setting.startsWith('wsl:')) return { ok: true, hostId: 'local' };
  if (!distro || !distro.listed || !distro.enabled) {
    return { ok: false, reason: 'distro-unavailable' };
  }
  if (distro.fsReady) return { ok: true, hostId: setting as HostId };
  if (distro.stopped) return { ok: true, hostId: setting as HostId, start: true };
  return { ok: false, reason: 'helper-not-ready' };
}

/** `<home>/.agent-workspace/reviews` in the host path flavour. */
export function reviewsDirFor(home: string, family: 'posix' | 'win32'): string {
  return (family === 'win32' ? win32 : posix).join(home, '.agent-workspace', 'reviews');
}

/** Transcript re-reads after a Stop whose read found no verdict (ms after the Stop). */
export const REVIEW_VERDICT_RETRY_MS: readonly number[] = [1000, 3000, 7000];

/** Timer delays for the re-reads, `elapsedMs` after the Stop (overdue → 0). */
export function reviewRetryDelays(elapsedMs: number): number[] {
  return REVIEW_VERDICT_RETRY_MS.map((ms) => Math.max(0, ms - elapsedMs));
}

/**
 * The prompt argv entry for the review pty. CreateProcess runs a `.cmd`/`.bat`
 * (an npm `claude.cmd` set as `claude.path`) through cmd.exe, which ends the
 * command at a raw line break — so a shim gets the prompt on one line (the
 * slash command takes the rest of the line as its arguments either way).
 * Quoted `|` is literal to cmd.exe.
 */
export function reviewPromptArg(prompt: string, binary: string | null): string {
  return binary && /\.(cmd|bat)$/i.test(binary) ? prompt.replace(/(?:\r?\n)+/g, ' ') : prompt;
}

/**
 * Where a Stop's verdict comes from: the hook body's `last_assistant_message`
 * when the CLI sent it (claude >= 2.1.312), else the session transcript. A
 * payload string without a verdict is final for that Stop — no transcript read.
 */
export function verdictSource(payload: {
  last_assistant_message?: unknown;
}): { kind: 'payload'; text: string } | { kind: 'transcript' } {
  const text = payload.last_assistant_message;
  return typeof text === 'string' ? { kind: 'payload', text } : { kind: 'transcript' };
}

/** Text blocks of the last top-level assistant message that has any text, in
 * SDK transcript shape (`{type:'assistant', message:{content}}`). User text
 * (which echoes the marker template) and subagent messages never count. */
export function lastAssistantText(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const msg = m as { type?: unknown; parent_tool_use_id?: unknown; message?: unknown };
    if (msg.type !== 'assistant' || (msg.parent_tool_use_id ?? null) !== null) continue;
    const content = (msg.message as { content?: unknown } | null | undefined)?.content;
    if (typeof content === 'string') {
      if (content) return content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string',
      )
      .map((b) => b.text);
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}
