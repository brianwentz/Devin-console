// P8: GitHub tabs are session-scoped. Switching Cloud sessions swaps the visible
// strip; hidden tabs stay live inside keepAliveHours, then discard (state-safe)
// and restore on activation. maxLiveTabs caps live webContents across scopes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  evaluateInView,
  launchApp,
  readEvents,
  state,
  waitForEvent,
  waitForTabCount,
  waitForTabTitle,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function routeLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate((_e, target: string) => {
    (globalThis as typeof globalThis & { __agentworkspace: { routeLink(url: string): void } })
      .__agentworkspace.routeLink(target);
  }, url);
}

async function openSession(app: ElectronApplication, name: string): Promise<void> {
  await app.evaluate((_e, url: string) => {
    (globalThis as typeof globalThis & { __agentworkspace: { loadDevinUrl(url: string): void } })
      .__agentworkspace.loadDevinUrl(url);
  }, `${fixtures.devinUrl}/sessions/${name}`);
  await expect.poll(async () => (await state(app)).currentSessionId).toBe(name);
  await expect.poll(async () => (await state(app)).tabs.scope).toBe(name);
}

async function activeTabBounds(app: ElectronApplication) {
  const s = await state(app);
  if (!s.tabs.activeId) return null;
  return app.evaluate(
    (_e, id: string) => (globalThis as any).__agentworkspace.getTabBounds(id),
    s.tabs.activeId,
  );
}

async function expectActiveTabSized(app: ElectronApplication) {
  await expect
    .poll(async () => {
      const b = await activeTabBounds(app);
      return b !== null && b.width > 0 && b.height > 0;
    })
    .toBe(true);
  return activeTabBounds(app);
}

async function scopes(
  app: ElectronApplication,
): Promise<Array<{ scope: string; count: number; liveCount: number; lastSeen: number }>> {
  return app.evaluate(() => (globalThis as any).__agentworkspace.listScopes());
}

async function quit(app: ElectronApplication, profile: string): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

test('tabs follow the visible session; hidden tabs stay live and keep scroll/form state', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-scopes-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);

    // Session A: two tabs.
    await openSession(app, 'A');
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-1`);
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-2`);
    await waitForTabCount(app, 2);
    await waitForTabTitle(app, 'session-a-2');
    const aState = await state(app);
    const aIds = aState.tabs.tabs.map((t) => t.id);
    expect(aState.tabs.scope).toBe('A');
    expect(aState.tabs.hiddenTabCount).toBe(0);
    expect(aState.tabs.activeId).toBe(aIds[1]);
    // The active tab view must already be sized (regression: scope switches
    // used to leave a freshly attached view at 0x0 until a tab click).
    const aBounds = await expectActiveTabSized(app);
    expect(aBounds!.width).toBeGreaterThan(0);
    expect(aBounds!.height).toBeGreaterThan(0);

    // Type into the active tab's page; the webContents id + input must survive a switch.
    const activeUrl = `${fixtures.githubUrl}/page/session-a-2`;
    const wcId = await app.evaluate(
      ({ webContents }, url: string) =>
        webContents.getAllWebContents().find((c) => c.getURL() === url)?.id ?? null,
      activeUrl,
    );
    expect(wcId).toBeTruthy();
    await evaluateInView(app, activeUrl, `document.getElementById('note').value='draft-comment'`);

    // Session B: one tab; A's two hide.
    await openSession(app, 'B');
    await expect.poll(async () => (await state(app)).tabs.hiddenTabCount).toBe(2);
    await routeLink(app, `${fixtures.githubUrl}/page/session-b-1`);
    await waitForTabCount(app, 1);
    const bState = await state(app);
    expect(bState.tabs.scope).toBe('B');
    expect(bState.tabs.hiddenTabCount).toBe(2);

    // listScopes reports both.
    const scopeList = await scopes(app);
    expect(scopeList.find((s) => s.scope === 'A')).toMatchObject({ count: 2, liveCount: 2 });
    expect(scopeList.find((s) => s.scope === 'B')).toMatchObject({ count: 1, liveCount: 1 });

    // Back to A: same ids, order, active — no reload (same webContents, no new load events).
    const loadsBefore = (await readEvents(logFile)).filter(
      (e) => e.event === 'did-start-loading' && (e.detail as any)?.id === aIds[1],
    ).length;
    await openSession(app, 'A');
    await waitForTabCount(app, 2);
    expect(await expectActiveTabSized(app)).toEqual(aBounds);
    const back = await state(app);
    expect(back.tabs.tabs.map((t) => t.id)).toEqual(aIds);
    expect(back.tabs.activeId).toBe(aIds[1]);
    expect(back.tabs.hiddenTabCount).toBe(1);
    const wcAfter = await app.evaluate(
      ({ webContents }, url: string) =>
        webContents.getAllWebContents().find((c) => c.getURL() === url)?.id ?? null,
      activeUrl,
    );
    expect(wcAfter).toBe(wcId);
    const loadsAfter = (await readEvents(logFile)).filter(
      (e) => e.event === 'did-start-loading' && (e.detail as any)?.id === aIds[1],
    ).length;
    expect(loadsAfter).toBe(loadsBefore);
    expect(
      await evaluateInView(app, activeUrl, `document.getElementById('note').value`),
    ).toBe('draft-comment');

    // Fresh session C: empty strip shows the hint and the "other sessions" overflow.
    await openSession(app, 'C');
    await waitForTabCount(app, 0);
    await expect
      .poll(async () =>
        evaluateInShell(
          app,
          `document.querySelector('[data-testid="tabStripEmpty"]')?.textContent ?? null`,
        ),
      )
      .toBe('No tabs yet — drop a link here or press +');
    expect(
      await evaluateInShell(
        app,
        `document.getElementById('scopeOverflow')`,
      ),
    ).toBe(null);
  } finally {
    await quit(app, profile);
  }
});

