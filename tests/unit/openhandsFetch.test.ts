import { describe, expect, it, vi } from 'vitest';
import { createOpenHandsFetch } from '../../src/main/openhands/fetch';

const BASE = 'https://oh.test';
const json = (status: number, body: unknown = {}, url = ''): Response => {
  const r = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url) Object.defineProperty(r, 'url', { value: url });
  return r;
};
const redirectError = () => new TypeError('Redirect was cancelled');

type Call = [unknown, RequestInit & { headers: HeadersInit }];

function setup(opts: {
  key?: (string | null)[];
  net?: (() => Promise<Response>)[];
  session?: (() => Promise<Response>)[];
}) {
  const keys = [...(opts.key ?? [null])];
  const apiKey = vi.fn(async () => (keys.length > 1 ? keys.shift()! : (keys[0] ?? null)));
  const netQ = [...(opts.net ?? [])];
  const sessQ = [...(opts.session ?? [])];
  const netFetch = vi.fn(async (_u: unknown, _i?: unknown) => netQ.shift()!());
  const sessionFetch = vi.fn(async (_u: unknown, _i?: unknown) => sessQ.shift()!());
  const f = createOpenHandsFetch({
    baseUrl: () => BASE,
    apiKey,
    netFetch: netFetch as unknown as typeof fetch,
    sessionFetch: sessionFetch as unknown as typeof fetch,
  });
  const calls = (m: typeof netFetch) => m.mock.calls as unknown as Call[];
  return { f, apiKey, netFetch, sessionFetch, calls };
}

describe('createOpenHandsFetch', () => {
  it('sends the bearer key on netFetch with redirect:error', async () => {
    const { f, netFetch, calls } = setup({ key: ['K1'], net: [async () => json(200, { a: 1 })] });
    const r = await f('/api/v1/x');
    expect(r).toMatchObject({ status: 200, body: { a: 1 }, mode: 'api-key' });
    const [url, init] = calls(netFetch)[0]!;
    expect(url).toBe(`${BASE}/api/v1/x`);
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer K1');
  });

  it('refuses a redirect (rejected fetch), calls netFetch once and never re-sends the key', async () => {
    const { f, netFetch, sessionFetch, calls } = setup({
      key: ['K1'],
      net: [async () => Promise.reject(redirectError())],
    });
    const r = await f('/api/v1/x');
    expect(r).toMatchObject({ status: 0, error: 'redirect-refused', mode: 'api-key' });
    expect(netFetch).toHaveBeenCalledTimes(1);
    expect(sessionFetch).not.toHaveBeenCalled();
    expect(String(calls(netFetch)[0]![0])).not.toContain('evil');
  });

  it('maps a redirect-ish error message to redirect-refused', async () => {
    const { f } = setup({
      key: ['K1'],
      net: [async () => Promise.reject(new TypeError('net::ERR_FAILED redirect mode is error'))],
    });
    expect(await f('/p')).toMatchObject({ error: 'redirect-refused' });
  });

  it('refuses a response whose url is on another origin', async () => {
    const { f, netFetch } = setup({ key: ['K1'], net: [async () => json(200, {}, 'https://evil.test/x')] });
    expect(await f('/p')).toMatchObject({ status: 0, error: 'redirect-refused' });
    expect(netFetch).toHaveBeenCalledTimes(1);
  });

  it('maps other transport failures to network', async () => {
    const { f } = setup({ key: ['K1'], net: [async () => Promise.reject(new TypeError('fetch failed'))] });
    expect(await f('/p')).toMatchObject({ status: 0, error: 'network' });
  });

  it('uses sessionFetch with redirect:error and no Authorization when there is no key', async () => {
    const { f, netFetch, sessionFetch, calls } = setup({
      key: [null],
      session: [async () => json(200, { ok: true })],
    });
    const r = await f('/p');
    expect(r).toMatchObject({ status: 200, mode: 'web-session' });
    expect(netFetch).not.toHaveBeenCalled();
    const init = calls(sessionFetch)[0]![1];
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it('refuses a cookie-path redirect', async () => {
    const { f } = setup({ key: [null], session: [async () => Promise.reject(redirectError())] });
    expect(await f('/p')).toMatchObject({ status: 0, error: 'redirect-refused', mode: 'web-session' });
  });

  it('401,401 with a key -> api-key-rejected, sessionFetch never called', async () => {
    const { f, sessionFetch, netFetch, apiKey } = setup({
      key: ['K1', 'K2'],
      net: [async () => json(401), async () => json(401)],
    });
    expect(await f('/p')).toMatchObject({ status: 401, error: 'api-key-rejected', mode: 'api-key' });
    expect(netFetch).toHaveBeenCalledTimes(2);
    expect(apiKey).toHaveBeenCalledTimes(2);
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it('401,200 with a key -> ok after re-reading the key', async () => {
    const { f, apiKey, netFetch, calls } = setup({
      key: ['OLD', 'NEW'],
      net: [async () => json(401), async () => json(200, { x: 1 })],
    });
    expect(await f('/p')).toMatchObject({ status: 200, body: { x: 1 }, mode: 'api-key' });
    expect(apiKey).toHaveBeenCalledTimes(2);
    expect(new Headers(calls(netFetch)[1]![1].headers).get('authorization')).toBe('Bearer NEW');
  });

  it('no key, 401 then 403 -> login-required', async () => {
    const { f, sessionFetch } = setup({ key: [null], session: [async () => json(401), async () => json(403)] });
    expect(await f('/p')).toMatchObject({ status: 403, error: 'login-required', mode: 'web-session' });
    expect(sessionFetch).toHaveBeenCalledTimes(2);
  });

  it('passes method/body through and parses non-json as null', async () => {
    const { f, netFetch, calls } = setup({ key: ['K'], net: [async () => new Response('nope', { status: 200 })] });
    const r = await f('/p', { method: 'PATCH', body: '{"title":"t"}' });
    expect(r.body).toBeNull();
    const init = calls(netFetch)[0]![1];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"title":"t"}');
  });
});
