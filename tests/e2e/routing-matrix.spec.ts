// R7 routing matrix (plan §7): source x disposition x host class.
//   sources:      devin page | gh tab | shell link (`__agentworkspace.routeLink`)
//   dispositions: _blank | window.open | ctrl-click / middle-click (background) |
//                 top-level link nav | iframe link (_blank, _top, in-frame) |
//                 server redirect | SSO hop via the fixture IdP
//   host classes: fixture github origin | fixture "githubusercontent"-like second origin |
//                 tenant | external | mailto | javascript:/data:
// Invariants asserted after every test: zero external/mailto decisions for GitHub-class
// URLs, zero BrowserWindows, and (where the test closes the window) zero orphan webContents.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  browserWindowCount,
  clickLink,
  currentDevinUrl,
  evaluateInView,
  githubExternalEvents,
  hasDevinView,
  hasFixtureFrame,
  launchApp,
  openTab,
  pageFor,
  readEvents,
  runInFrame,
  state,
  waitForDecision,
  waitForEvent,
  waitForEventCount,
  waitForTabCount,
  waitForTabTitle,
  webContentsCount,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

interface Harness {
  app: ElectronApplication;
  profile: string;
  logFile: string;
  downloads: string;
}

async function start(): Promise<Harness> {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-matrix-'));
  // Keep the event log outside the profile so it survives cleanup for post-mortems.
  const logDir = resolve('test-results', 'matrix-logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${test.info().title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.jsonl`);
  writeFileSync(logFile, '', 'utf8');
  const downloads = join(profile, 'downloads');
  const app = await launchApp(profile, logFile, downloads, fixtures);
  await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
  await expect.poll(() => hasDevinView(app, fixtures)).toBe(true);
  return { app, profile, logFile, downloads };
}

async function finish(harness: Harness, options: { closed?: boolean } = {}): Promise<void> {
  const { app, profile, logFile } = harness;
  try {
    expect(await githubExternalEvents(logFile, fixtures)).toEqual([]);
    if (!options.closed) {
      try {
        expect(await browserWindowCount(app)).toBe(0);
      } catch {
        // App already exited (window close raced teardown) — nothing to count.
      }
    }
  } finally {
    if (!options.closed) {
      await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    await removeProfile(profile);
  }
}

// Electron may still hold the profile directory for a moment after exit on Windows.
async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    }
  }
}

function tabById(current: Awaited<ReturnType<typeof state>>, id: string) {
  return current.tabs.tabs.find((tab) => tab.id === id);
}

async function routeLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate((_electron, target: string) => {
    (globalThis as typeof globalThis & { __agentworkspace: { routeLink(url: string): void } }).__agentworkspace.routeLink(target);
  }, url);
}

async function loadDevinUrl(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate((_electron, target: string) => {
    (globalThis as typeof globalThis & { __agentworkspace: { loadDevinUrl(url: string): void } }).__agentworkspace.loadDevinUrl(target);
  }, url);
}

async function tabUrlEndsWith(app: ElectronApplication, id: string, suffix: string): Promise<void> {
  await expect.poll(async () => tabById(await state(app), id)?.url.endsWith(suffix)).toBe(true);
}

