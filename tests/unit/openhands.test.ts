import { describe, expect, it } from 'vitest';
import {
  PagingError,
  apiUrl,
  conversationIdFromUrl,
  conversationUrl,
  listAllPages,
  mapStatus,
  mergeRows,
  nextCursor,
  normalizeBaseUrl,
  parseSearchPage,
  prUrl,
  statusTransitions,
  toCloudSession,
  type OhRow,
} from '../../src/core/openhands';
import { CloudSessionSchema } from '../../src/shared/ipc';

const ID = 'a'.repeat(32);
const row = (over: Partial<OhRow> = {}): OhRow => ({
  id: ID,
  title: 'T',
  updatedAt: 1000,
  status: 'running',
  section: 'o/r',
  repo: 'o/r',
  gitProvider: 'github',
  prUrls: [],
  cost: null,
  ...over,
});

describe('normalizeBaseUrl / apiUrl / conversation urls', () => {
  it('normalizes', () => {
    expect(normalizeBaseUrl('https://oh.corp/')).toBe('https://oh.corp');
    expect(normalizeBaseUrl('https://corp/openhands/')).toBe('https://corp/openhands');
    expect(normalizeBaseUrl('http://x')).toBeNull();
    expect(normalizeBaseUrl('http://x', true)).toBe('http://x');
    expect(normalizeBaseUrl('nonsense')).toBeNull();
    expect(normalizeBaseUrl('ftp://x')).toBeNull();
  });
  it('builds api urls skipping undefined', () => {
    expect(
      apiUrl('https://corp/openhands', '/api/v1/app-conversations/search', { limit: 100, page_id: undefined }),
    ).toBe('https://corp/openhands/api/v1/app-conversations/search?limit=100');
    expect(apiUrl('https://c', 'api/x')).toBe('https://c/api/x');
    expect(apiUrl('https://corp/openhands/', '/api/v1/x')).toBe('https://corp/openhands/api/v1/x');
  });
  it('round-trips conversation urls', () => {
    const u = conversationUrl('https://corp/openhands', ID);
    expect(u).toBe(`https://corp/openhands/conversations/${ID}`);
    expect(conversationIdFromUrl('https://corp/openhands', u)).toBe(ID);
    expect(conversationIdFromUrl('https://corp/openhands', 'https://corp/openhands/conversations/xyz')).toBeNull();
    expect(conversationUrl('https://oh.corp/', ID)).toBe(`https://oh.corp/conversations/${ID}`);
    expect(conversationIdFromUrl('https://oh.corp', `https://oh.corp/conversations/${ID}?x=1`)).toBe(ID);
    expect(conversationIdFromUrl('https://oh.corp', `https://oh.corp/conversations/${ID}f`)).toBeNull();
    const g = /\/conversations\/([0-9a-f]{32})/g;
    expect(conversationIdFromUrl('https://oh.corp', `https://oh.corp/conversations/${ID}`, g)).toBe(ID);
    expect(conversationIdFromUrl('https://oh.corp', `https://oh.corp/conversations/${ID}`, g)).toBe(ID);
    expect(conversationIdFromUrl('https://corp/openhands', `https://other/conversations/${ID}`)).toBeNull();
  });
});

describe('mapStatus', () => {
  it('maps the documented pairs', () => {
    expect(mapStatus('RUNNING', 'waiting_for_confirmation')).toBe('waiting');
    expect(mapStatus('RUNNING', 'stuck')).toBe('error');
    expect(mapStatus('PAUSED', null)).toBe('paused');
    expect(mapStatus('STARTING', null)).toBe('starting');
    expect(mapStatus('RUNNING', 'finished')).toBe('finished');
    expect(mapStatus('ERROR', null)).toBe('error');
    expect(mapStatus('MISSING', null)).toBe('paused');
  });
  it('is conservative and case-insensitive', () => {
    expect(mapStatus('weird', null)).toBe('paused');
    expect(mapStatus(null, null)).toBe('paused');
    expect(mapStatus('running', 'finished')).toBe('finished');
    expect(mapStatus('RUNNING', 'something_new')).toBe('running');
    expect(mapStatus('RUNNING', null)).toBe('running');
    expect(mapStatus('RUNNING', 'idle')).toBe('idle');
  });
  it('ignores execution status unless the sandbox is running', () => {
    expect(mapStatus('PAUSED', 'finished')).toBe('paused');
  });
});

