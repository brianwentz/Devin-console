import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

const faviconUrl =
  'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2016%2016%22%3E%3Ccircle%20cx=%228%22%20cy=%228%22%20r=%228%22%20fill=%22%234a90e2%22/%3E%3C/svg%3E';

export interface FixtureServers {
  // Fake tenant (devinView). `http://localhost:<p>`
  devinUrl: string;
  // Fake github.com. `http://127.0.0.1:<p>`
  githubUrl: string;
  // Second GitHub-class origin standing in for *.githubusercontent.com. `http://localhost:<p>`
  githubAltUrl: string;
  // External identity provider (not GitHub, not tenant). `http://localhost:<p>`
  idpUrl: string;
  // Comma-separated value for DEVIN_WORKSPACES_TEST_GITHUB_ORIGINS.
  githubOrigins: string;
  // P5: in-memory v3 API fixture. http://127.0.0.1:<p>
  apiUrl: string;
  // Analytics Claude tab: <apiUrl>/api/oauth/usage fixture route.
  claudeUsageUrl: string;
  api: FixtureApi;
  github: { setPrTitle(n: number, title: string): void };
  close: () => Promise<void>;
}

// P5: in-memory v3 API fixture. Shape mirrors docs.devin.ai/v3-openapi.yaml:
// GET /v3/self -> PatUserSelf; GET /v3/organizations/{org}/sessions?first&after
// -> PaginatedResponse[SessionResponse] { items, end_cursor, has_next_page }.
export interface FixtureSession {
  session_id: string;
  title?: string | null;
  status: string;
  status_detail?: string | null;
  created_at?: string | number;
  updated_at?: number;
  user_id?: string | null;
  pull_requests?: Array<{ pr_url: string; pr_state: string | null }>;
}

export interface FixtureApiRequest {
  ts: number;
  method: string;
  path: string;
  authorization: string | null;
}

export type FixtureApiMode =
  | { kind: 'ok' }
  | { kind: 'status'; status: number; retryAfter?: string; once?: boolean };

export interface FixtureApi {
  orgId: string;
  setSessions(sessions: FixtureSession[]): void;
  setSelf(kind: 'pat_user' | 'service_user'): void;
  getSessions(): FixtureSession[];
  setMode(mode: FixtureApiMode): void;
  // When true the sessions list ignores the user_ids filter — exercises the
  // client-side confirmation path for a wrongly-resolved identity.
  setIgnoreUserIds(ignore: boolean): void;
  requests(): FixtureApiRequest[];
  clearRequests(): void;
}