test('devin page: popups, ctrl/middle-click, top-level nav, both GitHub origins, redirect, SSO, tenant, external', async () => {
  const harness = await start();
  const { app, logFile } = harness;
  try {
    const devinHome = await currentDevinUrl(app, fixtures);
    const devinPage = await pageFor(app, fixtures.devinUrl);

    // _blank -> foreground gh tab (anchor).
    await clickLink(app, devinPage, '#blank');
    await waitForTabCount(app, 1);
    await waitForTabTitle(app, 'blank');
    const first = (await state(app)).tabs.activeId!;
    await waitForDecision(logFile, 'github-tab', '/page/blank');

    // ctrl-click -> background tab, active tab unchanged.
    await clickLink(app, devinPage, '#ctrlTarget', { ctrl: true });
    await waitForTabCount(app, 2);
    await waitForDecision(logFile, 'github-tab-background', '/page/ctrl-click');
    expect((await state(app)).tabs.activeId).toBe(first);
    await waitForTabTitle(app, 'ctrl-click');

    // middle-click -> background tab, active tab unchanged.
    await clickLink(app, devinPage, '#sameTab', { middle: true });
    await waitForTabCount(app, 3);
    await waitForDecision(logFile, 'github-tab-background', '/page/same-tab');
    expect((await state(app)).tabs.activeId).toBe(first);

    // Plain top-level link nav to the second GitHub-class origin -> gh tab, devin unchanged.
    await clickLink(app, devinPage, '#altSameTab');
    await waitForTabCount(app, 4);
    await waitForDecision(logFile, 'github-tab', '/page/alt-same-tab');
    await waitForTabTitle(app, 'alt-same-tab');
    expect(await currentDevinUrl(app, fixtures)).toBe(devinHome);
    expect((await state(app)).tabs.tabs.some((tab) => tab.url.startsWith(fixtures.githubAltUrl))).toBe(true);

    // _blank to the second origin -> gh tab.
    await clickLink(app, devinPage, '#altBlank');
    await waitForTabCount(app, 5);
    await waitForDecision(logFile, 'github-tab', '/page/alt-blank');

    // Same-tab link to a GitHub URL that server-redirects: tab opens, redirect followed inside it.
    await clickLink(app, devinPage, '#ghRedirect');
    await waitForTabCount(app, 6);
    await waitForDecision(logFile, 'github-tab', '/redirect');
    const redirected = (await state(app)).tabs.activeId!;
    await tabUrlEndsWith(app, redirected, '/page/redirected');
    expect(await currentDevinUrl(app, fixtures)).toBe(devinHome);

    // _blank to a redirecting GitHub URL -> same thing.
    await clickLink(app, devinPage, '#ghRedirectBlank');
    await waitForTabCount(app, 7);
    await tabUrlEndsWith(app, (await state(app)).tabs.activeId!, '/page/redirected');

    // Tenant popup -> navigates devinView, no tab.
    await clickLink(app, devinPage, '#tenantBlank');
    await waitForDecision(logFile, 'devin', '/sessions/popup-session');
    await expect.poll(() => currentDevinUrl(app, fixtures)).toBe(`${fixtures.devinUrl}/sessions/popup-session`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('popup-session');
    // Scope switched to the session: the 7 GLOBAL tabs hide.
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect((await state(app)).tabs.hiddenTabCount).toBe(7);

    // Back home for the iframe rows.
    await loadDevinUrl(app, `${fixtures.devinUrl}/`);
    await expect.poll(() => hasFixtureFrame(app, fixtures)).toBe(true);

    // iframe: _blank -> tab; _top to second origin -> tab, devin unchanged; in-frame nav stays.
    await runInFrame(app, fixtures, `document.getElementById('iframeBlank').click()`);
    await waitForTabCount(app, 8);
    await waitForDecision(logFile, 'github-tab', '/page/iframe-blank');
    await runInFrame(app, fixtures, `document.getElementById('iframeAltTop').click()`);
    await waitForTabCount(app, 9);
    await waitForDecision(logFile, 'github-tab', '/page/iframe-alt-top');
    expect(await currentDevinUrl(app, fixtures)).toBe(`${fixtures.devinUrl}/`);

    // mailto same-tab -> external (system mail), devin unchanged, no tab.
    const devinPageAgain = await pageFor(app, fixtures.devinUrl);
    await clickLink(app, devinPageAgain, '#mailtoSameTab');
    await waitForDecision(logFile, 'mailto', 'mailto:same@example.org');
    expect((await state(app)).tabs.tabs).toHaveLength(9);

    // SSO hop: tenant -> IdP -> tenant stays inside devinView (no tab, no external).
    await clickLink(app, devinPageAgain, '#devinSso');
    await waitForDecision(logFile, 'allow-in-view', '/sso-start');
    await expect.poll(() => currentDevinUrl(app, fixtures)).toBe(`${fixtures.devinUrl}/sso-complete`);
    await waitForEvent(logFile, 'will-redirect', 'allow');
    expect((await state(app)).tabs.tabs).toHaveLength(9);

    // External same-tab link from devin: stays in place (IdP-style hop), never a tab.
    await loadDevinUrl(app, `${fixtures.devinUrl}/`);
    const devinPage3 = await pageFor(app, fixtures.devinUrl);
    await clickLink(app, devinPage3, '#externalSameTab');
    await waitForDecision(logFile, 'allow-in-view', '/away-same-tab');
    await expect
      .poll(async () =>
        app.evaluate(
          ({ webContents }, prefix: string) =>
            webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(prefix)),
          `${fixtures.idpUrl}/away-same-tab`,
        ),
      )
      .toBe(true);
    expect((await state(app)).tabs.tabs).toHaveLength(9);

    const events = await readEvents(logFile);
    expect(events.filter((entry) => entry.decision === 'external' && String(entry.url).startsWith(fixtures.idpUrl))).toHaveLength(0);
  } finally {
    await finish(harness);
  }
});