describe('prUrl', () => {
  it('builds per provider', () => {
    expect(prUrl('github', 'o/r', 7)).toBe('https://github.com/o/r/pull/7');
    expect(prUrl('gitlab', 'o/r', 7)).toBe('https://gitlab.com/o/r/-/merge_requests/7');
    expect(prUrl('bitbucket', 'o/r', 7)).toBe('https://bitbucket.org/o/r/pull-requests/7');
    expect(prUrl('forgejo', 'o/r', 7)).toBeNull();
    expect(prUrl(null, 'o/r', 7)).toBeNull();
    expect(prUrl('github', null, 7)).toBeNull();
    expect(prUrl('github', 'o/r?x#', 7)).toBeNull();
    expect(prUrl('github', '../..', 7)).toBeNull();
    expect(prUrl('github', 'o/r', 0)).toBeNull();
    expect(prUrl('github', 'o/r', 1.5)).toBeNull();
  });
});

describe('parseSearchPage', () => {
  it('maps items and never copies secrets', () => {
    const page = parseSearchPage({
      items: [
        {
          id: ID,
          title: null,
          selected_repository: null,
          sandbox_status: 'RUNNING',
          execution_status: 'finished',
          updated_at: '2026-10-22T10:00:00Z',
          session_api_key: 'SECRET-KEY',
          conversation_url: 'https://agent/api/conversations/x',
          metrics: { accumulated_cost: 1.5 },
        },
        {
          id: 'b'.repeat(32),
          title: 'Fix',
          selected_repository: 'o/r',
          git_provider: 'github',
          pr_number: [3, 4],
          sandbox_status: 'PAUSED',
          execution_status: null,
          created_at: '2026-10-22T09:00:00',
          extra_unknown: { a: 1 },
        },
        { nope: true },
      ],
      next_page_id: 'p2',
    });
    expect(page.nextPageId).toBe('p2');
    expect(page.items).toHaveLength(2);
    const a = page.items[0]!;
    const b = page.items[1]!;
    expect(a.title).toBe('Untitled conversation');
    expect(parseSearchPage({ items: [{ id: 'x', title: '  Hi  ' }] }).items[0]?.title).toBe('  Hi  '.trim());
    expect(a.section).toBe('No repository');
    expect(a.repo).toBeNull();
    expect(a.status).toBe('finished');
    expect(a.cost).toBe(1.5);
    expect(a.updatedAt).toBe(Date.parse('2026-10-22T10:00:00Z'));
    const s = JSON.stringify(page);
    expect(s).not.toContain('session_api_key');
    expect(s).not.toContain('SECRET-KEY');
    expect(s).not.toContain('conversation_url');
    expect(s).not.toContain('agent/api');
    expect(b.section).toBe('o/r');
    expect(b.prUrls).toEqual(['https://github.com/o/r/pull/3', 'https://github.com/o/r/pull/4']);
    expect(b.updatedAt).toBe(Date.parse('2026-10-22T09:00:00Z'));
    expect(b.cost).toBeNull();
    expect(b.status).toBe('paused');
  });
  it('tolerates garbage', () => {
    expect(parseSearchPage(null)).toEqual({ items: [], nextPageId: null });
    expect(parseSearchPage({ items: 3 })).toEqual({ items: [], nextPageId: null });
  });
});

