// Redirect-safe transport for the OpenHands REST API. Electron-free: the two
// fetch implementations are injected.
//
// - API key set: `netFetch` with `Authorization: Bearer`, never the cookie jar.
// - No key: `sessionFetch` (the `persist:openhands` partition's cookies).
// Both use `redirect: 'error'` — a redirect could carry the bearer key to
// another origin, and on Electron 44 `'manual'` rejects instead of returning
// the 3xx. A rejected redirect, or a response whose URL left the base origin,
// is `redirect-refused`; it is never retried and the key is never re-sent.

import { apiUrl } from '../../core/openhands';

export type OpenHandsFetchError =
  | 'redirect-refused'
  | 'api-key-rejected'
  | 'login-required'
  | 'network';

export interface OpenHandsFetchResult {
  /** HTTP status; 0 when no response was obtained. */
  status: number;
  body: unknown;
  mode: 'api-key' | 'web-session';
  error?: OpenHandsFetchError;
}

export type OpenHandsFetch = (path: string, init?: RequestInit) => Promise<OpenHandsFetchResult>;

export interface OpenHandsFetchDeps {
  baseUrl(): string;
  apiKey(): Promise<string | null>;
  netFetch: typeof fetch;
  sessionFetch: typeof fetch;
}

const isAuthStatus = (status: number): boolean => status === 401 || status === 403;
const isRedirectError = (error: unknown): boolean =>
  /redirect/i.test(error instanceof Error ? error.message : String(error));

export function createOpenHandsFetch(deps: OpenHandsFetchDeps): OpenHandsFetch {
  const once = async (
    send: typeof fetch,
    path: string,
    init: RequestInit | undefined,
    mode: OpenHandsFetchResult['mode'],
    key: string | null,
  ): Promise<OpenHandsFetchResult> => {
    const base = deps.baseUrl();
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    headers.delete('authorization');
    if (key !== null) headers.set('authorization', `Bearer ${key}`);
    // The bearer path never uses the cookie jar.
    const credentials: RequestCredentials | undefined = key !== null ? 'omit' : undefined;
    let response: Response;
    try {
      response = await send(apiUrl(base, path), { ...init, headers, redirect: 'error', ...(credentials ? { credentials } : {}) });
    } catch (error) {
      return { status: 0, body: null, mode, error: isRedirectError(error) ? 'redirect-refused' : 'network' };
    }
    if (response.url && new URL(response.url).origin !== new URL(base).origin) {
      return { status: 0, body: null, mode, error: 'redirect-refused' };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }
    return { status: response.status, body, mode };
  };

  return async (path, init) => {
    const key = await deps.apiKey();
    if (key !== null) {
      const first = await once(deps.netFetch, path, init, 'api-key', key);
      if (first.status !== 401) return first;
      // The key may have been replaced while the request was in flight.
      const retryKey = await deps.apiKey();
      if (retryKey !== null) {
        const second = await once(deps.netFetch, path, init, 'api-key', retryKey);
        return second.status === 401 ? { ...second, error: 'api-key-rejected' } : second;
      }
      return { ...first, error: 'api-key-rejected' };
    }
    let result = await once(deps.sessionFetch, path, init, 'web-session', null);
    if (isAuthStatus(result.status)) {
      result = await once(deps.sessionFetch, path, init, 'web-session', null);
      if (isAuthStatus(result.status)) return { ...result, error: 'login-required' };
    }
    return result;
  };
}