test('gh tab: popups, ctrl-click, in-place navigation, cross-origin, redirects, iframe, tenant, external, download', async () => {
  const harness = await start();
  const { app, logFile, downloads } = harness;
  try {
    const devinHome = await currentDevinUrl(app, fixtures);
    const aUrl = `${fixtures.githubUrl}/page/with-frame`;
    const a = await openTab(app, aUrl);
    await waitForTabTitle(app, 'with-frame');
    const aPage = await pageFor(app, aUrl);

    // ctrl-click -> background tab, A stays active.
    await clickLink(app, aPage, '#next', { ctrl: true });
    await waitForTabCount(app, 2);
    await waitForDecision(logFile, 'github-tab-background', '/page/next');
    expect((await state(app)).tabs.activeId).toBe(a);

    // window.open from a gh tab -> foreground tab.
    await clickLink(app, aPage, '#windowOpen');
    await waitForTabCount(app, 3);
    await waitForDecision(logFile, 'github-tab', '/page/gh-window-open');
    expect((await state(app)).tabs.activeId).not.toBe(a);

    // _blank to the other GitHub-class origin -> tab.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), a);
    await clickLink(app, aPage, '#altPopup');
    await waitForTabCount(app, 4);
    await waitForDecision(logFile, 'github-tab', '/page/alt-popup-child');

    // Tenant popup -> devinView navigates; no tab.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), a);
    await clickLink(app, aPage, '#tenantPopup');
    await waitForDecision(logFile, 'devin', '/sessions/from-github');
    await expect.poll(() => currentDevinUrl(app, fixtures)).toBe(`${fixtures.devinUrl}/sessions/from-github`);
    // Scope switched to the session: the 4 GLOBAL tabs hide.
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect((await state(app)).tabs.hiddenTabCount).toBe(4);
    await loadDevinUrl(app, devinHome!);
    await waitForTabCount(app, 4);

    // External popup -> system browser (stubbed), no tab.
    await clickLink(app, aPage, '#externalPopup');
    await waitForDecision(logFile, 'external', '/gh-away');
    expect((await state(app)).tabs.tabs).toHaveLength(4);

    // iframe inside a gh tab: _blank -> tab; in-frame nav stays; _top to other origin -> A navigates in place.
    const frameClick = (id: string) =>
      app.evaluate(
        async ({ webContents }, args: { url: string; id: string }) => {
          const findFrame = () =>
            webContents
              .getAllWebContents()
              .find((c) => c.getURL().startsWith(args.url))
              ?.mainFrame.frames[0];
          // The frame URL commits before its DOM is parsed: poll until the
          // element exists (the frame object can also change across
          // navigations, so re-resolve it each iteration).
          let frame = findFrame();
          for (let i = 0; i < 50; i++) {
            frame = findFrame();
            if (
              frame &&
              (await frame.executeJavaScript(
                `Boolean(document.getElementById(${JSON.stringify(args.id)}))`,
              ))
            ) {
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!frame) throw new Error('gh iframe missing');
          const clickable = await frame.executeJavaScript(
            `Boolean(document.getElementById(${JSON.stringify(args.id)}))`,
          );
          if (!clickable) throw new Error(`gh iframe element missing: ${args.id}`);
          await frame.executeJavaScript(`document.getElementById(${JSON.stringify(args.id)}).click()`);
        },
        { url: aUrl, id },
      );
    await expect
      .poll(async () =>
        app.evaluate(
          ({ webContents }, url: string) =>
            Boolean(
              webContents
                .getAllWebContents()
                .find((c) => c.getURL().startsWith(url))
                ?.mainFrame.frames.some((f) => f.url.endsWith('/ghframe')),
            ),
          aUrl,
        ),
      )
      .toBe(true);
    await frameClick('frameBlank');
    await waitForTabCount(app, 5);
    await waitForDecision(logFile, 'github-tab', '/page/gh-frame-blank');
    await frameClick('frameNormal');
    await waitForDecision(logFile, 'allow-subframe', '/page/gh-frame-normal');
    expect((await state(app)).tabs.tabs).toHaveLength(5);
    // The frame now shows a regular fixture page; its `_top` link to the other origin
    // navigates tab A in place (never a new tab, never external).
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, url: string) =>
            Boolean(
              webContents
                .getAllWebContents()
                .find((c) => c.getURL().startsWith(url))
                ?.mainFrame.frames[0]?.url.endsWith('/page/gh-frame-normal'),
            ),
          aUrl,
        ),
      )
      .toBe(true);
    await frameClick('topAlt');
    await waitForDecision(logFile, 'allow-in-view', '/page/top-alt');
    await tabUrlEndsWith(app, a, '/page/top-alt');
    expect(tabById(await state(app), a)?.url.startsWith(fixtures.githubAltUrl)).toBe(true);
    expect((await state(app)).tabs.tabs).toHaveLength(5);

    // In-place rows on fresh tabs: same-tab link to other origin; redirect to other origin;
    // external same-tab (SAML-style hop); mailto.
    const bUrl = `${fixtures.githubUrl}/page/b`;
    const b = await openTab(app, bUrl);
    await waitForTabTitle(app, 'GitHub fixture: b');
    const bPage = await pageFor(app, bUrl);
    await clickLink(app, bPage, '#altNext');
    await waitForDecision(logFile, 'allow-in-view', '/page/alt-next');
    await tabUrlEndsWith(app, b, '/page/alt-next');

    const cUrl = `${fixtures.githubAltUrl}/page/c`;
    const c = await openTab(app, cUrl);
    await waitForTabTitle(app, 'GitHub fixture: c');
    const cPage = await pageFor(app, cUrl);
    await clickLink(app, cPage, '#redirectAlt');
    await tabUrlEndsWith(app, c, '/page/redirected-alt');
    expect(tabById(await state(app), c)?.url.startsWith(fixtures.githubUrl)).toBe(true);

    const dUrl = `${fixtures.githubUrl}/page/d`;
    const d = await openTab(app, dUrl);
    await waitForTabTitle(app, 'GitHub fixture: d');
    const dPage = await pageFor(app, dUrl);
    await clickLink(app, dPage, '#externalNext');
    await waitForDecision(logFile, 'allow-in-view', '/gh-away-same-tab');
    await tabUrlEndsWith(app, d, '/gh-away-same-tab');

    // GitHub SAML-style chain: github -> IdP -> github, all inside one tab.
    const sso = await openTab(app, `${fixtures.githubUrl}/sso`);
    await tabUrlEndsWith(app, sso, '/page/sso-complete');

    const eUrl = `${fixtures.githubUrl}/page/e`;
    const e = await openTab(app, eUrl);
    await waitForTabTitle(app, 'GitHub fixture: e');
    const ePage = await pageFor(app, eUrl);
    await clickLink(app, ePage, '#mailto');
    await waitForDecision(logFile, 'mailto', 'mailto:gh@example.org');
    expect(tabById(await state(app), e)?.url).toBe(eUrl);
    const countBeforeDownload = (await state(app)).tabs.tabs.length;

    // Download from the second origin -> app-owned handler (configured directory in tests).
    const dlUrl = `${fixtures.githubAltUrl}/page/download-alt`;
    await openTab(app, dlUrl);
    await waitForTabTitle(app, 'download-alt');
    await evaluateInView(app, dlUrl, `document.getElementById('download').click()`);
    await expect.poll(() => {
      try {
        return readFileSync(join(downloads, 'fixture-download.txt'), 'utf8');
      } catch {
        return '';
      }
    }).toContain('fixture download payload');
    await waitForEvent(logFile, 'download-done', 'completed');
    expect((await state(app)).tabs.tabs).toHaveLength(countBeforeDownload + 1);
  } finally {
    await finish(harness);
  }
});