test('keepAliveHours=0 discards hidden-scope tabs on switch and restores on return', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-scopes0-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_KEEPALIVE_MS: '0',
  });
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await openSession(app, 'A');
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-1`);
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-2`);
    await waitForTabCount(app, 2);
    await waitForTabTitle(app, 'session-a-2');
    const aBounds = await expectActiveTabSized(app);

    await openSession(app, 'B');
    // Both A tabs discard; B's scope is empty.
    await expect.poll(async () => (await state(app)).tabs.tabs.length).toBe(0);
    await expect.poll(async () => {
      const list = await scopes(app);
      return list.find((s) => s.scope === 'A')?.liveCount ?? -1;
    }).toBe(0);
    expect(
      (await readEvents(logFile)).filter((e) => e.event === 'tab-discard').length,
    ).toBeGreaterThanOrEqual(2);

    // Returning restores the scope's active tab (tab-restore) — and preloads
    // the rest of the visible scope, so the other tab goes live on its own.
    await openSession(app, 'A');
    await waitForEvent(logFile, 'tab-restore');
    await waitForTabCount(app, 2);
    // The restored view is brand-new — it must get real bounds from the scope
    // switch's layout pass, not stay 0x0 until a tab click.
    expect(await expectActiveTabSized(app)).toEqual(aBounds);
    const s = await state(app);
    const restoredId = s.tabs.activeId!;
    expect(s.tabs.tabs.find((t) => t.id === restoredId)?.discarded).toBeUndefined();
    const other = s.tabs.tabs.find((t) => t.id !== restoredId)!;
    await expect.poll(async () => (await state(app)).tabs.tabs.find((t) => t.id === other.id)?.discarded).toBeUndefined();
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), other.id);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(other.id);
  } finally {
    await quit(app, profile);
  }
});

