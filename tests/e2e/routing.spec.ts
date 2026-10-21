import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  currentDevinUrl,
  keyboardReorderTab,
  evaluateInShell,
  evaluateInView,
  shellPage,
  fixtureFrameUrl,
  hasDevinView,
  hasFixtureFrame,
  launchApp,
  openTab,
  readEvents,
  runInFrame,
  state,
  waitForEvent,
  waitForEventCount,
  waitForTabCount,
  waitForTabTitle,
  type PublicState,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test('routes fixture navigation, manages tabs, persists state, and cleans up webContents', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const downloads = join(profile, 'downloads');
  const evidence = process.env.AGENT_WORKSPACE_EVIDENCE === '1' ? resolve('docs/evidence') : profile;
  mkdirSync(evidence, { recursive: true });
  const logFile = join(evidence, 'e2e-fixture-events.jsonl');
  writeFileSync(logFile, '', 'utf8');

  let app = await launchApp(profile, logFile, downloads, fixtures);
  let appClosed = false;
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await expect.poll(() => hasDevinView(app, fixtures)).toBe(true);

    const initialCount = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
    expect(initialCount).toBe(2);
    const originalDevinUrl = await currentDevinUrl(app, fixtures);

    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('blank').click()`);
    await waitForTabCount(app, 1);
    await waitForTabTitle(app, 'blank');
    let current = await state(app);
    const firstId = current.tabs.tabs[0]?.id;
    expect(firstId).toBeTruthy();
    await expect
      .poll(async () =>
        Boolean((await state(app)).tabs.tabs.find((tab) => tab.id === firstId)?.favicon?.startsWith('data:image/svg+xml,')),
      )
      .toBe(true);
    expect(await currentDevinUrl(app, fixtures)).toBe(originalDevinUrl);

    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('windowOpen').click()`);
    await waitForTabCount(app, 2);
    await waitForTabTitle(app, 'window-open');
    expect(await currentDevinUrl(app, fixtures)).toBe(originalDevinUrl);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);

    await expect.poll(() => hasFixtureFrame(app, fixtures)).toBe(true);
    await runInFrame(app, fixtures, `document.getElementById('iframeNormal').click()`);
    await waitForEvent(logFile, 'will-frame-navigate', 'allow-subframe');
    expect((await state(app)).tabs.tabs).toHaveLength(2);
    expect(await currentDevinUrl(app, fixtures)).toBe(originalDevinUrl);
    await expect
      .poll(() => fixtureFrameUrl(app, fixtures))
      .toBe(`${fixtures.githubUrl}/page/iframe-normal`);
    await evaluateInView(app, fixtures.devinUrl, 'location.reload()');
    await expect.poll(() => hasFixtureFrame(app, fixtures)).toBe(true);

    await app.evaluate((_electron) => {
      (globalThis as typeof globalThis & { __agentworkspace: { setPaneOpen(value: boolean): void } }).__agentworkspace.setPaneOpen(false);
    });
    expect((await state(app)).paneOpen).toBe(false);
    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('sameTab').click()`);
    await waitForTabCount(app, 3);
    await waitForTabTitle(app, 'same-tab');
    expect((await state(app)).paneOpen).toBe(true);
    await waitForEvent(logFile, 'will-navigate', 'github-tab');

    const devinUrlBeforeTopFrame = await currentDevinUrl(app, fixtures);
    await runInFrame(app, fixtures, `document.getElementById('iframeTop').click()`);
    await waitForTabTitle(app, 'iframe-top');
    expect((await state(app)).tabs.tabs).toHaveLength(4);
    const devinUrlAfterTopFrame = await currentDevinUrl(app, fixtures);
    expect(devinUrlAfterTopFrame).toBe(devinUrlBeforeTopFrame);

    const tabsBeforeBlockedLinks = (await state(app)).tabs.tabs.length;
    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('external').click()`);
    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('mailto').click()`);
    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('javascript').click()`);
    await evaluateInView(app, fixtures.devinUrl, `document.getElementById('data').click()`);
    await app.evaluate((_electron, urls: string[]) => {
      const api = (globalThis as typeof globalThis & { __agentworkspace: { routeLink(url: string): void } }).__agentworkspace;
      urls.forEach((url) => api.routeLink(url));
    }, ['javascript:alert(1)', 'data:text/html,denied']);
    await waitForEvent(logFile, 'window-open', 'external');
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(tabsBeforeBlockedLinks);
    const events = await readEvents(logFile);
    expect(events.some((entry) => entry.decision === 'mailto')).toBe(true);
    expect(events.some((entry) => entry.decision === 'deny')).toBe(true);

    const redirectId = await openTab(app, `${fixtures.githubUrl}/redirect`);
    await expect.poll(async () =>
      (await state(app)).tabs.tabs.find((tab) => tab.id === redirectId)?.url.endsWith('/page/redirected'),
    ).toBe(true);
    await waitForEvent(logFile, 'will-redirect', 'allow');

    const ssoId = await openTab(app, `${fixtures.githubUrl}/sso`);
    await expect.poll(async () =>
      (await state(app)).tabs.tabs.find((tab) => tab.id === ssoId)?.url.endsWith('/page/sso-complete'),
    ).toBe(true);
    expect((await state(app)).tabs.tabs.find((tab) => tab.id === ssoId)?.id).toBe(ssoId);

    const historyId = await openTab(app, `${fixtures.githubUrl}/page/history-start`);
    await waitForTabTitle(app, 'history-start');
    const countBeforeGithubPopup = (await state(app)).tabs.tabs.length;
    await evaluateInView(app, `${fixtures.githubUrl}/page/history-start`, `document.getElementById('popup').click()`);
    await waitForTabCount(app, countBeforeGithubPopup + 1);
    await waitForTabTitle(app, 'popup-child');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    await app.evaluate((_electron, id: string) => {
      (globalThis as typeof globalThis & { __agentworkspace: { activate(value: string): void } }).__agentworkspace.activate(id);
    }, historyId);
    await app.evaluate((_electron, id: string) => {
      (globalThis as typeof globalThis & { __agentworkspace: { focus(value: string): void } }).__agentworkspace.focus(id);
    }, historyId);
    await evaluateInView(app, `${fixtures.githubUrl}/page/history-start`, `document.getElementById('next').click()`);
    await expect.poll(async () =>
      (await state(app)).tabs.tabs.find((tab) => tab.id === historyId)?.url.endsWith('/page/next'),
    ).toBe(true);
    await expect.poll(async () =>
      (await state(app)).tabs.tabs.find((tab) => tab.id === historyId)?.canGoBack,
    ).toBe(true);
    await app.evaluate((_electron, action: 'back' | 'forward' | 'reload') => {
      return (globalThis as typeof globalThis & { __agentworkspace: { navigate(value: string): void } }).__agentworkspace.navigate(action);
    }, 'back');
    await expect.poll(async () =>
      (await state(app)).tabs.tabs.find((tab) => tab.id === historyId)?.url.endsWith('/page/history-start'),
    ).toBe(true);
    await app.evaluate((_electron, action: 'back' | 'forward' | 'reload') => {
      return (globalThis as typeof globalThis & { __agentworkspace: { navigate(value: string): void } }).__agentworkspace.navigate(action);
    }, 'forward');
    await expect.poll(async () =>
      (await state(app)).tabs.tabs.find((tab) => tab.id === historyId)?.url.endsWith('/page/next'),
    ).toBe(true);
    await app.evaluate((_electron, action: 'back' | 'forward' | 'reload') => {
      return (globalThis as typeof globalThis & { __agentworkspace: { navigate(value: string): void } }).__agentworkspace.navigate(action);
    }, 'reload');

    await openTab(app, `${fixtures.githubUrl}/page/download-fixture`);
    await waitForTabTitle(app, 'download-fixture');
    await evaluateInView(app, `${fixtures.githubUrl}/page/download-fixture`, `document.getElementById('download').click()`);
    await expect.poll(() => {
      try {
        return readFileSync(join(downloads, 'fixture-download.txt'), 'utf8');
      } catch {
        return '';
      }
    }).toContain('fixture download payload');

    const guardedId = await openTab(app, `${fixtures.githubUrl}/beforeunload`);
    await waitForTabTitle(app, 'Before unload');
    await app.evaluate((_electron) => {
      (globalThis as typeof globalThis & { __agentworkspace: { setBeforeUnloadDecision(value: string): void } })
        .__agentworkspace.setBeforeUnloadDecision('stay');
    });
    const stayed = await app.evaluate((_electron, id: string) => {
      return (globalThis as typeof globalThis & { __agentworkspace: { close(id: string): Promise<boolean> } }).__agentworkspace.close(id);
    }, guardedId);
    expect(stayed).toBe(false);
    expect((await state(app)).tabs.tabs.some((tab) => tab.id === guardedId)).toBe(true);
    await app.evaluate((_electron) => {
      (globalThis as typeof globalThis & { __agentworkspace: { setBeforeUnloadDecision(value: string): void } })
        .__agentworkspace.setBeforeUnloadDecision('leave');
    });
    const left = await app.evaluate((_electron, id: string) => {
      return (globalThis as typeof globalThis & { __agentworkspace: { close(id: string): Promise<boolean> } }).__agentworkspace.close(id);
    }, guardedId);
    expect(left).toBe(true);

    // Reorder via the keyboard sensor (deterministic under an overflowing strip);
    // the pointer drag matrix lives in tabstrip.spec.ts.
    const orderBeforeReorder = (await state(app)).tabs.tabs.map((tab) => tab.id);
    expect(orderBeforeReorder.length).toBeGreaterThanOrEqual(2);
    const shell = await shellPage(app);
    await shell.locator(`[data-tab-id="${orderBeforeReorder[0]}"]`).scrollIntoViewIfNeeded();
    await keyboardReorderTab(shell, orderBeforeReorder[0]!, 'right');
    await waitForEvent(logFile, 'tab-reorder');
    await expect
      .poll(async () => (await state(app)).tabs.tabs.map((tab) => tab.id))
      .toEqual([orderBeforeReorder[1], orderBeforeReorder[0], ...orderBeforeReorder.slice(2)]);

    current = await state(app);
    const inactiveTab = current.tabs.tabs.find((tab) => tab.id !== current.tabs.activeId);
    if (inactiveTab) {
      const selector = `[data-tab-id="${inactiveTab.id}"]`;
      await evaluateInShell(app, `document.querySelector(${JSON.stringify(selector)})?.click()`);
      await expect.poll(async () => (await state(app)).tabs.activeId).toBe(inactiveTab.id);
    }
    current = await state(app);
    const activeBeforeClose = current.tabs.activeId;
    if (activeBeforeClose) {
      const activeIndex = current.tabs.tabs.findIndex((tab) => tab.id === activeBeforeClose);
      const expectedNeighbor =
        current.tabs.tabs[activeIndex + 1]?.id ?? current.tabs.tabs[activeIndex - 1]?.id ?? null;
      const selector = `[data-tab-id="${activeBeforeClose}"] .closeMark`;
      await evaluateInShell(
        app,
        `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
      );
      await expect.poll(async () => (await state(app)).tabs.tabs.some((tab) => tab.id === activeBeforeClose)).toBe(false);
      expect((await state(app)).tabs.activeId).toBe(expectedNeighbor);
    }
    current = await state(app);
    const middleClickTarget = current.tabs.tabs[0]?.id;
    if (middleClickTarget) {
      const selector = `[data-tab-id="${middleClickTarget}"]`;
      await evaluateInShell(app, `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))`);
      await expect.poll(async () => (await state(app)).tabs.tabs.some((tab) => tab.id === middleClickTarget)).toBe(false);
    }

    const tabCountAfterBehavior = (await state(app)).tabs.tabs.length;
    await app.evaluate((_electron) => {
      const api = (globalThis as typeof globalThis & {
        __agentworkspace: { state(): PublicState; close(id: string): Promise<boolean> };
      }).__agentworkspace;
      return api.state().tabs.tabs.reduce<Promise<boolean>>(
        (previous, tab) => previous.then(async () => {
          await api.close(tab.id);
          return true;
        }),
        Promise.resolve(true),
      );
    });
    await waitForTabCount(app, 0);
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(2);

    await app.evaluate((_electron) => {
      const api = (globalThis as typeof globalThis & {
        __agentworkspace: { setPaneOpen(value: boolean): void; setPaneFraction(value: number): void };
      }).__agentworkspace;
      api.setPaneFraction(0.374);
      api.setPaneOpen(true);
    });
    const persistedId = await openTab(app, `${fixtures.githubUrl}/page/persisted`);
    await waitForTabTitle(app, 'persisted');
    expect(tabCountAfterBehavior).toBeGreaterThan(0);

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 1);
    await app.close();
    appClosed = true;
    app = await launchApp(profile, logFile, downloads, fixtures);
    appClosed = false;
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await waitForTabCount(app, 1);
    const restored = await state(app);
    expect(restored.paneOpen).toBe(true);
    expect(restored.paneFraction).toBeCloseTo(0.374, 2);
    expect(restored.tabs.activeId).toBe(persistedId);
    expect(restored.tabs.tabs[0]?.url).toBe(`${fixtures.githubUrl}/page/persisted`);
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(3);

    const restoredTabId = restored.tabs.tabs[0]?.id;
    if (restoredTabId) {
      const closed = await app.evaluate((_electron, id: string) => {
        return (globalThis as typeof globalThis & { __agentworkspace: { close(id: string): Promise<boolean> } }).__agentworkspace.close(id);
      }, restoredTabId);
      expect(closed).toBe(true);
    }
    await waitForTabCount(app, 0);
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(2);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForEventCount(logFile, 'window-close-complete', 2);
    await app.close();
    appClosed = true;

    const finalEvents = await readEvents(logFile);
    expect(finalEvents.some((entry) => entry.event === 'window-close-complete' && (entry.detail as any)?.webContentsCountAfter === 0)).toBe(true);
  } finally {
    if (!appClosed) await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
