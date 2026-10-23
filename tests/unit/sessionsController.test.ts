import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSessionsController } from '../../src/main/cloudKit/sessionsController';
import type { CloudMutation, CloudSessionSource } from '../../src/main/cloudKit/source';
import type { CloudCache } from '../../src/core/cloudCache';
import type { CloudListData } from '../../src/core/sessionTree';
import type { CloudSessionState } from '../../src/shared/ipc';

const session = (id: string, extra: Partial<CloudSessionState> = {}): CloudSessionState => ({
  id,
  acpId: id,
  title: `t-${id}`,
  url: `https://oh.example/conversations/${id}`,
  status: 'running',
  statusEnum: null,
  userActionRequired: null,
  folder: null,
  parentId: null,
  isPinned: false,
  isUnread: false,
  isStarred: false,
  directChildrenCount: 0,
  hasMoreChildren: false,
  prs: { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 },
  isArchived: false,
  updatedAt: 1,
  ...extra,
});

const list = (...ids: string[]): CloudListData => ({
  sessions: ids.map((id) => session(id)),
  folders: [],
  folderTotals: {},
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeSource(
  overrides: {
    capabilities?: CloudSessionSource['capabilities'];
    list?: () => Promise<CloudListData>;
    mutate?: (op: CloudMutation) => Promise<{ ok: boolean; status: number }>;
  } = {},
) {
  let onChange: (() => void) | null = null;
  const source = {
    providerId: 'openhands',
    capabilities: overrides.capabilities ?? {
      folders: 'derived',
      archive: false,
      rename: true,
      delete: true,
      reorder: true,
    },
    start: vi.fn((cb: () => void) => {
      onChange = cb;
    }),
    stop: vi.fn(),
    list: vi.fn(overrides.list ?? (async () => list('a'))),
    mutate: vi.fn(overrides.mutate ?? (async (_op: CloudMutation) => ({ ok: true, status: 200 }))),
    readIdentity: vi.fn(async (): Promise<{ identity: unknown }> => ({ identity: {} })),
  } satisfies CloudSessionSource;
  return { source, fireChange: () => onChange?.() };
}

function makeController(
  source: CloudSessionSource,
  opts: {
    cache?: unknown;
    tenant?: string;
    readCache?: () => Promise<unknown>;
    writeCache?: (data: CloudCache) => Promise<void>;
    onChange?: () => void;
    pollMs?: number;
  } = {},
) {
  const written: CloudCache[] = [];
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  const onChange = vi.fn();
  const controller = new CloudSessionsController(source, {
    tenantKey: () => opts.tenant ?? 'https://app.all-hands.dev',
    readCache: opts.readCache ?? (async () => opts.cache ?? null),
    writeCache: async (data) => {
      written.push(data);
      await opts.writeCache?.(data);
    },
    log: (event, detail) => events.push({ event, detail }),
    sanitize: (message) => message.split('SECRET').join('[redacted]'),
    onChange: () => {
      onChange();
      opts.onChange?.();
    },
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
  });
  return { controller, written, events, onChange };
}

const cacheFor = (tenantUrl: string, ...ids: string[]): CloudCache => ({
  version: 1,
  tenantUrl,
  savedAt: '2026-10-01T00:00:00.000Z',
  sessions: ids.map((id) => session(id)),
  folders: [],
  folderTotals: {},
});

let active: CloudSessionsController | null = null;
afterEach(() => {
  active?.stop();
  active = null;
});

describe('CloudSessionsController', () => {
  it('concurrent refresh() calls coalesce into one in-flight list + one follow-up', async () => {
    const first = deferred<CloudListData>();
    const second = deferred<CloudListData>();
    const calls = [first, second];
    const { source } = fakeSource({ list: vi.fn(() => calls.shift()!.promise) });
    const { controller } = makeController(source);
    active = controller;

    const p1 = controller.refresh('a');
    const p2 = controller.refresh('b');
    const p3 = controller.refresh('c');
    await flush();
    expect(source.list).toHaveBeenCalledTimes(1);

    let settled = false;
    void Promise.all([p1, p2, p3]).then(() => {
      settled = true;
    });
    first.resolve(list('a'));
    await flush();
    // The dirty follow-up starts after the first list settles; callers wait for it.
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    second.resolve(list('a', 'b'));
    await Promise.all([p1, p2, p3]);
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(controller.snapshot().status).toBe('ready');

    // Idle again: the next refresh lists once more.
    await controller.refresh('d');
    expect(source.list).toHaveBeenCalledTimes(3);
  });

  it('a rejected mutate sets lastError {op,message} (sanitised); the next successful list clears it', async () => {
    const { source } = fakeSource({
      mutate: vi.fn(async () => {
        throw new Error('boom SECRET token');
      }),
    });
    const { controller, onChange } = makeController(source);
    active = controller;
    await controller.refresh('start');

    await controller.mutate({ op: 'rename', id: 'a', title: 'new' });
    expect(source.mutate).toHaveBeenCalledWith({ op: 'rename', id: 'a', title: 'new' });
    expect(controller.snapshot().lastError).toEqual({ op: 'rename', message: 'boom [redacted] token' });
    expect(onChange).toHaveBeenCalled();
    // A failed mutate does not re-list.
    expect(source.list).toHaveBeenCalledTimes(1);

    await controller.refresh('manual');
    expect(controller.snapshot().lastError).toBeNull();
  });

  it('a non-ok mutate response sets lastError with the status', async () => {
    const { source } = fakeSource({ mutate: vi.fn(async () => ({ ok: false, status: 409 })) });
    const { controller, events } = makeController(source);
    active = controller;
    await controller.mutate({ op: 'delete', id: 'a' });
    expect(controller.snapshot().lastError).toEqual({ op: 'delete', message: 'HTTP 409' });
    expect(events).toContainEqual({
      event: 'cloud-sessions-mutate',
      detail: { provider: 'openhands', op: 'delete', ok: false, status: 409 },
    });
  });

  it('a successful mutate refreshes the list', async () => {
    const { source } = fakeSource();
    const { controller } = makeController(source);
    active = controller;
    await controller.mutate({ op: 'delete', id: 'a' });
    expect(source.mutate).toHaveBeenCalledTimes(1);
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().lastError).toBeNull();
  });

  it('a mutation the source cannot perform sets lastError without calling the source', async () => {
    const { source } = fakeSource({
      capabilities: { folders: 'none', archive: false, rename: false, delete: true, reorder: false },
    });
    const { controller } = makeController(source);
    active = controller;
    await controller.mutate({ op: 'rename', id: 'a', title: 'x' });
    expect(source.mutate).not.toHaveBeenCalled();
    expect(controller.snapshot().lastError).toEqual({ op: 'rename', message: 'unsupported' });

    const { source: noMutate } = fakeSource();
    const bare: CloudSessionSource = {
      providerId: noMutate.providerId,
      capabilities: noMutate.capabilities,
      start: noMutate.start,
      stop: noMutate.stop,
      list: noMutate.list,
      readIdentity: noMutate.readIdentity,
    };
    const second = makeController(bare);
    await second.controller.mutate({ op: 'delete', id: 'a' });
    expect(second.controller.snapshot().lastError).toEqual({ op: 'delete', message: 'unsupported' });
    second.controller.stop();
  });

  it('a cache loaded before the first list sets cached:true; a live list clears it and is written back', async () => {
    const live = deferred<CloudListData>();
    const { source } = fakeSource({ list: vi.fn(() => live.promise) });
    const tenant = 'https://app.all-hands.dev';
    const { controller, written, events } = makeController(source, {
      tenant,
      cache: cacheFor(`${tenant}/`, 'cached1', 'cached2'),
    });
    active = controller;

    expect(controller.snapshot().status).toBe('connecting');
    const started = controller.start();
    await flush();
    const snap = controller.snapshot();
    expect(snap.cached).toBe(true);
    expect(snap.sessions.map((s) => s.id)).toEqual(['cached1', 'cached2']);
    expect(snap.lastSyncAt).toBe('2026-10-01T00:00:00.000Z');
    expect(snap.status).toBe('connecting');
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      event: 'cloud-sessions-cache',
      detail: { provider: 'openhands', loaded: true, count: 2 },
    });

    live.resolve(list('live'));
    await started;
    await flush();
    const after = controller.snapshot();
    expect(after.cached).toBe(false);
    expect(after.sessions.map((s) => s.id)).toEqual(['live']);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ version: 1, tenantUrl: tenant, folders: [], folderTotals: {} });
    expect(written[0]!.sessions.map((s) => s.id)).toEqual(['live']);

    // An identical list is not re-written.
    source.list.mockImplementation(async () => list('live'));
    await controller.refresh('manual');
    await flush();
    expect(written).toHaveLength(1);
  });

  it('a cache for a different tenant key is ignored', async () => {
    const live = deferred<CloudListData>();
    const { source } = fakeSource({ list: vi.fn(() => live.promise) });
    const { controller, events } = makeController(source, {
      tenant: 'https://app.all-hands.dev',
      cache: cacheFor('https://other.example', 'x'),
    });
    active = controller;
    void controller.start();
    await flush();
    expect(controller.snapshot().cached).toBe(false);
    expect(controller.snapshot().sessions).toEqual([]);
    expect(events).toContainEqual({
      event: 'cloud-sessions-cache',
      detail: { provider: 'openhands', loaded: false },
    });
    live.resolve(list());
  });

  it('a malformed cache or a failing read is a miss', async () => {
    const { source } = fakeSource();
    const bad = makeController(source, { cache: { version: 2, nonsense: true } });
    await bad.controller.start();
    expect(bad.controller.snapshot().cached).toBe(false);
    bad.controller.stop();

    const { source: s2 } = fakeSource();
    const failing = makeController(s2, {
      readCache: async () => {
        throw Object.assign(new Error('ENOENT C:\\secret\\path'), { code: 'ENOENT' });
      },
    });
    await failing.controller.start();
    expect(failing.controller.snapshot().status).toBe('ready');
    expect(JSON.stringify(failing.events)).not.toContain('secret');
    failing.controller.stop();
  });

  it('a cache read that lands after a live list does not overwrite it', async () => {
    const cache = deferred<unknown>();
    const { source } = fakeSource({ list: vi.fn(async () => list('live')) });
    const { controller } = makeController(source, { readCache: () => cache.promise });
    active = controller;
    const started = controller.start();
    await controller.refresh('manual');
    cache.resolve(cacheFor('https://app.all-hands.dev', 'stale'));
    await started;
    expect(controller.snapshot().cached).toBe(false);
    expect(controller.snapshot().sessions.map((s) => s.id)).toEqual(['live']);
  });

  it('a failed list keeps the last good rows, reports error, and leaves lastError alone', async () => {
    const { source } = fakeSource();
    const { controller, events } = makeController(source);
    active = controller;
    await controller.refresh('start');
    source.mutate.mockImplementationOnce(async () => ({ ok: false, status: 500 }));
    await controller.mutate({ op: 'delete', id: 'a' });
    source.list.mockImplementationOnce(async () => {
      throw new Error('network SECRET down');
    });
    await controller.refresh('manual');
    const snap = controller.snapshot();
    expect(snap.status).toBe('error');
    expect(snap.error).toBe('network [redacted] down');
    expect(snap.sessions.map((s) => s.id)).toEqual(['a']);
    expect(snap.lastError).toEqual({ op: 'delete', message: 'HTTP 500' });
    const listEvents = events.filter((e) => e.event === 'cloud-sessions-list');
    expect(listEvents.at(-1)!.detail).toMatchObject({ provider: 'openhands', ok: false, reason: 'manual' });
    expect(JSON.stringify(events)).not.toContain('network');

    await controller.refresh('manual');
    expect(controller.snapshot()).toMatchObject({ status: 'ready', error: null, lastError: null });
  });

  it('snapshot carries the source capabilities and a CloudState shape', async () => {
    const { source } = fakeSource({
      list: vi.fn(async () => ({
        sessions: [session('a', { cost: 1.25, section: 'org/repo' })],
        folders: [],
        folderTotals: {},
      })),
    });
    const { controller } = makeController(source);
    active = controller;
    await controller.refresh('start');
    const snap = controller.snapshot();
    expect(snap.capabilities).toEqual(source.capabilities);
    expect(snap).toMatchObject({ liveSessionIds: [], showArchived: false, cached: false });
    expect(snap.sessions[0]).toMatchObject({ cost: 1.25, section: 'org/repo' });
    expect(typeof snap.lastSyncAt).toBe('string');
  });

  it("the source's onChange triggers a refresh", async () => {
    const { source, fireChange } = fakeSource();
    const { controller } = makeController(source);
    active = controller;
    await controller.start();
    expect(source.list).toHaveBeenCalledTimes(1);
    fireChange();
    await flush();
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it('stop() stops the source and drops the pending follow-up', async () => {
    const first = deferred<CloudListData>();
    const { source } = fakeSource({ list: vi.fn(() => first.promise) });
    const { controller, onChange } = makeController(source);
    const p1 = controller.refresh('a');
    const p2 = controller.refresh('b');
    controller.stop();
    expect(source.stop).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    first.resolve(list('late'));
    await Promise.all([p1, p2]);
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().sessions).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    await controller.refresh('after-stop');
    expect(source.list).toHaveBeenCalledTimes(1);
  });

  it('mutate logs carry no message text; a rejected/unsupported mutate is logged exactly', async () => {
    const { source } = fakeSource({
      capabilities: { folders: 'none', archive: false, rename: false, delete: true, reorder: false },
      mutate: async () => {
        throw new Error('server said title-text here');
      },
    });
    const { controller, events } = makeController(source);
    active = controller;
    await controller.mutate({ op: 'delete', id: 'a' });
    await controller.mutate({ op: 'rename', id: 'a', title: 'secret title' });
    const mutateEvents = events.filter((e) => e.event === 'cloud-sessions-mutate').map((e) => e.detail);
    expect(mutateEvents).toEqual([
      { provider: 'openhands', op: 'delete', ok: false, status: 0 },
      { provider: 'openhands', op: 'rename', ok: false, status: 0, reason: 'unsupported' },
    ]);
    expect(JSON.stringify(events)).not.toContain('title');
    expect(controller.snapshot().lastError).toEqual({ op: 'rename', message: 'unsupported' });
  });

  it('a successful mutate lists after the mutation and clears an earlier lastError', async () => {
    const order: string[] = [];
    const { source } = fakeSource({
      list: async () => {
        order.push('list');
        return list('a');
      },
      mutate: async (op) => {
        order.push(`mutate:${op.op}`);
        return order.length === 1 ? { ok: false, status: 500 } : { ok: true, status: 204 };
      },
    });
    const { controller } = makeController(source);
    active = controller;
    await controller.mutate({ op: 'delete', id: 'a' });
    expect(controller.snapshot().lastError).toEqual({ op: 'delete', message: 'HTTP 500' });
    await controller.mutate({ op: 'delete', id: 'a' });
    expect(order).toEqual(['mutate:delete', 'mutate:delete', 'list']);
    expect(controller.snapshot().lastError).toBeNull();
  });

  it('a failed first list keeps the cached rows shown (cached stays true)', async () => {
    const { source } = fakeSource({
      list: async () => {
        throw new Error('offline');
      },
    });
    const { controller } = makeController(source, { cache: cacheFor('https://app.all-hands.dev', 'c1') });
    active = controller;
    await controller.start();
    expect(controller.snapshot()).toMatchObject({ status: 'error', cached: true, error: 'offline' });
    expect(controller.snapshot().sessions.map((s) => s.id)).toEqual(['c1']);
  });

  it('a failing cache write is logged by code and retried by the next list; a throwing listener never fails a list', async () => {
    let fail = true;
    const { source } = fakeSource();
    const { controller, events, written } = makeController(source, {
      writeCache: async () => {
        if (fail) throw Object.assign(new Error('EACCES C:\\Users\\x\\cache.json'), { code: 'EACCES' });
      },
      onChange: () => {
        throw new Error('listener broke');
      },
    });
    active = controller;
    await controller.refresh('start');
    await flush();
    expect(controller.snapshot().status).toBe('ready');
    expect(events).toContainEqual({
      event: 'cloud-sessions-cache-error',
      detail: { provider: 'openhands', op: 'write', code: 'EACCES' },
    });
    expect(JSON.stringify(events)).not.toContain('Users');
    fail = false;
    await controller.refresh('again');
    await flush();
    // Same content, but the failed write did not advance the key — retried.
    expect(written).toHaveLength(2);
  });

  it('the dirty follow-up is logged under the latest reason', async () => {
    const first = deferred<CloudListData>();
    const calls = [() => first.promise, async () => list('a')];
    const { source } = fakeSource({ list: () => calls.shift()!() });
    const { controller, events } = makeController(source);
    active = controller;
    const p1 = controller.refresh('first');
    void controller.refresh('second');
    void controller.refresh('third');
    first.resolve(list('a'));
    await p1;
    const reasons = events.filter((e) => e.event === 'cloud-sessions-list').map((e) => e.detail.reason);
    expect(reasons).toEqual(['first', 'third']);
  });

  it('pollMs lists on an interval; stop() clears it', async () => {
    vi.useFakeTimers();
    try {
      const { source } = fakeSource();
      const { controller } = makeController(source, { pollMs: 1000 });
      await controller.start();
      expect(source.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(source.list).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(source.list).toHaveBeenCalledTimes(4);
      controller.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(source.list).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() while the cache read is pending: the late cache and list never reach state', async () => {
    const cache = deferred<unknown>();
    const live = deferred<CloudListData>();
    const { source } = fakeSource({ list: () => live.promise });
    const { controller, onChange } = makeController(source, { readCache: () => cache.promise });
    const started = controller.start();
    controller.stop();
    onChange.mockClear();
    cache.resolve(cacheFor('https://app.all-hands.dev', 'late'));
    live.resolve(list('late'));
    await started;
    expect(controller.snapshot()).toMatchObject({ cached: false, sessions: [], status: 'connecting' });
    expect(onChange).not.toHaveBeenCalled();
    await controller.mutate({ op: 'delete', id: 'a' });
    expect(source.mutate).not.toHaveBeenCalled();
  });
});