test('maxLiveTabs caps live webContents LRU and skips a beforeunload-protected tab', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-cap-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await evaluateInShell(app, `window.agentworkspace.setSettings({ tabs: { maxLiveTabs: 1 } })`);
    await expect.poll(async () => (await state(app)).settings.tabs.maxLiveTabs).toBe(1);

    // Oldest tab is protected (unsaved-draft); it must survive the cap.
    await openSession(app, 'A');
    await routeLink(app, `${fixtures.githubUrl}/beforeunload`);
    await waitForTabTitle(app, 'Before unload');
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-1`);
    await waitForTabTitle(app, 'session-a-1');

    await openSession(app, 'B');
    await routeLink(app, `${fixtures.githubUrl}/page/session-b-1`);
    await waitForTabTitle(app, 'session-b-1');
    await routeLink(app, `${fixtures.githubUrl}/page/session-b-2`);
    await waitForTabTitle(app, 'session-b-2');
    await routeLink(app, `${fixtures.githubUrl}/page/session-b-3`);
    await waitForTabTitle(app, 'session-b-3');

    // The cap applies to hidden scopes only: A keeps just the protected tab
    // (session-a-1 discarded by the cap), while all 3 visible B tabs stay live
    // — the visible scope is exempt from maxLiveTabs.
    await expect.poll(async () => {
      const list = await scopes(app);
      return list.find((s) => s.scope === 'A')?.liveCount;
    }).toBe(1);
    const list = await scopes(app);
    expect(list.find((s) => s.scope === 'B')?.liveCount).toBe(3);
    expect(list.reduce((sum, s) => sum + s.liveCount, 0)).toBe(4);
    expect(
      (await readEvents(logFile)).some((e) => e.event === 'tab-discard-cancelled'),
    ).toBe(true);
  } finally {
    await quit(app, profile);
  }
});

test('closeScope keeps a beforeunload-protected tab live and visible', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-closescope-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await openSession(app, 'A');
    await routeLink(app, `${fixtures.githubUrl}/beforeunload`);
    await waitForTabTitle(app, 'Before unload');
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-1`);
    await waitForTabTitle(app, 'session-a-1');
    await waitForTabCount(app, 2);
    const guardedId = (await state(app)).tabs.tabs.find((t) =>
      t.url.endsWith('/beforeunload'),
    )!.id;
    // User answers "Stay" on the beforeunload prompt.
    await app.evaluate(
      () => (globalThis as any).__agentworkspace.setBeforeUnloadDecision('stay'),
    );

    // Close the whole scope — the guarded tab refuses, the other closes.
    await evaluateInShell(app, `window.agentworkspace.closeScope('A')`);
    await expect.poll(async () => (await state(app)).tabs.tabs.map((t) => t.id)).toEqual([guardedId]);
    const aScope = (await scopes(app)).find((s) => s.scope === 'A');
    expect(aScope).toMatchObject({ count: 1, liveCount: 1 });
    // No orphan: the surviving entry still owns a live webContents.
    expect(
      await app.evaluate((_e, id: string) =>
        Boolean((globalThis as any).__agentworkspace.getTabWebContents(id)), guardedId),
    ).toBe(true);
    await waitForEvent(logFile, 'tabs-scope-closed');
  } finally {
    await quit(app, profile);
  }
});

