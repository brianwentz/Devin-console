import { describe, expect, it, vi } from 'vitest';
import { CloudSessionsController } from '../../src/main/cloudKit/sessionsController';
import {
  buildOpenHandsShellState,
  createOpenHandsSource,
  type OpenHandsFetch,
  type OpenHandsFetchResult,
} from '../../src/main/openhands/source';
import { OpenHandsShellStateSchema } from '../../src/shared/ipc';

const BASE = 'https://oh.test';
const T = Date.parse('2026-10-20T10:00:00Z');
const item = (id: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `T-${id}`,
  selected_repository: 'o/r',
  git_provider: 'github',
  sandbox_status: 'RUNNING',
  execution_status: 'idle',
  updated_at: new Date(T + minutes * 60_000).toISOString(),
  session_api_key: 'SAK-fixture-secret',
  conversation_url: 'https://runtime.test/api/conversations/x',
  ...extra,
});
const page = (items: unknown[], next: string | null = null): OpenHandsFetchResult => ({
  status: 200,
  body: { items, next_page_id: next },
  mode: 'api-key',
});

function make(results: OpenHandsFetchResult[] | ((path: string) => OpenHandsFetchResult)) {
  const queue = Array.isArray(results) ? [...results] : null;
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const fetch: OpenHandsFetch = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return queue ? queue.shift()! : (results as (p: string) => OpenHandsFetchResult)(path);
  });
  const log = vi.fn();
  const source = createOpenHandsSource({ fetch, now: () => T, log, baseUrl: () => BASE });
  return { source, calls, log };
}
const query = (p: string) => new URL(p, BASE).searchParams;
const controllerFor = (source: ReturnType<typeof make>['source']) =>
  new CloudSessionsController(source, {
    tenantKey: () => BASE,
    readCache: async () => null,
    writeCache: async () => {},
    log: () => {},
  });

