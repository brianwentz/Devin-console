// Notifications derived from Claude Code hook events (terminal /
// external sessions). Chat sessions produce theirs from in-app transitions.
import type { ClaudeHookEvent } from './claudeActivity';
import type { NewNotification } from './notificationModel';
import { extractPullRequestUrls, stripAnsi, type PrLinkContext } from './prLinks';

export type ClaudeNotifyContext = {
  /** Sidebar title for the session, or a cwd-derived fallback when unlisted. */
  titleFor(sessionId: string, cwd: string | undefined): string;
  enabled: { waiting: boolean; finished: boolean; prOpened: boolean };
  now: number;
  /** sessionId → timestamp of the last PermissionRequest; caller-owned, mutated here. */
  recentPermission: Map<string, number>;
  /** Extra GitHub Enterprise origins accepted when scanning for PR URLs. */
  githubOrigins?: readonly string[] | undefined;
};

/** A `Notification{permission_prompt}` this soon after a `PermissionRequest` is the same prompt. */
export const PERMISSION_DEDUP_MS = 5000;

const GH_PR_RE = /\bgh\s+pr\b/;

// Text to scan for PR URLs: a string as-is, an object's stdout/output/content
// string fields, an array's string items.
function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) return response.filter((v): v is string => typeof v === 'string').join('\n');
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    return ['stdout', 'output', 'content']
      .map((k) => obj[k])
      .filter((v): v is string => typeof v === 'string')
      .join('\n');
  }
  return '';
}

/**
 * Notifications (and PR URLs to auto-open) for one hook event. Every entry is
 * `source: 'claude'`, `ownerUserId: null`, keyed by the Claude session uuid.
 */
export function notificationsForHookEvent(
  e: ClaudeHookEvent,
  ctx: ClaudeNotifyContext,
): { notifications: NewNotification[]; prUrls: string[] } {
  const none = { notifications: [], prUrls: [] };
  const id = e.session_id;
  if (!id) return none;
  const base = (kind: NewNotification['kind'], title: string, body: string): NewNotification => ({
    kind,
    sessionId: id,
    source: 'claude',
    ownerUserId: null,
    sessionTitle: ctx.titleFor(id, e.cwd),
    title,
    body,
    createdAt: ctx.now,
  });
  const waiting = (): { notifications: NewNotification[]; prUrls: string[] } => {
    if (!ctx.enabled.waiting) return none;
    const sessionTitle = ctx.titleFor(id, e.cwd);
    return { notifications: [base('waiting', 'Waiting for permission', `${e.tool_name ?? 'A tool'} in ${sessionTitle}`)], prUrls: [] };
  };
  const finished = (): { notifications: NewNotification[]; prUrls: string[] } => {
    if (!ctx.enabled.finished) return none;
    return { notifications: [base('finished', 'Finished a turn', ctx.titleFor(id, e.cwd))], prUrls: [] };
  };

  switch (e.event) {
    case 'PermissionRequest':
      ctx.recentPermission.set(id, ctx.now);
      return waiting();
    case 'Notification': {
      if (e.notification_type === 'permission_prompt') {
        const last = ctx.recentPermission.get(id) ?? -Infinity;
        if (ctx.now - last < PERMISSION_DEDUP_MS) return none;
        return waiting();
      }
      if (e.notification_type === 'idle_prompt') return finished();
      return none;
    }
    case 'Stop':
      return finished();
    case 'PostToolUse': {
      if (e.tool_name !== 'Bash') return none;
      const command = e.tool_input?.command;
      if (typeof command !== 'string' || !GH_PR_RE.test(command)) return none;
      const linkCtx: PrLinkContext = ctx.githubOrigins ? { githubOrigins: ctx.githubOrigins } : {};
      const urls = extractPullRequestUrls(stripAnsi(responseText(e.tool_response)), linkCtx);
      if (urls.length === 0) return none;
      if (!ctx.enabled.prOpened) return { notifications: [], prUrls: urls };
      const sessionTitle = ctx.titleFor(id, e.cwd);
      return {
        notifications: urls.map((url) => ({ ...base('pr-opened', 'Opened a pull request', sessionTitle), prUrl: url, prState: 'open' })),
        prUrls: urls,
      };
    }
    default:
      return none;
  }
}