test('restart persists scopes/active; visible scope preloads, hidden stays lazy', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-persist-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  let ids: string[] = [];
  let bIds: string[] = [];
  const tabInfo = (app2: ElectronApplication, id: string) =>
    app2.evaluate(
      (_e, tid: string) => (globalThis as any).__agentworkspace.tabInfo(tid),
      id,
    ) as Promise<{ discarded: boolean; hasView: boolean } | null>;
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await openSession(app, 'A');
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-1`);
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-2`);
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-3`);
    await waitForTabCount(app, 3);
    ids = (await state(app)).tabs.tabs.map((t) => t.id);
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), ids[0]!);
    await openSession(app, 'B');
    await routeLink(app, `${fixtures.githubUrl}/page/session-b-1`);
    await routeLink(app, `${fixtures.githubUrl}/page/session-b-2`);
    await waitForTabCount(app, 2);
    bIds = (await state(app)).tabs.tabs.map((t) => t.id);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close().catch(() => undefined);
  } catch {
    await quit(app, profile);
    throw new Error('first run failed');
  }

  const saved = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  expect(saved.tabSnapshot.version).toBe(2);
  expect(saved.tabSnapshot.activeByScope.A).toBe(ids[0]);

  // Relaunch: both scopes restore as placeholders; nothing live until a scope
  // becomes visible — then ALL of that scope's tabs load in the background.
  const app2 = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app2.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    expect((await state(app2)).tabs.hiddenTabCount).toBe(5);
    await openSession(app2, 'A');
    const s = await state(app2);
    expect(s.tabs.tabs.map((t) => t.id)).toEqual(ids);
    expect(s.tabs.activeId).toBe(ids[0]);
    // Preload: every A tab gets a live view without clicking; B stays lazy.
    for (const id of ids) {
      await expect
        .poll(async () => (await tabInfo(app2, id))?.hasView, { timeout: 15_000 })
        .toBe(true);
      expect((await tabInfo(app2, id))?.discarded).toBe(false);
    }
    for (const id of bIds) {
      expect((await tabInfo(app2, id))?.hasView).toBe(false);
    }
    await waitForEvent(logFile, 'tabs-preload');

    // Switching to B makes its tabs live in turn.
    await openSession(app2, 'B');
    for (const id of bIds) {
      await expect
        .poll(async () => (await tabInfo(app2, id))?.hasView, { timeout: 15_000 })
        .toBe(true);
    }
    expect((await state(app2)).tabs.tabs.map((t) => t.id)).toEqual(bIds);
  } finally {
    await quit(app2, profile);
  }
});

test('v1 tab snapshot migrates into scopes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-v1-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      tenantUrl: fixtures.devinUrl,
      discardIdleMinutes: 90,
      tabs: {
        tabs: [
          { id: 'old-1', url: `${fixtures.githubUrl}/page/legacy-1`, title: 'legacy-1', originSessionId: 'A' },
          { id: 'old-2', url: `${fixtures.githubUrl}/page/legacy-2`, title: 'legacy-2', originSessionId: 'A' },
        ],
        activeId: 'old-1',
      },
    }),
  );
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    // discardIdleMinutes 90 -> keepAliveHours 2; v1 snapshot moved to tabSnapshot.
    expect((await state(app)).settings.tabs.keepAliveHours).toBe(2);
    expect((await state(app)).tabs.hiddenTabCount).toBe(2);
    await openSession(app, 'A');
    const s = await state(app);
    expect(s.tabs.tabs.map((t) => t.id)).toEqual(['old-1', 'old-2']);
    expect(s.tabs.activeId).toBe('old-1');
  } finally {
    await quit(app, profile);
  }
});

// Right-click strip menus are native (views paint over the shell); the test
// drives the same code paths via __agentworkspace hooks.
test('tab menus: copy address and reload all tabs in this session', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-menus-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await openSession(app, 'A');
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-1`);
    await routeLink(app, `${fixtures.githubUrl}/page/session-a-2`);
    await waitForTabCount(app, 2);
    await waitForTabTitle(app, 'session-a-2');
    const tabs = (await state(app)).tabs.tabs;
    const ids = tabs.map((t) => t.id);
    const firstUrl = tabs[0]!.url;

    // The "N in other sessions" overflow button is gone for good.
    expect(await evaluateInShell(app, `document.getElementById('scopeOverflow')`)).toBe(null);

    // Copy address writes the tab's URL to the clipboard and logs it.
    const copied = await app.evaluate((_e, id: string) => {
      return (globalThis as any).__agentworkspace.copyTabAddress(id);
    }, ids[0]!);
    expect(copied).toBe(true);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(firstUrl);
    await waitForEvent(logFile, 'tab-copy-address');
    expect(
      await app.evaluate(() => (globalThis as any).__agentworkspace.copyTabAddress('nope')),
    ).toBe(false);

    // Reload all tabs in this session: both live tabs reload (did-stop-loading
    // fires once more per tab than before the reload).
    const stopCount = async (id: string) =>
      (await readEvents(logFile)).filter(
        (e) => e.event === 'did-stop-loading' && (e.detail as { id?: string })?.id === id,
      ).length;
    const before = [await stopCount(ids[0]!), await stopCount(ids[1]!)];
    const reloaded = await app.evaluate(
      () => (globalThis as any).__agentworkspace.reloadScope(),
    );
    expect(reloaded).toBe(2);
    await waitForEvent(logFile, 'tabs-reload-scope');
    await expect.poll(async () => stopCount(ids[0]!)).toBe(before[0]! + 1);
    await expect.poll(async () => stopCount(ids[1]!)).toBe(before[1]! + 1);
  } finally {
    await quit(app, profile);
  }
});