function createFixtureApi(): { api: FixtureApi; handle: (request: IncomingMessage, response: ServerResponse) => void } {
  const orgId = 'org-fixture';
  let sessions: FixtureSession[] = [];
  let mode: FixtureApiMode = { kind: 'ok' };
  let selfKind: 'pat_user' | 'service_user' = 'pat_user';
  let ignoreUserIds = false;
  const requests: FixtureApiRequest[] = [];
  const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const authorization = request.headers.authorization ?? null;
    requests.push({ ts: Date.now(), method: request.method ?? 'GET', path: url.pathname + url.search, authorization });
    // Analytics Claude tab: stands in for api.anthropic.com (A2 sets
    // DEVIN_WORKSPACES_TEST_CLAUDE_USAGE_URL to this URL).
    if (url.pathname === '/api/oauth/usage') {
      const status = Number(process.env.FAKE_USAGE_STATUS ?? '200') || 200;
      const body =
        process.env.FAKE_USAGE_JSON ??
        readFileSync(join(__dirname, 'claude-usage.json'), 'utf8');
      json(response, status, JSON.parse(body));
      return;
    }
    // GitHub Releases API stand-in (DEVIN_WORKSPACES_TEST_RELEASES_URL) — no
    // auth, the app fetches release notes without credentials.
    const release = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(v[^/]+)$/.exec(url.pathname);
    if (release) {
      const pkg = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
      ) as { version: string };
      const notes: Record<string, string> = {
        [`v${pkg.version}`]: '## Fixed\n- **bold** item\n- see [the docs](https://example.com/docs)',
        'v9.9.9': '## Added\n- **bold** new thing\n- more [details](https://example.com/v999)',
      };
      const body = notes[release[1]!];
      if (body === undefined) {
        json(response, 404, { message: 'Not Found' });
        return;
      }
      json(response, 200, {
        tag_name: release[1],
        name: `Fixture release ${release[1]}`,
        published_at: '2025-01-15T12:00:00Z',
        body,
        html_url: `https://github.com/brianwentz/devin-workspace/releases/tag/${release[1]}`,
      });
      return;
    }
    if (mode.kind === 'status') {
      const current = mode;
      if (current.once) mode = { kind: 'ok' };
      const headers: Record<string, string> = {};
      if (current.retryAfter) headers['retry-after'] = current.retryAfter;
      json(response, current.status, { title: 'fixture error', status: current.status }, headers);
      return;
    }
    if (authorization !== 'Bearer test-token-123') {
      json(response, 401, { title: 'Unauthorized', status: 401 });
      return;
    }
    if (url.pathname === '/v3/self') {
      if (selfKind === 'service_user') {
        json(response, 200, {
          principal_type: 'service_user',
          service_user_id: 'svc-fixture',
          org_id: orgId,
        });
        return;
      }
      json(response, 200, {
        principal_type: 'pat_user',
        user_id: 'user-fixture',
        user_name: 'Fixture User',
        api_key_id: 'key-1',
        api_key_name: 'fixture',
        org_id: orgId,
      });
      return;
    }
    const effective = (session: FixtureSession) => session.user_id ?? 'user-fixture';
    const item = (session: FixtureSession) => ({
      session_id: session.session_id,
      url: `https://app.devin.ai/sessions/${session.session_id}`,
      title: session.title ?? null,
      status: session.status,
      status_detail: session.status_detail ?? null,
      tags: [],
      org_id: orgId,
      created_at: session.created_at ?? 1,
      updated_at: session.updated_at ?? 1,
      acus_consumed: 0,
      user_id: effective(session),
      pull_requests: session.pull_requests ?? [],
    });
    const single = /^\/v3\/organizations\/[^/]+\/sessions\/([^/]+)$/.exec(url.pathname);
    if (single && url.pathname !== `/v3/organizations/${orgId}/sessions`) {
      const found = sessions.find((session) => session.session_id === single[1]);
      if (!found) {
        json(response, 404, { title: 'Not Found', status: 404 });
        return;
      }
      json(response, 200, item(found));
      return;
    }
    if (url.pathname === `/v3/organizations/${orgId}/sessions`) {
      const first = Math.min(200, Math.max(1, Number(url.searchParams.get('first') ?? '100') || 100));
      const after = Number(url.searchParams.get('after') ?? '0') || 0;
      const userIds = url.searchParams.getAll('user_ids');
      const sorted = [...sessions]
        .filter(
          (session) =>
            ignoreUserIds || userIds.length === 0 || userIds.includes(effective(session) ?? ''),
        )
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
      const items = sorted.slice(after, after + first).map(item);
      const hasNext = after + first < sorted.length;
      json(response, 200, {
        items,
        end_cursor: hasNext ? String(after + first) : null,
        has_next_page: hasNext,
        total: sorted.length,
      });
      return;
    }
    json(response, 404, { title: 'Not Found', status: 404 });
  };
  const api: FixtureApi = {
    orgId,
    setSessions: (next) => {
      sessions = next.map((session) => ({ ...session }));
    },
    setSelf: (kind) => {
      selfKind = kind;
    },
    getSessions: () => sessions.map((session) => ({ ...session })),
    setMode: (next) => {
      mode = next;
    },
    setIgnoreUserIds: (ignore) => {
      ignoreUserIds = ignore;
    },
    requests: () => [...requests],
    clearRequests: () => {
      requests.length = 0;
    },
  };
  return { api, handle };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function html(response: ServerResponse, content: string, status = 200): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="${faviconUrl}"></head><body>${content}</body></html>`,
  );
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

// ~2 MB of DOM for the O6 memory measurement.
function heavyBody(label: string): string {
  const rows: string[] = [];
  for (let i = 0; i < 6000; i += 1) {
    rows.push(
      `<tr><td>${i}</td><td class="c${i % 7}">${'lorem ipsum dolor sit amet '.repeat(8)}</td><td><code>${'0123456789abcdef'.repeat(8)}</code></td></tr>`,
    );
  }
  return `<title>GitHub fixture: heavy ${label}</title><h1>heavy ${label}</h1><table>${rows.join('')}</table>`;
}

export async function startFixtureServers(): Promise<FixtureServers> {
  let devinUrl = '';
  let githubUrl = '';
  let githubAltUrl = '';
  let idpUrl = '';
  const prTitles = new Map<number, string>();
  let analyticsLoads = 0;

  const devin = createServer((request, response) => {
    const url = new URL(request.url ?? '/', devinUrl);
    if (url.pathname === '/frame') {
      html(
        response,
        `<a id="iframeNormal" href="${githubUrl}/page/iframe-normal">Frame link</a>
         <a id="iframeTop" target="_top" href="${githubUrl}/page/iframe-top">Top frame link</a>
         <a id="iframeBlank" target="_blank" href="${githubUrl}/page/iframe-blank">Frame blank link</a>
         <a id="iframeAltTop" target="_top" href="${githubAltUrl}/page/iframe-alt-top">Alt top frame link</a>`,
      );
      return;
    }
    if (url.pathname === '/sso-start') {
      redirect(response, `${idpUrl}/devin-finish`);
      return;
    }
    // Cross-origin iframe embedding the GitHub login — the frame's preload must
    // bail and main must reject any autofill IPC from it.
    if (url.pathname === '/embed-login') {
      html(
        response,
        `<title>Fixture embed login</title><main><iframe id="frame" src="${githubUrl}/login"></iframe></main>`,
      );
      return;
    }
    // P8 e2e: two named sessions with distinct GitHub links + a text input (so
    // "typed text survives a scope switch" assertions have something to type into).
    const named = /^\/sessions\/(A|B)$/.exec(url.pathname);
    if (named) {
      const tag = named[1]!;
      html(
        response,
        `<title>Fixture Devin session ${tag}</title><main>Session ${tag} worklog
         <input id="note" name="note" type="text" />
         <a id="gh1" target="_blank" href="${githubUrl}/page/session-${tag.toLowerCase()}-1">GH link 1</a>
         <a id="gh2" target="_blank" href="${githubUrl}/page/session-${tag.toLowerCase()}-2">GH link 2</a>
         <a id="ghBeforeunload" target="_blank" href="${githubUrl}/beforeunload">GH guarded</a></main>`,
      );
      return;
    }
    if (
      url.pathname === '/settings/my-analytics' ||
      url.pathname.startsWith('/settings/my-analytics/')
    ) {
      analyticsLoads += 1;
      html(
        response,
        `<title>Fixture Devin analytics</title><main>Analytics ${url.pathname}
         <span id="analyticsLoadCount">${analyticsLoads}</span>
         <a id="sessionLink" href="${devinUrl}/sessions/A">Session A</a>
         <a id="ghLink" href="${githubUrl}/page/from-analytics">GitHub link</a></main>`,
      );
      return;
    }
    if (url.pathname !== '/') {
      html(
        response,
        `<title>Fixture Devin session</title><main>Fixture Devin worklog ${url.pathname}</main>
         <a id="blank" target="_blank" href="${githubUrl}/page/session-blank">GitHub blank</a>`,
      );
      return;
    }
    html(
      response,
      `<title>Fixture Devin</title>
       <main>
         <a id="blank" target="_blank" href="${githubUrl}/page/blank">GitHub blank</a>
         <button id="windowOpen" onclick="window.open('${githubUrl}/page/window-open')">Open window</button>
         <a id="sameTab" href="${githubUrl}/page/same-tab">Same tab</a>
         <a id="ctrlTarget" href="${githubUrl}/page/ctrl-click">Ctrl/middle click target</a>
         <a id="altBlank" target="_blank" href="${githubAltUrl}/page/alt-blank">Alt origin blank</a>
         <a id="altSameTab" href="${githubAltUrl}/page/alt-same-tab">Alt origin same tab</a>
         <a id="ghRedirect" href="${githubUrl}/redirect">GitHub redirect (same tab)</a>
         <a id="ghRedirectBlank" target="_blank" href="${githubUrl}/redirect">GitHub redirect (blank)</a>
         <a id="devinSso" href="${devinUrl}/sso-start">Devin SSO hop</a>
         <a id="tenantBlank" target="_blank" href="${devinUrl}/sessions/popup-session">Tenant popup</a>
         <a id="external" target="_blank" href="${idpUrl}/away">External popup</a>
         <a id="externalSameTab" href="${idpUrl}/away-same-tab">External same tab</a>
         <a id="mailto" target="_blank" href="mailto:desk@example.org">Email</a>
         <a id="mailtoSameTab" href="mailto:same@example.org">Email same tab</a>
         <button id="javascript" onclick="window.open('javascript:alert(1)')">JavaScript</button>
         <button id="data" onclick="window.open('data:text/html,denied')">Data</button>
         <iframe id="fixtureFrame" src="${devinUrl}/frame"></iframe>
       </main>`,
    );
  });

  const idp = createServer((request, response) => {
    const url = new URL(request.url ?? '/', idpUrl);
    if (url.pathname === '/finish') {
      redirect(response, `${githubUrl}/page/sso-complete`);
      return;
    }
    if (url.pathname === '/devin-finish') {
      redirect(response, `${devinUrl}/sso-complete`);
      return;
    }
    html(response, `<title>Fixture IdP</title><main>External identity provider ${url.pathname}</main>`);
  });

  // Shared handler for both GitHub-class origins; `self` is the origin being served.
  const githubHandler =
    (selfRef: () => string) =>
    (request: import('node:http').IncomingMessage, response: ServerResponse) => {
      const self = selfRef();
      const other = self === githubUrl ? githubAltUrl : githubUrl;
      const url = new URL(request.url ?? '/', self);
      // PR pages render a GitHub-shaped <title> so the app's PR-title fetch
      // (parsePrTitle) exercises the real suffix-stripping path.
      const prMatch = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
      if (prMatch) {
        const [, owner, repo, num] = prMatch;
        // Default keeps the path in the title: routing specs match tab titles on it.
        const title = prTitles.get(Number(num)) ?? `GitHub fixture: ${owner}/${repo}/pull/${num}`;
        html(
          response,
          `<title>${title} by devin-ai-integration[bot] · Pull Request #${num} · ${owner}/${repo}</title><main>PR ${num}</main>`,
        );
        return;
      }
      if (url.pathname === '/redirect') {
        redirect(response, `${self}/page/redirected`);
        return;
      }
      if (url.pathname === '/redirect-alt') {
        redirect(response, `${other}/page/redirected-alt`);
        return;
      }
      if (url.pathname === '/sso') {
        redirect(response, `${idpUrl}/finish`);
        return;
      }
      if (url.pathname === '/download') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="fixture-download.txt"',
        });
        response.end('fixture download payload\n');
        return;
      }
      if (url.pathname === '/beforeunload') {
        html(
          response,
          `<title>Before unload</title>
           <script>window.addEventListener('beforeunload', event => event.preventDefault());</script>
           <main>Close protection fixture</main>`,
        );
        return;
      }
      if (url.pathname === '/login') {
        html(
          response,
          `<title>Fixture login</title>
           <form id="loginForm" onsubmit="document.title='submitted:'+document.getElementById('user').value+':'+document.getElementById('pass').value;return false;">
             <input id="user" name="username">
             <input id="pass" type="password">
             <button id="submit" type="submit">Sign in</button>
           </form>`,
        );
        return;
      }
      // Same fields as /login but a real GET form that navigates to '/'.
      if (url.pathname === '/login-redirect') {
        html(
          response,
          `<title>Fixture login redirect</title>
           <form id="loginForm" method="get" action="/">
             <input id="user" name="username">
             <input id="pass" type="password" name="pass">
             <button id="submit" type="submit">Sign in</button>
           </form>`,
        );
        return;
      }
      // Two-step (identifier-first) login, à la Okta.
      if (url.pathname === '/login-steps') {
        html(
          response,
          `<title>Fixture login steps</title>
           <form id="step1" onsubmit="document.getElementById('step1').hidden=true;document.getElementById('step2').hidden=false;return false;">
             <input id="identifier" name="identifier" autocomplete="username">
             <button id="next" type="submit">Next</button>
           </form>
           <form id="step2" hidden onsubmit="document.title='submitted:'+document.getElementById('identifier').value+':'+document.getElementById('pass').value;return false;">
             <input id="pass" type="password">
             <button id="submit2" type="submit">Sign in</button>
           </form>`,
        );
        return;
      }
      // Search-only page: no login form, must never trigger an autofill query.
      if (url.pathname === '/search') {
        html(
          response,
          `<title>Fixture search</title>
           <form><input type="search" name="q">
           <input name="q2" placeholder="Search repos"></form>`,
        );
        return;
      }
      if (url.pathname.startsWith('/heavy')) {
        html(response, heavyBody(url.pathname.slice('/heavy'.length) || url.search));
        return;
      }
      if (url.pathname === '/ghframe') {
        html(
          response,
          `<a id="frameBlank" target="_blank" href="${self}/page/gh-frame-blank">Frame blank</a>
           <a id="frameTopAlt" target="_top" href="${other}/page/gh-frame-top-alt">Frame top alt</a>
           <a id="frameNormal" href="${self}/page/gh-frame-normal">Frame normal</a>`,
        );
        return;
      }
      const name = url.pathname.startsWith('/page/')
        ? decodeURIComponent(url.pathname.slice('/page/'.length))
        : url.pathname === '/'
          ? 'home'
          : url.pathname.slice(1);
      const frame = name === 'with-frame' ? `<iframe id="ghFrame" src="${self}/ghframe"></iframe>` : '';
      if (url.pathname === '/') {
        response.setHeader('set-cookie', 'fixture_persist=1; Max-Age=86400; Path=/');
      }
      html(
        response,
        `<title>GitHub fixture: ${name}</title>
         <main><h1>${name}</h1>
           <input id="note" name="note" type="text" />
           <a id="next" href="${self}/page/next">Next page</a>
           <a id="popup" target="_blank" href="${self}/page/popup-child">Open GitHub tab</a>
           <button id="windowOpen" onclick="window.open('${self}/page/gh-window-open')">Open window</button>
           <a id="altPopup" target="_blank" href="${other}/page/alt-popup-child">Open other-origin tab</a>
           <a id="altNext" href="${other}/page/alt-next">Other origin same tab</a>
           <a id="topAlt" target="_top" href="${other}/page/top-alt">Other origin top frame</a>
           <a id="redirectAlt" href="${self}/redirect-alt">Redirect to other origin</a>
           <a id="tenantPopup" target="_blank" href="${devinUrl}/sessions/from-github">Tenant popup</a>
           <a id="externalPopup" target="_blank" href="${idpUrl}/gh-away">External popup</a>
           <a id="externalNext" href="${idpUrl}/gh-away-same-tab">External same tab</a>
           <a id="mailto" href="mailto:gh@example.org">Email</a>
           <a id="download" href="${self}/download">Download file</a>
           ${frame}
         </main>`,
      );
    };

  const github = createServer(githubHandler(() => githubUrl));
  const githubAlt = createServer(githubHandler(() => githubAltUrl));
  const fixtureApi = createFixtureApi();
  const api = createServer(fixtureApi.handle);

  const [devinPort, githubPort, githubAltPort, idpPort, apiPort] = await Promise.all([
    listen(devin),
    listen(github),
    listen(githubAlt),
    listen(idp),
    listen(api),
  ]);
  devinUrl = `http://localhost:${devinPort}`;
  githubUrl = `http://127.0.0.1:${githubPort}`;
  githubAltUrl = `http://localhost:${githubAltPort}`;
  idpUrl = `http://localhost:${idpPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  return {
    devinUrl,
    githubUrl,
    githubAltUrl,
    idpUrl,
    githubOrigins: `${new URL(githubUrl).origin},${new URL(githubAltUrl).origin}`,
    apiUrl,
    claudeUsageUrl: `${apiUrl}/api/oauth/usage`,
    api: fixtureApi.api,
    github: {
      setPrTitle: (n: number, title: string) => {
        prTitles.set(n, title);
      },
    },
    close: async () => {
      await Promise.all(
        [devin, github, githubAlt, idp, api].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      );
    },
  };
}