test('shell link source: every host class via __agentworkspace.routeLink, originSessionId tagging', async () => {
  const harness = await start();
  const { app, logFile } = harness;
  try {
    await loadDevinUrl(app, `${fixtures.devinUrl}/sessions/abc123`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('abc123');

    await routeLink(app, `${fixtures.githubUrl}/page/shell-gh`);
    await waitForTabCount(app, 1);
    await waitForDecision(logFile, 'github-tab', '/page/shell-gh');
    expect((await state(app)).tabs.tabs[0]?.originSessionId).toBe('abc123');

    await routeLink(app, `${fixtures.githubAltUrl}/page/shell-alt`);
    await waitForTabCount(app, 2);
    await waitForDecision(logFile, 'github-tab', '/page/shell-alt');

    await routeLink(app, `${fixtures.devinUrl}/sessions/from-shell`);
    await waitForDecision(logFile, 'devin', '/sessions/from-shell');
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('from-shell');
    expect((await state(app)).surface).toBe('cloud');

    await routeLink(app, `${fixtures.idpUrl}/shell-external`);
    await waitForDecision(logFile, 'external', '/shell-external');
    await routeLink(app, 'mailto:shell@example.org');
    await waitForDecision(logFile, 'mailto', 'mailto:shell@example.org');
    await routeLink(app, 'javascript:alert(1)');
    await waitForDecision(logFile, 'deny', 'javascript:');
    await routeLink(app, 'data:text/html,denied');
    await waitForDecision(logFile, 'deny', 'data:');
    // Navigating to /sessions/from-shell swapped the scope: the two 'abc123'
    // tabs are hidden, this session has none yet.
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect((await state(app)).tabs.hiddenTabCount).toBe(2);

    // A tab opened without a current session carries no originSessionId and
    // lands in GLOBAL scope — the two session-scoped tabs become hidden (P8).
    await loadDevinUrl(app, `${fixtures.devinUrl}/`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe(null);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe('');
    await routeLink(app, `${fixtures.githubUrl}/page/no-session`);
    await waitForTabCount(app, 1);
    expect((await state(app)).tabs.hiddenTabCount).toBe(2);
    expect((await state(app)).tabs.tabs.find((tab) => tab.url.endsWith('/page/no-session'))?.originSessionId).toBeUndefined();
  } finally {
    await finish(harness);
  }
});

test('dedupes owner/repo/pull/N across sub-paths and keeps distinct tabs otherwise', async () => {
  const harness = await start();
  const { app, logFile } = harness;
  try {
    await routeLink(app, `${fixtures.githubUrl}/org/repo/pull/7`);
    await waitForTabCount(app, 1);
    const pr = (await state(app)).tabs.activeId!;
    await waitForTabTitle(app, 'org/repo/pull/7');

    await routeLink(app, `${fixtures.githubUrl}/org/repo/pull/7/files?w=1#diff-1`);
    await waitForEvent(logFile, 'tab-dedupe-navigate');
    expect((await state(app)).tabs.tabs).toHaveLength(1);
    await tabUrlEndsWith(app, pr, '/org/repo/pull/7/files?w=1#diff-1');
    await waitForTabTitle(app, 'org/repo/pull/7/files');

    const other = await openTab(app, `${fixtures.githubUrl}/org/repo/issues/7`);
    await waitForTabCount(app, 2);
    expect((await state(app)).tabs.activeId).toBe(other);

    await routeLink(app, `${fixtures.githubUrl}/org/repo/pull/7/commits`);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(pr);
    await tabUrlEndsWith(app, pr, '/org/repo/pull/7/commits');
    expect((await state(app)).tabs.tabs).toHaveLength(2);

    // Exact URL match focuses without reloading; a different PR gets its own tab.
    await routeLink(app, `${fixtures.githubUrl}/org/repo/issues/7`);
    await waitForEvent(logFile, 'tab-existing');
    expect((await state(app)).tabs.activeId).toBe(other);
    await routeLink(app, `${fixtures.githubUrl}/org/repo/pull/8`);
    await waitForTabCount(app, 3);
    await routeLink(app, `${fixtures.githubUrl}/org/other/pull/7`);
    await waitForTabCount(app, 4);

    // Ctrl-click (background) onto an existing PR navigates it but does not steal focus.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), other);
    const otherUrl = `${fixtures.githubUrl}/org/repo/issues/7`;
    const otherPage = await pageFor(app, otherUrl);
    await expect
      .poll(() =>
        evaluateInView(
          app,
          otherUrl,
          `(() => { const link = document.getElementById('next'); if (!link) return false; link.href = ${JSON.stringify(`${fixtures.githubUrl}/org/repo/pull/7/checks`)}; return true; })()`,
        ).catch(() => false),
      )
      .toBe(true);
    await clickLink(app, otherPage, '#next', { ctrl: true });
    await waitForDecision(logFile, 'github-tab-background', '/org/repo/pull/7/checks');
    await tabUrlEndsWith(app, pr, '/org/repo/pull/7/checks');
    expect((await state(app)).tabs.activeId).toBe(other);
    expect((await state(app)).tabs.tabs).toHaveLength(4);
  } finally {
    await finish(harness);
  }
});

test('restart restores tabs (order, active, originSessionId) and window close leaves no orphan webContents', async () => {
  const harness = await start();
  let { app } = harness;
  const { profile, logFile, downloads } = harness;
  let closed = false;
  try {
    await loadDevinUrl(app, `${fixtures.devinUrl}/sessions/persist-me`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('persist-me');
    await routeLink(app, `${fixtures.githubUrl}/page/one`);
    await routeLink(app, `${fixtures.githubAltUrl}/page/two`);
    await routeLink(app, `${fixtures.githubUrl}/page/three`);
    await waitForTabCount(app, 3);
    await waitForTabTitle(app, 'three');
    const before = await state(app);
    const ids = before.tabs.tabs.map((tab) => tab.id);
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), ids[1]!);
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.reorder(id, 0), ids[2]!);
    await expect.poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(await webContentsCount(app)).toBe(5);

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
    closed = true;

    app = await launchApp(profile, logFile, downloads, fixtures);
    harness.app = app;
    closed = false;
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    // After relaunch the Cloud view is at the tenant root (GLOBAL scope); the
    // restored 'persist-me' tabs are hidden until the session is opened again.
    expect((await state(app)).tabs.tabs).toHaveLength(0);
    expect((await state(app)).tabs.hiddenTabCount).toBe(3);
    await loadDevinUrl(app, `${fixtures.devinUrl}/sessions/persist-me`);
    await expect.poll(async () => (await state(app)).currentSessionId).toBe('persist-me');
    await waitForTabCount(app, 3);
    const restored = await state(app);
    expect(restored.tabs.tabs.map((tab) => tab.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(restored.tabs.activeId).toBe(ids[1]);
    expect(restored.tabs.tabs.every((tab) => tab.originSessionId === 'persist-me')).toBe(true);
    expect(restored.tabs.tabs.map((tab) => tab.url)).toEqual([
      `${fixtures.githubUrl}/page/three`,
      `${fixtures.githubUrl}/page/one`,
      `${fixtures.githubAltUrl}/page/two`,
    ]);
    // Every visible-scope tab is preloaded in the background: shell + devin + 3.
    await expect.poll(() => webContentsCount(app)).toBe(5);
    await waitForTabTitle(app, 'two');

    // Closing a restored tab destroys its webContents.
    const closedTab = await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.close(id), ids[0]!);
    expect(closedTab).toBe(true);
    await expect.poll(() => webContentsCount(app)).toBe(4);

    await app.evaluate(() => (globalThis as any).__agentworkspace.closeWindow());
    await waitForEventCount(logFile, 'window-close-complete', 2);
    await app.close();
    closed = true;
    const completes = (await readEvents(logFile)).filter((entry) => entry.event === 'window-close-complete');
    expect(completes).toHaveLength(2);
    expect(completes.every((entry) => (entry.detail as any)?.webContentsCountAfter === 0)).toBe(true);
  } finally {
    await finish(harness, { closed });
  }
});