describe('cursor and merge', () => {
  it('nextCursor uses server times', () => {
    expect(nextCursor([row({ updatedAt: 1000 }), row({ id: 'b', updatedAt: 9000 })], null)).toBe(4000);
    expect(nextCursor([], 123)).toBe(123);
    expect(nextCursor([], null)).toBeNull();
    expect(nextCursor([row({ updatedAt: 0 })], null)).toBeNull();
    expect(nextCursor([row({ updatedAt: 0 })], 77)).toBe(77);
    expect(nextCursor([row({ updatedAt: 2000 })], null)).toBe(0);
    expect(nextCursor([row({ updatedAt: 9000 })], 9999)).toBe(9999);
  });
  it('mergeRows dedups newest wins, sorted desc', () => {
    const merged = mergeRows(
      [row({ id: 'a', updatedAt: 1, title: 'old' }), row({ id: 'b', updatedAt: 5 })],
      [row({ id: 'a', updatedAt: 9, title: 'new' }), row({ id: 'c', updatedAt: 3 })],
    );
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(merged[0]?.title).toBe('new');
    expect(
      mergeRows([row({ id: 'a', updatedAt: 9, title: 'keep' })], [row({ id: 'a', updatedAt: 1 })])[0]?.title,
    ).toBe('keep');
  });
});

describe('statusTransitions', () => {
  const prev = (id: string, s: OhRow['status']) => new Map([[id, s]]);
  it('reports entering finished / waiting / error', () => {
    expect(statusTransitions(prev('a', 'running'), [row({ id: 'a', status: 'finished' })])).toEqual([
      { id: 'a', kind: 'finished' },
    ]);
    expect(statusTransitions(prev('a', 'running'), [row({ id: 'a', status: 'waiting' })])).toEqual([
      { id: 'a', kind: 'waiting' },
    ]);
    expect(statusTransitions(prev('a', 'running'), [row({ id: 'a', status: 'error' })])).toEqual([
      { id: 'a', kind: 'blocked' },
    ]);
  });
  it('is silent otherwise', () => {
    expect(statusTransitions(prev('a', 'running'), [row({ id: 'a', status: 'paused' })])).toEqual([]);
    expect(statusTransitions(prev('a', 'running'), [row({ id: 'a', status: 'idle' })])).toEqual([]);
    expect(statusTransitions(prev('a', 'finished'), [row({ id: 'a', status: 'idle' })])).toEqual([]);
    expect(statusTransitions(prev('a', 'finished'), [row({ id: 'a', status: 'finished' })])).toEqual([]);
    expect(statusTransitions(prev('a', 'running'), [row({ id: 'z', status: 'finished' })])).toEqual([]);
    expect(statusTransitions(new Map(), [row({ id: 'a', status: 'finished' })])).toEqual([]);
  });
});

describe('listAllPages', () => {
  it('merges pages', async () => {
    const pages: Record<string, { items: number[]; nextPageId: string | null }> = {
      first: { items: [1, 2], nextPageId: 'p2' },
      p2: { items: [3], nextPageId: null },
    };
    const seen: (string | null)[] = [];
    const out = await listAllPages<number>(async (id) => {
      seen.push(id);
      return pages[id ?? 'first']!;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(seen).toEqual([null, 'p2']);
  });
  it('throws on a repeated page id without another call', async () => {
    let calls = 0;
    await expect(
      listAllPages<number>(async () => {
        calls++;
        return { items: [1], nextPageId: 'same' };
      }),
    ).rejects.toBeInstanceOf(PagingError);
    expect(calls).toBe(2);
  });
  it('throws past the cap', async () => {
    let n = 0;
    let calls = 0;
    await expect(
      listAllPages<number>(async () => {
        calls++;
        return { items: [1], nextPageId: `p${n++}` };
      }, 3),
    ).rejects.toBeInstanceOf(PagingError);
    expect(calls).toBe(3);
  });
});

describe('toCloudSession', () => {
  it('produces a schema-valid row', () => {
    const r = row({ cost: 2.5, status: 'waiting', prUrls: ['https://github.com/o/r/pull/1'] });
    const s = toCloudSession(r, 'https://corp/openhands');
    expect(CloudSessionSchema.parse(s)).toEqual(s);
    expect(s.url).toBe(`https://corp/openhands/conversations/${ID}`);
    expect(s.section).toBe('o/r');
    expect(s.cost).toBe(2.5);
    expect(s.updatedAt).toBe(1000);
    expect(s.status).toBe('waiting');
    expect(s.prs.open).toBe(1);
    const idle = toCloudSession(row({ status: 'idle' }), 'https://corp');
    expect(CloudSessionSchema.parse(idle).status).toBe('idle');
  });
});
