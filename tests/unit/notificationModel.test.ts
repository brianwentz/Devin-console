import { describe, expect, it } from 'vitest';
import { NotificationSourceSchema } from '../../src/core/providers';
import type { DevinSession } from '../../src/core/devinApi';
import {
  addNotification,
  clearNotifications,
  collapseSuperseded,
  deriveNotifications,
  itemKey,
  markAllRead,
  markRead,
  MAX_NOTIFICATIONS,
  pruneForeign,
  removeNotification,
  unreadCount,
  type AppNotification,
  type DeriveContext,
  type NotificationKind,
} from '../../src/core/notificationModel';

const ENABLED: Record<NotificationKind, boolean> = {
  usage: true,
  waiting: true,
  approval: true,
  blocked: true,
  finished: false, // off by default
  'pr-opened': true,
  'pr-completed': true,
  update: true,
  identity: true,
  auth: true,
};
const ctx = (over: Partial<DeriveContext> = {}): DeriveContext => ({
  enabled: ENABLED,
  now: 1000,
  ownerUserId: 'user-1',
  ...over,
});

const session = (
  id: string,
  status: string,
  detail: string | null = null,
  prs: { pr_url: string; pr_state: string | null }[] = [],
): DevinSession => ({
  session_id: id,
  title: `t-${id}`,
  status,
  status_detail: detail,
  created_at: 0,
  updated_at: 0,
  user_id: null,
  service_user_id: null,
  pull_requests: prs,
});

const note = (id: string, kind: NotificationKind = 'waiting', sessionId = 's'): AppNotification => ({
  id,
  kind,
  sessionId,
  sessionTitle: sessionId,
  title: 't',
  body: 'b',
  createdAt: 0,
  readAt: null,
});

describe('itemKey', () => {
  it('maps pr kinds to the prUrl', () => {
    const pr = { sessionId: 's1', prUrl: 'https://x/pr/1' };
    expect(itemKey({ ...pr, kind: 'pr-opened' })).toBe('pr:https://x/pr/1');
    expect(itemKey({ ...pr, kind: 'pr-completed' })).toBe('pr:https://x/pr/1');
    expect(itemKey({ kind: 'pr-opened', sessionId: 's1', prUrl: undefined })).toBe('pr:');
  });
  it('maps status kinds to source + sessionId (absent source = devin)', () => {
    for (const kind of ['waiting', 'approval', 'blocked', 'finished'] as const) {
      expect(itemKey({ kind, sessionId: 's1' })).toBe('session:devin:s1');
      expect(itemKey({ kind, sessionId: 's1', source: 'devin' })).toBe('session:devin:s1');
      expect(itemKey({ kind, sessionId: 's1', source: 'claude' })).toBe('session:claude:s1');
    }
    expect(itemKey({ kind: 'waiting', sessionId: null })).toBe('session:devin:');
  });
  it('maps update to a singleton and identity/auth to their kind', () => {
    expect(itemKey({ kind: 'usage', sessionId: null, metric: 'devin-monthly' })).toBe(
      'usage:devin-monthly:',
    );
    expect(
      itemKey({
        kind: 'usage',
        sessionId: null,
        metric: 'claude-weekly',
        accountKey: 'a@x.com',
      }),
    ).toBe('usage:claude-weekly:a@x.com');
    expect(itemKey({ kind: 'update', sessionId: null, version: '1.0.0' })).toBe('update');
    expect(itemKey({ kind: 'update', sessionId: null, version: '2.0.0' })).toBe('update');
    expect(itemKey({ kind: 'identity', sessionId: null })).toBe('identity');
    expect(itemKey({ kind: 'auth', sessionId: null })).toBe('auth');
  });
});

