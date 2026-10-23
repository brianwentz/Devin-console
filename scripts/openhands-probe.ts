// OpenHands live spike probe (Phase B0). Manual, human-run, runs UNDER ELECTRON:
//   npm run openhands:probe                 (log in to OpenHands in the window that opens)
//   npm run openhands:probe -- --selftest   (only (g), against localhost, headless)
// Writes docs/evidence/openhands-spike.md. Records statuses, hosts, counts, booleans
// and URL shapes only - never cookies, tokens, bodies, titles or the API key.
import { BaseWindow, WebContentsView, app, net, session, type Session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

const BASE = (process.env.OPENHANDS_PROBE_URL ?? 'https://app.all-hands.dev').replace(/\/+$/, '');
const API_KEY = process.env.OPENHANDS_API_KEY ?? '';
const SELFTEST = process.argv.includes('--selftest');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CLICK_TIMEOUT_MS = 5 * 60 * 1000;
const OUT = resolve('docs/evidence/openhands-spike.md');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function redirectCheck(label: string, f: Fetcher, url: string): Promise<string> {
  try {
    const res = await f(url, { redirect: 'manual' });
    const manual = res.status >= 300 && res.status < 400;
    const opaque = res.type === 'opaqueredirect';
    const followed = res.status === 200 && res.redirected;
    const verdict =
      manual || opaque
        ? 'HONOURED (3xx/opaque-redirect returned, not followed)'
        : followed
          ? 'IGNORED (redirect was followed)'
          : 'UNCLEAR';
    return `- ${label}: ${verdict}; status=${res.status}, type=${res.type}, redirected=${res.redirected}`;
  } catch (e) {
    return `- ${label}: THREW (${msg(e)})`;
  }
}

async function selfTestRedirect(ses: Session): Promise<string[]> {
  const target = createServer((_q, s) => s.writeHead(200, { 'content-type': 'text/plain' }).end('landed'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const targetPort = (target.address() as AddressInfo).port;
  const redirector = createServer((_q, s) =>
    s.writeHead(302, { location: `http://127.0.0.1:${targetPort}/landed` }).end(),
  );
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/start`;
  try {
    return [
      await redirectCheck("net.fetch redirect:'manual'", (u, i) => net.fetch(u, i), url),
      await redirectCheck("session.fetch redirect:'manual'", (u, i) => ses.fetch(u, i), url),
    ];
  } finally {
    redirector.close();
    target.close();
  }
}

function order(items: unknown[]): string {
  const ts = items
    .map((i) => (i && typeof i === 'object' ? Date.parse(String((i as Record<string, unknown>).updated_at ?? '')) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (ts.length < 2) return `n/a (${ts.length} usable updated_at values)`;
  let desc = true;
  let asc = true;
  for (let i = 1; i < ts.length; i++) {
    const cur = ts[i] as number;
    const prev = ts[i - 1] as number;
    if (cur > prev) desc = false;
    if (cur < prev) asc = false;
  }
  if (desc && asc) return 'all equal';
  if (desc) return 'newest first (descending)';
  if (asc) return 'oldest first (ascending)';
  return 'mixed (not sorted by updated_at)';
}

async function probeFetch(f: Fetcher, path: string, headers?: Record<string, string>) {
  try {
    const res = await f(BASE + path, headers ? { redirect: 'manual', headers } : { redirect: 'manual' });
    let items: unknown[] | null = null;
    let shape = 'non-json';
    try {
      const j: unknown = await res.json();
      if (Array.isArray(j)) {
        items = j;
        shape = 'array';
      } else if (j && typeof j === 'object') {
        const arr = (j as Record<string, unknown>).items;
        if (Array.isArray(arr)) {
          items = arr;
          shape = 'object.items';
        } else shape = 'object';
      }
    } catch {
      /* not json */
    }
    return { status: String(res.status), type: res.type, items, shape };
  } catch (e) {
    return { status: `error: ${msg(e)}`, type: '-', items: null, shape: '-' };
  }
}

async function liveProbe(lines: string[]): Promise<void> {
  const ses = session.fromPartition('persist:openhands-probe');
  const win = new BaseWindow({ width: 1200, height: 900, title: 'OpenHands probe - log in, then click a conversation' });
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  const fit = () => {
    const b = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  };
  fit();
  win.on('resize', fit);

  const baseHost = new URL(BASE).hostname;
  const hosts: string[] = [];
  let sawOther = false;
  let loggedIn: (() => void) | null = null;
  const loginDone = new Promise<void>((r) => {
    loggedIn = r;
  });
  let convShape: string | null = null;
  const onNav = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (hosts[hosts.length - 1] !== u.hostname) hosts.push(u.hostname);
    if (u.hostname !== baseHost) {
      sawOther = true;
      return;
    }
    if (u.pathname.startsWith('/conversations') || sawOther) loggedIn?.();
    if (/^\/conversations\/[^/]+/.test(u.pathname) && !convShape) {
      convShape = u.pathname.replace(/^\/conversations\/[^/]+/, '/conversations/<id>');
    }
  };
  view.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame) onNav(d.url);
  });
  view.webContents.on('did-navigate-in-page', (_e, url, isMain) => {
    if (isMain) onNav(url);
  });
  void view.webContents.loadURL(BASE);
  win.show();
  console.log('Log in to OpenHands in the probe window (10 min timeout).');

  const ok = await Promise.race([loginDone.then(() => true), sleep(LOGIN_TIMEOUT_MS).then(() => false)]);
  lines.push(
    '## (d) Navigation hosts during login (main frame, in order, de-duplicated)',
    '',
    hosts.length ? hosts.map((h) => `- ${h}`).join('\n') : '- none',
    '',
  );
  if (!ok) {
    lines.push('LOGIN WAIT TIMED OUT after 10 minutes - (a)-(c), (e), (f) not recorded.', '');
    win.close();
    return;
  }
  await sleep(2000);

  const sesF: Fetcher = (u, i) => ses.fetch(u, i);
  const a = await probeFetch(sesF, '/api/v1/app-conversations/search?limit=5');
  lines.push(
    '## (a) Cookies-only `/api/v1/app-conversations/search?limit=5` via session.fetch',
    '',
    `- status: ${a.status} (type=${a.type}); authenticated by cookies: ${a.status === '200' ? 'YES' : 'NO'}`,
    '',
    '## (b) Same with `Authorization: Bearer $OPENHANDS_API_KEY`',
    '',
  );
  if (API_KEY) {
    const b = await probeFetch(sesF, '/api/v1/app-conversations/search?limit=5', { Authorization: `Bearer ${API_KEY}` });
    lines.push(`- status: ${b.status} (type=${b.type}); response shape: ${b.shape}; items: ${b.items?.length ?? 'n/a'}`, '');
  } else lines.push('- OPENHANDS_API_KEY not set - skipped', '');
  lines.push(
    '## (c) Order of `updated_at` in the cookie-auth response',
    '',
    `- response shape: ${a.shape}; items: ${a.items?.length ?? 'n/a'}; order: ${a.items ? order(a.items) : 'n/a'}`,
    '',
  );

  console.log('Now click a conversation in the window (5 min timeout).');
  const t0 = Date.now();
  while (!convShape && Date.now() - t0 < CLICK_TIMEOUT_MS) await sleep(500);
  lines.push(
    '## (e) Conversation page URL shape',
    '',
    `- ${convShape ? `path shape: \`${convShape}\`` : 'no conversation page navigation observed within 5 minutes'}`,
    '',
  );

  const credits = await probeFetch(sesF, '/api/billing/credits');
  const quota = await probeFetch(sesF, '/api/quota/status');
  lines.push(
    '## (f) Billing / quota endpoints (cookies)',
    '',
    `- /api/billing/credits: ${credits.status} (shape ${credits.shape})`,
    `- /api/quota/status: ${quota.status} (shape ${quota.shape})`,
    '',
  );
  win.close();
}

async function main(): Promise<void> {
  await app.whenReady();
  const lines: string[] = [
    '# OpenHands spike evidence',
    '',
    `- generated: ${new Date().toISOString()}`,
    `- mode: ${SELFTEST ? 'selftest (g only, localhost)' : 'live'}`,
    SELFTEST ? '- base: localhost fixtures' : `- base host: ${new URL(BASE).hostname}`,
    `- OPENHANDS_API_KEY set: ${API_KEY ? 'yes' : 'no'} (value never recorded)`,
    '',
  ];
  if (!SELFTEST) await liveProbe(lines);
  const ses = session.fromPartition(SELFTEST ? 'openhands-probe-selftest' : 'persist:openhands-probe');
  lines.push(
    "## (g) Does `redirect:'manual'` return the 3xx instead of following? (local self-test, no real site)",
    '',
    ...(await selfTestRedirect(ses)),
    '',
  );
  mkdirSync(resolve('docs/evidence'), { recursive: true });
  writeFileSync(OUT, lines.join('\n'));
  console.log(`wrote ${OUT}`);
}

main().then(
  () => app.exit(0),
  (e) => {
    console.error('openhands-probe failed:', msg(e));
    app.exit(1);
  },
);
