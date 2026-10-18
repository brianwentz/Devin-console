import { describe, expect, it } from 'vitest';
import type { ClaudeHookEvent } from '../../src/core/claudeActivity';
import { notificationsForHookEvent, PERMISSION_DEDUP_MS, type ClaudeNotifyContext } from '../../src/core/claudeNotify';

const PR = 'https://github.com/acme/widgets/pull/42';
const PR2 = 'https://github.com/acme/widgets/pull/43';

const ev = (event: string, over: Partial<ClaudeHookEvent> = {}): ClaudeHookEvent => ({
  event,
  session_id: 'A',
  cwd: '/work/widgets',
  receivedAt: 1000,
  ...over,
});

const ctx = (over: Partial<ClaudeNotifyContext> = {}): ClaudeNotifyContext => ({
  titleFor: (id, cwd) => `title:${id}:${cwd ?? '-'}`,
  enabled: { waiting: true, finished: true, prOpened: true },
  now: 5000,
  recentPermission: new Map(),
  ...over,
});

const bash = (command: string, tool_response: unknown, over: Partial<ClaudeHookEvent> = {}) =>
  ev('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response, ...over });

describe('notificationsForHookEvent — waiting', () => {
  it('PermissionRequest → waiting with the common envelope and records recentPermission', () => {
    const c = ctx();
    const res = notificationsForHookEvent(ev('PermissionRequest', { tool_name: 'Write' }), c);
    expect(res.prUrls).toEqual([]);
    expect(res.notifications).toEqual([
      {
        kind: 'waiting',
        sessionId: 'A',
        source: 'claude',
        ownerUserId: null,
        sessionTitle: 'title:A:/work/widgets',
        title: 'Waiting for permission',
        body: 'Write in title:A:/work/widgets',
        createdAt: 5000,
      },
    ]);
    expect(c.recentPermission.get('A')).toBe(5000);
  });
  it('falls back to "A tool" without tool_name and passes an undefined cwd to titleFor', () => {
    const { cwd: _cwd, ...noCwd } = ev('PermissionRequest');
    const res = notificationsForHookEvent(noCwd, ctx());
    expect(res.notifications[0]!.body).toBe('A tool in title:A:-');
  });
  it('Notification{permission_prompt} → waiting when no recent PermissionRequest', () => {
    const res = notificationsForHookEvent(ev('Notification', { notification_type: 'permission_prompt' }), ctx());
    expect(res.notifications.map((n) => n.kind)).toEqual(['waiting']);
  });
  it.each([
    ['same instant', 0, 0],
    ['4999 ms later', PERMISSION_DEDUP_MS - 1, 0],
    ['exactly 5 s later', PERMISSION_DEDUP_MS, 1],
    ['much later', 60_000, 1],
  ])('permission_prompt %s after a PermissionRequest → %d entries', (_n, delta, count) => {
    const c = ctx();
    notificationsForHookEvent(ev('PermissionRequest'), c);
    const res = notificationsForHookEvent(ev('Notification', { notification_type: 'permission_prompt' }), { ...c, now: 5000 + delta });
    expect(res.notifications).toHaveLength(count);
  });
  it('de-dup is per session', () => {
    const c = ctx();
    notificationsForHookEvent(ev('PermissionRequest'), c);
    const res = notificationsForHookEvent(ev('Notification', { notification_type: 'permission_prompt', session_id: 'B' }), c);
    expect(res.notifications).toHaveLength(1);
    expect(res.notifications[0]!.sessionId).toBe('B');
  });
  it('disabled waiting → none, but PermissionRequest still records the de-dup timestamp', () => {
    const c = ctx({ enabled: { waiting: false, finished: true, prOpened: true } });
    expect(notificationsForHookEvent(ev('PermissionRequest'), c).notifications).toEqual([]);
    expect(c.recentPermission.get('A')).toBe(5000);
    expect(notificationsForHookEvent(ev('Notification', { notification_type: 'permission_prompt' }), c).notifications).toEqual([]);
  });
});

describe('notificationsForHookEvent — finished', () => {
  it.each([
    ['Stop', ev('Stop')],
    ['Notification{idle_prompt}', ev('Notification', { notification_type: 'idle_prompt' })],
  ])('%s → finished', (_n, e) => {
    const res = notificationsForHookEvent(e, ctx());
    expect(res.notifications).toEqual([
      expect.objectContaining({
        kind: 'finished',
        source: 'claude',
        ownerUserId: null,
        sessionId: 'A',
        title: 'Finished a turn',
        body: 'title:A:/work/widgets',
        sessionTitle: 'title:A:/work/widgets',
        createdAt: 5000,
      }),
    ]);
  });
  it('disabled finished → none', () => {
    const c = ctx({ enabled: { waiting: true, finished: false, prOpened: true } });
    expect(notificationsForHookEvent(ev('Stop'), c).notifications).toEqual([]);
  });
});

describe('notificationsForHookEvent — pr-opened', () => {
  it('Bash `gh pr create` with a PR URL in a string tool_response → one pr-opened + the URL', () => {
    const res = notificationsForHookEvent(bash('gh pr create --fill', `Creating pull request...\n${PR}\n`), ctx());
    expect(res.prUrls).toEqual([PR]);
    expect(res.notifications).toEqual([
      {
        kind: 'pr-opened',
        sessionId: 'A',
        source: 'claude',
        ownerUserId: null,
        sessionTitle: 'title:A:/work/widgets',
        title: 'Opened a pull request',
        body: 'title:A:/work/widgets',
        createdAt: 5000,
        prUrl: PR,
        prState: 'open',
      },
    ]);
  });
  it.each([
    ['{stdout}', { stdout: PR }],
    ['{output}', { output: `done ${PR}` }],
    ['{content}', { content: PR }],
    ['string[]', ['line 1', PR]],
    ['ANSI + OSC 8 hyperlink', `\x1b[32m\x1b]8;;${PR}\x07${PR}\x1b]8;;\x07\x1b[0m`],
  ])('reads tool_response shaped %s', (_n, response) => {
    const res = notificationsForHookEvent(bash('gh pr create', response), ctx());
    expect(res.prUrls).toEqual([PR]);
  });
  it('dedups within one event and emits one entry per distinct URL', () => {
    const res = notificationsForHookEvent(bash('gh pr view', `${PR} ${PR2}?x=1 ${PR}`), ctx());
    expect(res.prUrls).toEqual([PR, PR2]);
    expect(res.notifications.map((n) => n.prUrl)).toEqual([PR, PR2]);
  });
  it.each([
    ['non-gh Bash', bash('git push origin HEAD', PR)],
    ['gh but not pr', bash('gh issue create', PR)],
    ['ghpr without the word boundary', bash('ghpr create', PR)],
    ['gh pr with no URL in the response', bash('gh pr create', 'nothing here')],
    ['gh pr with a non-PR GitHub URL', bash('gh pr create', 'https://github.com/acme/widgets/issues/1')],
    ['non-Bash tool', bash('gh pr create', PR, { tool_name: 'Write' })],
    ['missing tool_input', ev('PostToolUse', { tool_name: 'Bash', tool_response: PR })],
    ['non-string command', bash('x', PR, { tool_input: { command: 42 } })],
    ['unsupported tool_response shape', bash('gh pr create', { nested: { stdout: PR } })],
  ])('%s → empty', (_n, e) => {
    expect(notificationsForHookEvent(e, ctx())).toEqual({ notifications: [], prUrls: [] });
  });
  it('matches gh pr with varied whitespace', () => {
    expect(notificationsForHookEvent(bash('cd x && gh  pr\tcreate', PR), ctx()).prUrls).toEqual([PR]);
  });
  it('honours githubOrigins for enterprise hosts', () => {
    const ghe = 'https://git.corp.example/acme/widgets/pull/7';
    expect(notificationsForHookEvent(bash('gh pr create', ghe), ctx()).prUrls).toEqual([]);
    expect(notificationsForHookEvent(bash('gh pr create', ghe), ctx({ githubOrigins: ['https://git.corp.example'] })).prUrls).toEqual([ghe]);
  });
  it('disabled prOpened → no notification but URLs still returned for auto-open', () => {
    const c = ctx({ enabled: { waiting: true, finished: true, prOpened: false } });
    expect(notificationsForHookEvent(bash('gh pr create', PR), c)).toEqual({ notifications: [], prUrls: [PR] });
  });
});

describe('notificationsForHookEvent — everything else', () => {
  it.each([
    ['UserPromptSubmit', ev('UserPromptSubmit')],
    ['SessionEnd', ev('SessionEnd')],
    ['Notification{other}', ev('Notification', { notification_type: 'auth_success' })],
    ['Notification without type', ev('Notification')],
    ['unknown event', ev('PreToolUse')],
    ['empty session id', ev('Stop', { session_id: '' })],
  ])('%s → empty', (_n, e) => {
    expect(notificationsForHookEvent(e, ctx())).toEqual({ notifications: [], prUrls: [] });
  });
});