describe('addNotification', () => {
  it('prepends when the item is new', () => {
    let list: AppNotification[] = [];
    list = addNotification(list, { ...note('x', 'waiting', 's1'), title: 'a' }, 'id-1');
    list = addNotification(list, { ...note('x', 'waiting', 's2'), title: 'b' }, 'id-2');
    expect(list.map((n) => n.id)).toEqual(['id-2', 'id-1']);
  });
  it('supersedes an entry for the same item — even an unread one', () => {
    let list: AppNotification[] = [];
    list = addNotification(list, { ...note('x', 'waiting', 's1'), title: 'a', body: 'b1' }, 'id-1');
    list = addNotification(list, { ...note('x', 'waiting', 's2'), title: 'b', body: 'b2' }, 'id-2');
    // Same item again → the old entry is gone; the fresh id wins, still unread.
    list = addNotification(list, { ...note('x', 'waiting', 's1'), title: 'a2', body: 'b9' }, 'id-3');
    expect(list.map((n) => n.id)).toEqual(['id-3', 'id-2']);
    expect(list[0]!.body).toBe('b9');
    expect(list[0]!.readAt).toBeNull();
  });
  it('a pr-opened followed by a pr-completed for the same prUrl leaves only the completed one', () => {
    const prUrl = 'https://github.com/acme/widgets/pull/42';
    let list = addNotification(
      [],
      { ...note('x', 'pr-opened', 's1'), prUrl, title: 'Opened acme/widgets#42' },
      'id-open',
    );
    list = addNotification(
      list,
      { ...note('x', 'pr-completed', 's1'), prUrl, prState: 'merged', title: 'PR acme/widgets#42 merged' },
      'id-done',
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'id-done', kind: 'pr-completed', prUrl, readAt: null });
  });
  it('a usage 80 alert supersedes the 50 entry for the same metric+account', () => {
    const usage = (title: string, metric: AppNotification['metric'], accountKey = '') => ({
      kind: 'usage' as const,
      sessionId: null,
      sessionTitle: 'Usage',
      metric,
      accountKey,
      title,
      body: 'b',
      createdAt: 0,
    });
    let list = addNotification(
      [],
      usage('Devin Cloud monthly ACUs: 50% used', 'devin-monthly'),
      'id-50',
    );
    list = addNotification(
      list,
      usage('Devin Cloud monthly ACUs: 80% used', 'devin-monthly'),
      'id-80',
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toContain('80%');
    // A different metric (or account) is a different item — untouched.
    list = addNotification(
      list,
      usage('Claude weekly limit: 50% used', 'claude-weekly', 'a@x.com'),
      'id-cl',
    );
    expect(list).toHaveLength(2);
  });
  it('a waiting followed by a blocked for the same session leaves only the blocked one', () => {
    let list = addNotification([], note('x', 'waiting', 's1'), 'id-w');
    list = addNotification(list, note('x', 'blocked', 's1'), 'id-b');
    expect(list.map((n) => n.id)).toEqual(['id-b']);
    expect(list[0]!.kind).toBe('blocked');
  });
  it('a READ pr-opened is replaced by an UNREAD pr-completed', () => {
    const prUrl = 'https://github.com/acme/widgets/pull/7';
    let list = addNotification([], { ...note('x', 'pr-opened', 's1'), prUrl }, 'id-open');
    list = markRead(list, 'id-open', 5);
    list = addNotification(list, { ...note('x', 'pr-completed', 's1'), prUrl, prState: 'closed' }, 'id-done');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'id-done', kind: 'pr-completed', readAt: null });
  });
  it('does not collapse different prUrls or different sessions', () => {
    let list = addNotification(
      [],
      { ...note('x', 'pr-opened', 's1'), prUrl: 'https://x/pr/1' },
      'id-1',
    );
    list = addNotification(list, { ...note('x', 'pr-opened', 's1'), prUrl: 'https://x/pr/2' }, 'id-2');
    list = addNotification(list, note('x', 'waiting', 's2'), 'id-3');
    list = addNotification(list, note('x', 'blocked', 's1'), 'id-4');
    expect(list.map((n) => n.id)).toEqual(['id-4', 'id-3', 'id-2', 'id-1']);
  });
  it('a newer update entry replaces the older one', () => {
    let list = addNotification(
      [],
      { ...note('x', 'update', 'x'), sessionId: null, version: '1.0.0', title: 'Update v1.0.0 ready' },
      'id-1',
    );
    list = addNotification(
      list,
      { ...note('x', 'update', 'x'), sessionId: null, version: '2.0.0', title: 'Update v2.0.0 ready' },
      'id-2',
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'id-2', version: '2.0.0' });
  });
  it('a READ entry for the same item is superseded too — length stays 1', () => {
    let list = addNotification([], note('x', 'waiting', 's1'), 'id-1');
    list = markRead(list, 'id-1', 5);
    list = addNotification(list, { ...note('x', 'waiting', 's1') }, 'id-2');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'id-2', readAt: null });
  });
  it('caps at MAX_NOTIFICATIONS, dropping the oldest', () => {
    let list: AppNotification[] = [];
    for (let i = 0; i < MAX_NOTIFICATIONS + 3; i++) {
      list = addNotification(list, { ...note('x', 'waiting', `s${i}`) }, `id-${i}`);
    }
    expect(list).toHaveLength(MAX_NOTIFICATIONS);
    expect(list.at(-1)!.id).toBe('id-3');
  });
});

