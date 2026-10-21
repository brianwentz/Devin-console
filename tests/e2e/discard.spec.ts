// O6 state-safe discard: inactive tabs idle past the threshold lose their webContents but
// keep id/title/favicon/order and reload on activation; a page that prevents unload is kept
// (silently — no dialog); the active tab is never discarded; the threshold is a setting
// (AGENT_WORKSPACE_TEST_KEEPALIVE_MS overrides settings.tabs.keepAliveHours in test mode so this suite can use 1.5 s).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  launchApp,
  openTab,
  readEvents,
  state,
  waitForEvent,
  waitForEventCount,
  waitForTabTitle,
  webContentsCount,
} from './helpers';

// Hide the current scope by navigating the devin view into a session; back to
// the tenant root shows GLOBAL again.
async function showSession(app: ElectronApplication, name: string | null): Promise<void> {
  const url = name ? `${fixtures.devinUrl}/sessions/${name}` : fixtures.devinUrl;
  await app.evaluate((_e, target: string) => {
    (globalThis as any).__agentworkspace.loadDevinUrl(target);
  }, url);
  await expect
    .poll(async () => (await state(app)).currentSessionId)
    .toBe(name);
}

async function tabInfo(app: ElectronApplication, id: string) {
  return app.evaluate(
    (_e, tabId: string) => (globalThis as any).__agentworkspace.tabInfo(tabId),
    id,
  ) as Promise<{ url: string; title?: string; discarded: boolean; loading: boolean; hasView: boolean } | null>;
}

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const DISCARD_MS = 1500;

async function tab(app: ElectronApplication, id: string) {
  return (await state(app)).tabs.tabs.find((candidate) => candidate.id === id);
}

async function quit(app: ElectronApplication, profile: string): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

test('discards idle tabs in hidden scopes, keeps chrome state, reloads on scope return, honours beforeunload', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-discard-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_KEEPALIVE_MS: String(DISCARD_MS),
  });
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.getKeepAliveMs())).toBe(DISCARD_MS);

    const a = await openTab(app, `${fixtures.githubUrl}/page/discard-a`);
    await waitForTabTitle(app, 'discard-a');
    const b = await openTab(app, `${fixtures.githubUrl}/page/discard-b`);
    await waitForTabTitle(app, 'discard-b');
    expect((await state(app)).tabs.activeId).toBe(b);
    expect(await webContentsCount(app)).toBe(4);
    const aBefore = (await tab(app, a))!;
    expect(aBefore.favicon).toBeTruthy();

    // Visible-scope tabs never idle out — both stay live past the threshold.
    await new Promise((resolve) => setTimeout(resolve, DISCARD_MS * 2));
    expect((await tabInfo(app, a))?.discarded).toBe(false);
    expect((await tabInfo(app, b))?.discarded).toBe(false);

    // Hide the GLOBAL scope: its tabs' idle clocks freeze at hide time, so the
    // sweep discards both a and b (chrome state — title/favicon/url — survives).
    await showSession(app, 'A');
    await expect.poll(async () => (await tabInfo(app, a))?.discarded, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await tabInfo(app, b))?.discarded, { timeout: 20_000 }).toBe(true);
    await waitForEvent(logFile, 'tab-discard');
    const aAfter = (await tabInfo(app, a))!;
    expect(aAfter.url).toBe(`${fixtures.githubUrl}/page/discard-a`);
    expect(aAfter.loading).toBe(false);
    expect((await state(app)).tabs.hiddenTabCount).toBe(2);

    // Returning to GLOBAL preloads every visible-scope tab — live again.
    await showSession(app, null);
    await expect.poll(async () => (await tabInfo(app, a))?.hasView, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await tabInfo(app, b))?.hasView).toBe(true);
    await expect.poll(async () => (await tab(app, a))?.discarded).toBeUndefined();
    await expect.poll(async () => (await tab(app, a))?.title).toBe('GitHub fixture: discard-a');
    await expect.poll(async () => (await tab(app, a))?.loading).toBe(false);

    // beforeunload-protected hidden tabs cancel the discard and stay live.
    const guarded = await openTab(app, `${fixtures.githubUrl}/beforeunload`);
    await waitForTabTitle(app, 'Before unload');
    const d = await openTab(app, `${fixtures.githubUrl}/page/discard-d`);
    await waitForTabTitle(app, 'discard-d');
    expect((await state(app)).tabs.activeId).toBe(d);
    await showSession(app, 'B');
    await waitForEvent(logFile, 'tab-discard-cancelled');
    await new Promise((resolve) => setTimeout(resolve, DISCARD_MS));
    expect((await tabInfo(app, guarded))?.discarded).toBe(false);
    expect(
      await app.evaluate((_e, id: string) => Boolean((globalThis as any).__agentworkspace.getTabWebContents(id)), guarded),
    ).toBe(true);
    const events = await readEvents(logFile);
    expect(events.some((entry) => entry.event === 'beforeunload-prompt')).toBe(false);
    expect(
      events.some(
        (entry) => entry.event === 'will-prevent-unload' && (entry.detail as any)?.discard === true,
      ),
    ).toBe(true);
    // Non-protected hidden tab discarded on the same sweep.
    await expect.poll(async () => (await tabInfo(app, d))?.discarded).toBe(true);

    // Disabling via the hook stops the sweep: a fresh idle tab stays alive.
    await showSession(app, null);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setKeepAliveMs(0));
    const e = await openTab(app, `${fixtures.githubUrl}/page/discard-e`);
    await waitForTabTitle(app, 'discard-e');
    await new Promise((resolve) => setTimeout(resolve, DISCARD_MS * 2));
    expect((await tabInfo(app, e))?.discarded).toBe(false);
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.discardIdle())).toEqual([]);
  } finally {
    await quit(app, profile);
  }
});