describe('openhands source', () => {
  it('merges two pages (2 calls) and sections by repository', async () => {
    const { source, calls } = make([page([item('a', 1)], 'p2'), page([item('b', 2, { selected_repository: 'o/z' })])]);
    const data = await source.list();
    expect(calls).toHaveLength(2);
    expect(query(calls[1]!.path).get('page_id')).toBe('p2');
    expect(data.sessions.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(data.folders).toEqual(['o/r', 'o/z']);
    expect(data.folderTotals).toEqual({ 'o/r': 1, 'o/z': 1 });
    expect(source.capabilities).toEqual({ folders: 'derived', archive: false, rename: true, delete: true, reorder: true });
  });

  it('a repeated next_page_id rejects the list with no third call; the shell state carries lastError.op list', async () => {
    const { source, calls } = make([page([item('a', 1)], 'p2'), page([item('b', 2)], 'p2')]);
    const controller = controllerFor(source);
    await controller.refresh('test');
    expect(calls).toHaveLength(2);
    const shell = buildOpenHandsShellState(controller.snapshot(), source.connection());
    expect(shell.status).toBe('error');
    expect(shell.lastError?.op).toBe('list');
    expect(shell.connection).toBe('api-key');
  });

  it('list() itself rejects on a repeated page id', async () => {
    const { source, calls } = make([page([item('a', 1)], 'p2'), page([item('b', 2)], 'p2')]);
    await expect(source.list()).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('poll 1 full, polls 2-9 incremental with updated_at__gte, poll 10 full without it', async () => {
    const { source, calls } = make(() => page([item('a', 5)]));
    for (let i = 0; i < 10; i++) await source.list();
    expect(calls).toHaveLength(10);
    expect(query(calls[0]!.path).has('updated_at__gte')).toBe(false);
    const cursor = Date.parse(query(calls[1]!.path).get('updated_at__gte')!);
    expect(cursor).toBe(T + 5 * 60_000 - 5000);
    for (let i = 1; i < 9; i++) expect(Date.parse(query(calls[i]!.path).get('updated_at__gte')!)).toBe(cursor);
    expect(query(calls[9]!.path).has('updated_at__gte')).toBe(false);
  });

  it('incremental polls merge; a full list drops conversations that vanished', async () => {
    const { source } = make([page([item('a', 1), item('b', 2)]), page([item('c', 3)]), page([item('a', 1)])]);
    expect((await source.list()).sessions).toHaveLength(2);
    expect((await source.list()).sessions.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
    source.requestFull();
    expect((await source.list()).sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('no key and 401 twice -> login-required', async () => {
    const { source } = make([{ status: 401, body: null, mode: 'web-session', error: 'login-required' }]);
    await expect(source.list()).rejects.toThrow(/login-required/);
    expect(source.connection()).toBe('login-required');
  });

  it('connection follows the auth mode', async () => {
    const { source } = make([page([]), { status: 401, body: null, mode: 'api-key', error: 'api-key-rejected' }]);
    await source.list();
    expect(source.connection()).toBe('api-key');
    await expect(source.list()).rejects.toThrow();
    expect(source.connection()).toBe('api-key-rejected');
  });

  it('redirect-refused surfaces as connection error with that code', async () => {
    const { source } = make([{ status: 0, body: null, mode: 'api-key', error: 'redirect-refused' }]);
    await expect(source.list()).rejects.toThrow(/redirect-refused/);
    expect(source.connection()).toBe('error');
  });

  it('maps a 403 on the key path to api-key-rejected and other non-2xx list results to error', async () => {
    const a = make([{ status: 403, body: null, mode: 'api-key' }]);
    await expect(a.source.list()).rejects.toThrow();
    expect(a.source.connection()).toBe('api-key-rejected');
    const b = make([{ status: 500, body: null, mode: 'api-key' }]);
    await expect(b.source.list()).rejects.toThrow();
    expect(b.source.connection()).toBe('error');
    const c = make([{ status: 404, body: null, mode: 'web-session' }]);
    await expect(c.source.list()).rejects.toThrow();
    expect(c.source.connection()).toBe('error');
  });

  it('a failed mutation does not flip the connection to error', async () => {
    const { source } = make([page([]), { status: 404, body: null, mode: 'api-key' }]);
    await source.list();
    await source.mutate!({ op: 'delete', id: 'x' });
    expect(source.connection()).toBe('api-key');
  });

  it('rename PATCHes {title}; delete DELETEs', async () => {
    const { source, calls, log } = make(() => ({ status: 200, body: {}, mode: 'api-key' }));
    expect(await source.mutate!({ op: 'rename', id: 'abc', title: 'New' })).toEqual({ ok: true, status: 200 });
    expect(calls[0]!.path).toBe('/api/v1/app-conversations/abc');
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ title: 'New' });
    expect(await source.mutate!({ op: 'delete', id: 'abc' })).toEqual({ ok: true, status: 200 });
    expect(calls[1]!.init?.method).toBe('DELETE');
    expect(log).toHaveBeenCalledWith('openhands-mutate', { op: 'delete', ok: true, status: 200 });
  });

  it('a successful mutation makes the next list full', async () => {
    const { source, calls } = make((p) =>
      p.includes('search') ? page([item('a', 5)]) : { status: 200, body: {}, mode: 'api-key' },
    );
    await source.list();
    await source.list();
    expect(query(calls[1]!.path).has('updated_at__gte')).toBe(true);
    await source.mutate!({ op: 'delete', id: 'a' });
    await source.list();
    expect(query(calls[3]!.path).has('updated_at__gte')).toBe(false);
  });

  it('a non-2xx mutation resolves ok:false', async () => {
    const { source } = make(() => ({ status: 404, body: null, mode: 'api-key' }));
    expect(await source.mutate!({ op: 'delete', id: 'x' })).toEqual({ ok: false, status: 404 });
  });

  it('logs openhands-list counts only and the snapshot never carries secrets', async () => {
    const { source, log } = make([page([item('a', 1)])]);
    const controller = controllerFor(source);
    await controller.refresh('test');
    const shell = buildOpenHandsShellState(controller.snapshot(), source.connection());
    expect(OpenHandsShellStateSchema.safeParse(shell).success).toBe(true);
    const text = JSON.stringify(shell) + JSON.stringify(controller.snapshot());
    expect(text).not.toContain('SAK-fixture-secret');
    expect(text).not.toContain('runtime.test');
    expect(log).toHaveBeenCalledWith('openhands-list', expect.objectContaining({ count: 1, incremental: false }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('SAK-fixture-secret');
  });

  it('reports isListing while a list is in flight', async () => {
    let release: (r: OpenHandsFetchResult) => void = () => {};
    const fetch: OpenHandsFetch = () => new Promise((resolve) => (release = resolve));
    const source = createOpenHandsSource({ fetch, now: () => T, log: () => {}, baseUrl: () => BASE });
    const p = source.list();
    expect(source.isListing()).toBe(true);
    release(page([]));
    await p;
    expect(source.isListing()).toBe(false);
  });

  it('stop never throws', () => {
    const { source } = make([]);
    expect(() => {
      source.start(() => {});
      source.stop();
      source.stop();
    }).not.toThrow();
  });
});

describe('openhands source transitions', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const withTransitions = (results: OpenHandsFetchResult[]) => {
    const queue = [...results];
    const seen: { id: string; kind: string; title: string }[][] = [];
    const fetch: OpenHandsFetch = vi.fn(async () => queue.shift()!);
    const source = createOpenHandsSource({
      fetch,
      now: () => T,
      log: vi.fn(),
      baseUrl: () => BASE,
      onTransitions: (t) => seen.push(t.map((x) => ({ id: x.id, kind: x.kind, title: x.row.title }))),
    });
    return { source, seen };
  };
  const running = (id: string) => item(id, 1, { id, execution_status: 'running' });
  const finished = (id: string, minutes = 2) => item(id, minutes, { id, execution_status: 'finished' });

  it('first list is a baseline; the next running -> finished emits once', async () => {
    const { source, seen } = withTransitions([page([running(A)]), page([finished(A)])]);
    await source.list();
    expect(seen).toEqual([]);
    source.requestFull();
    await source.list();
    expect(seen).toEqual([[{ id: A, kind: 'finished', title: `T-${A}` }]]);
  });
  it('an incremental list diffs only its rows against the full map', async () => {
    const { source, seen } = withTransitions([page([running(A), running(B)]), page([finished(B, 5)]), page([])]);
    await source.list();
    await source.list(); // incremental: only B changed
    expect(seen).toEqual([[{ id: B, kind: 'finished', title: `T-${B}` }]]);
    await source.list(); // A absent from the incremental list: silent
    expect(seen).toHaveLength(1);
  });
  it('a failed list leaves the map intact', async () => {
    const { source, seen } = withTransitions([
      page([running(A)]),
      { status: 500, body: null, mode: 'api-key' },
      page([finished(A)]),
    ]);
    await source.list();
    await expect(source.list()).rejects.toThrow();
    await source.list();
    expect(seen).toEqual([[{ id: A, kind: 'finished', title: `T-${A}` }]]);
  });
});