describe('collapseSuperseded', () => {
  it('keeps only the first (newest) entry per item, order preserved', () => {
    const prUrl = 'https://github.com/acme/widgets/pull/1';
    const list: AppNotification[] = [
      { ...note('n1', 'blocked', 's1'), createdAt: 5 },
      { ...note('n2', 'waiting', 's2'), createdAt: 4 },
      { ...note('n3', 'pr-completed', 's3'), prUrl, createdAt: 3 },
      { ...note('n4', 'waiting', 's1'), createdAt: 2 }, // superseded by n1
      { ...note('n5', 'pr-opened', 's3'), prUrl, createdAt: 1 }, // superseded by n3
    ];
    expect(collapseSuperseded(list).map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });
  it('is a no-op when every item is distinct', () => {
    const list = [note('a', 'waiting', 's1'), note('b', 'blocked', 's2')];
    expect(collapseSuperseded(list)).toEqual(list);
  });
});

describe('list ops', () => {
  it('markRead/markAllRead/remove/clear/unreadCount', () => {
    let list = [note('a'), note('b'), note('c')];
    expect(unreadCount(list)).toBe(3);
    list = markRead(list, 'b', 10);
    expect(unreadCount(list)).toBe(2);
    expect(list.find((n) => n.id === 'b')!.readAt).toBe(10);
    list = markAllRead(list, 20);
    expect(unreadCount(list)).toBe(0);
    list = removeNotification(list, 'a');
    expect(list).toHaveLength(2);
    expect(clearNotifications(list)).toEqual([]);
  });
});

describe('deriveNotifications', () => {
  const PR = 'https://github.com/acme/widgets/pull/42';
  it('is empty on the baseline poll (sessions absent from previous)', () => {
    expect(deriveNotifications([], [session('a', 'running', 'waiting_for_user')], ctx())).toEqual([]);
  });
  it('maps status transitions to kinds with bodies', () => {
    const prev = [session('a', 'running', 'working'), session('b', 'running', 'working'), session('c', 'running', 'working')];
    const next = [
      session('a', 'running', 'waiting_for_user'),
      session('b', 'running', 'waiting_for_approval'),
      session('c', 'blocked'),
    ];
    const out = deriveNotifications(prev, next, ctx());
    expect(out.map((n) => [n.sessionId, n.kind])).toEqual([
      ['a', 'waiting'],
      ['b', 'approval'],
      ['c', 'blocked'],
    ]);
    expect(out[0]!.body).toBe('Waiting for your reply');
  });
  it('does not re-notify the same effective status or finished when disabled', () => {
    const prev = [session('a', 'running', 'waiting_for_user')];
    const next = [session('a', 'running', 'waiting_for_approval')];
    // waiting→approval is a kind change → notifies once...
    expect(deriveNotifications(prev, next, ctx()).map((n) => n.kind)).toEqual(['approval']);
    // ...then approval→approval is quiet, and exit→finished is off by default.
    expect(deriveNotifications(next, next, ctx())).toEqual([]);
    expect(deriveNotifications(prev, [session('a', 'exit')], ctx())).toEqual([]);
    expect(
      deriveNotifications(prev, [session('a', 'exit')], ctx({ enabled: { ...ENABLED, finished: true } })),
    ).toEqual([expect.objectContaining({ kind: 'finished' })]);
  });
  it('emits pr-opened for a new PR and pr-completed on merged/closed', () => {
    const prev = [session('a', 'running', 'working', [{ pr_url: PR, pr_state: 'open' }])];
    const opened = deriveNotifications(
      prev,
      [session('a', 'running', 'working', [{ pr_url: PR, pr_state: 'open' }, { pr_url: PR + '9', pr_state: 'open' }])],
      ctx(),
    );
    expect(opened).toEqual([
      expect.objectContaining({ kind: 'pr-opened', prUrl: PR + '9', title: 'Opened acme/widgets#429' }),
    ]);
    const merged = deriveNotifications(
      prev,
      [session('a', 'running', 'working', [{ pr_url: PR, pr_state: 'merged' }])],
      ctx(),
    );
    expect(merged).toEqual([
      expect.objectContaining({ kind: 'pr-completed', prState: 'merged', title: 'PR acme/widgets#42 merged' }),
    ]);
    const closed = deriveNotifications(
      prev,
      [session('a', 'running', 'working', [{ pr_url: PR, pr_state: 'closed' }])],
      ctx(),
    );
    expect(closed[0]!.title).toBe('PR acme/widgets#42 closed');
    // Re-polling the same state emits nothing.
    expect(
      deriveNotifications(
        [session('a', 'running', 'working', [{ pr_url: PR, pr_state: 'merged' }])],
        [session('a', 'running', 'working', [{ pr_url: PR, pr_state: 'merged' }])],
        ctx(),
      ),
    ).toEqual([]);
  });
});

describe('pruneForeign', () => {
  it('drops legacy entries (no ownerUserId) with a sessionId', () => {
    const legacy = note('legacy', 'waiting', 'sess-legacy');
    expect('ownerUserId' in legacy).toBe(false);
    expect(pruneForeign([legacy], 'user-1')).toEqual([]);
  });
  it('drops entries owned by another user, keeps same-owner entries', () => {
    const foreign = { ...note('f', 'waiting', 'sess-other'), ownerUserId: 'user-other' };
    const own = { ...note('o', 'waiting', 'sess-own'), ownerUserId: 'user-1' };
    expect(pruneForeign([foreign, own], 'user-1')).toEqual([own]);
  });
  it('keeps sessionId:null entries for a user owner and a null owner', () => {
    const update = { ...note('u', 'update', 'x'), sessionId: null, ownerUserId: null };
    expect(pruneForeign([update], 'user-1')).toEqual([update]);
    expect(pruneForeign([update], null)).toEqual([update]);
  });
  it('with a null owner, drops every session-scoped entry', () => {
    const own = { ...note('o', 'waiting', 'sess-own'), ownerUserId: 'user-1' };
    const legacy = note('l', 'waiting', 'sess-legacy');
    const update = { ...note('u', 'update', 'x'), sessionId: null, ownerUserId: null };
    expect(pruneForeign([own, legacy, update], null)).toEqual([update]);
  });
  it('keeps Claude entries for a user owner and a null owner', () => {
    const claude: AppNotification = { ...note('c', 'waiting', 'uuid-1'), source: 'claude', ownerUserId: null };
    const foreign = { ...note('f', 'waiting', 'sess-other'), ownerUserId: 'user-other' };
    expect(pruneForeign([claude, foreign], 'u1')).toEqual([claude]);
    expect(pruneForeign([claude, foreign], null)).toEqual([claude]);
  });
});

describe('source isolation', () => {
  it('a Claude finished does not supersede a Devin finished for the same id', () => {
    let list = addNotification([], { ...note('x', 'finished', 'same-id'), ownerUserId: 'u1' }, 'id-devin');
    list = addNotification(list, { ...note('x', 'finished', 'same-id'), source: 'claude', ownerUserId: null }, 'id-claude');
    expect(list.map((n) => n.id)).toEqual(['id-claude', 'id-devin']);
    // And the persisted-history cleanup agrees.
    expect(collapseSuperseded(list).map((n) => n.id)).toEqual(['id-claude', 'id-devin']);
    // A second Claude entry still supersedes the first Claude one only.
    list = addNotification(list, { ...note('x', 'waiting', 'same-id'), source: 'claude', ownerUserId: null }, 'id-claude-2');
    expect(list.map((n) => n.id)).toEqual(['id-claude-2', 'id-devin']);
  });
});

describe('deriveNotifications ownerUserId', () => {
  it('stamps every entry with ctx.ownerUserId', () => {
    const prev = [session('a', 'running', 'working')];
    const next = [session('a', 'running', 'waiting_for_user')];
    const out = deriveNotifications(prev, next, ctx({ ownerUserId: 'user-9' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.ownerUserId).toBe('user-9');
    expect(deriveNotifications(prev, next, ctx({ ownerUserId: null }))[0]!.ownerUserId).toBeNull();
  });
});

describe('provider-derived source enum', () => {
  it('NotificationSourceSchema accepts exactly devin and claude', () => {
    expect(NotificationSourceSchema.safeParse('claude').success).toBe(true);
    expect(NotificationSourceSchema.safeParse('devin').success).toBe(true);
    expect(NotificationSourceSchema.safeParse('local').success).toBe(false);
    expect(NotificationSourceSchema.options).toEqual(['devin', 'claude']);
  });
  it('itemKey defaults the source to devin', () => {
    expect(itemKey({ kind: 'waiting', sessionId: 's1' } as never)).toBe('session:devin:s1');
  });
});