test('keep-alive threshold is a persisted setting (hours) applied live', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-discard-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    expect((await state(app)).settings.tabs.keepAliveHours).toBe(24);
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.getKeepAliveMs())).toBe(24 * 3_600_000);

    await evaluateInShell(app, `window.agentworkspace.setSettings({ tabs: { keepAliveHours: 0 } })`);
    await expect.poll(async () => (await state(app)).settings.tabs.keepAliveHours).toBe(0);
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.getKeepAliveMs())).toBe(0);

    await evaluateInShell(app, `window.agentworkspace.setSettings({ tabs: { keepAliveHours: 48 } })`);
    await expect.poll(async () => (await state(app)).settings.tabs.keepAliveHours).toBe(48);
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.getKeepAliveMs())).toBe(48 * 3_600_000);
    await waitForEvent(logFile, 'keepalive-threshold');
    expect(
      JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).tabs.keepAliveHours,
    ).toBe(48);

    // Out-of-range patches are rejected by the schema and leave the value untouched.
    await evaluateInShell(app, `window.agentworkspace.setSettings({ tabs: { keepAliveHours: -5 } })`);
    await evaluateInShell(app, `window.agentworkspace.setSettings({ tabs: { keepAliveHours: 200 } })`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await state(app)).settings.tabs.keepAliveHours).toBe(48);
  } finally {
    await quit(app, profile);
  }
});

// Regression: a WebContentsView whose webContents is destroyed outside
// discard()/close() (e.g. a deferred waitForBeforeUnload close finishing after
// the 3 s probe timeout) must not leave a dangling view for attachActive to
// re-add — the tab becomes discarded and reloads on activation.
test('a tab whose webContents is destroyed out-of-band becomes discarded and reloads on activation instead of crashing', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-discard-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);

    const destroyOutOfBand = (id: string) =>
      app.evaluate((_e, tabId: string) => {
        (globalThis as any).__agentworkspace.getTabWebContents(tabId)?.close();
      }, id);

    const a = await openTab(app, `${fixtures.githubUrl}/page/zombie-a`);
    await waitForTabTitle(app, 'zombie-a');
    const b = await openTab(app, `${fixtures.githubUrl}/page/zombie-b`);
    await waitForTabTitle(app, 'zombie-b');
    expect((await state(app)).tabs.activeId).toBe(b);

    // Hide the GLOBAL scope so both tabs are inactive when destroyed.
    await showSession(app, 'A');

    await destroyOutOfBand(a);
    await waitForEvent(logFile, 'webcontents-destroyed');
    await expect.poll(async () => (await tabInfo(app, a))?.hasView, { timeout: 20_000 }).toBe(false);
    expect((await tabInfo(app, a))?.discarded).toBe(true);

    // Same for b — the scope's active tab; this is the production crash shape
    // (attachActive re-adding a view with a dead webContents on scope return).
    await destroyOutOfBand(b);
    await waitForEventCount(logFile, 'webcontents-destroyed', 2);
    await expect.poll(async () => (await tabInfo(app, b))?.hasView, { timeout: 20_000 }).toBe(false);
    expect((await tabInfo(app, b))?.discarded).toBe(true);

    // Back to GLOBAL: setScope -> attachActive on b must not throw, and both
    // tabs reload (b via attachActive, a via preloadVisibleScope).
    await showSession(app, null);
    expect((await state(app)).tabs.activeId).toBe(b);
    await expect.poll(async () => (await tabInfo(app, b))?.hasView, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await tab(app, b))?.title, { timeout: 20_000 }).toBe('GitHub fixture: zombie-b');
    await expect.poll(async () => (await tabInfo(app, a))?.hasView, { timeout: 20_000 }).toBe(true);
  } finally {
    await quit(app, profile);
  }
});
