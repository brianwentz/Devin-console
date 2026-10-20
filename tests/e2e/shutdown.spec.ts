// F8: quitting with an unsaved GitHub draft probes tabs for beforeunload; a
// veto shows one consolidated prompt (env-driven under test mode). Cancel keeps
// the app and the tab; Quit proceeds to the normal teardown.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  launchApp,
  openTab,
  readEvents,
  state,
  waitForEvent,
  waitForTabTitle,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});
test.afterAll(async () => {
  await fixtures.close();
});

test('window close with an unsaved tab vetoes quit once, then exits on confirm', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-quit-'));
  const logFile = join(profile, 'events.jsonl');
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
    await expect.poll(async () => app!.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);

    const guardedId = await openTab(app, `${fixtures.githubUrl}/beforeunload`);
    await waitForTabTitle(app, 'Before unload');

    // Cancel path: user answers "stay" — app keeps running, tab survives.
    await app.evaluate(
      () => (globalThis as any).__agentworkspace.setBeforeUnloadDecision('stay'),
    );
    await app.evaluate(() => (globalThis as any).__agentworkspace.closeWindow());
    await waitForEvent(logFile, 'shutdown-vetoed');
    expect(
      (await readEvents(logFile)).some((e) => e.event === 'shutdown-probe'),
    ).toBe(true);
    // Still alive and the tab is intact.
    const s = await state(app);
    expect(s.tabs.tabs.some((t) => t.id === guardedId)).toBe(true);
    expect(await app.evaluate(() => 1 + 1)).toBe(2);
    // Scope invariant: the visible scope is unchanged and every visible tab
    // belongs to it (the probe must not resurrect a hidden-scope tab).
    expect(s.tabs.scope).toBe('');
    for (const tab of s.tabs.tabs) {
      expect(tab.originSessionId ?? '').toBe(s.tabs.scope);
    }

    // Quit path: same close now tears down cleanly.
    await app.evaluate(
      () => (globalThis as any).__agentworkspace.setBeforeUnloadDecision('leave'),
    );
    const exitStatus = new Promise<'exited' | 'timeout'>((resolve) => {
      app!.process().once('exit', () => resolve('exited'));
      setTimeout(() => resolve('timeout'), 30_000);
    });
    await app.evaluate(() => (globalThis as any).__agentworkspace.closeWindow());
    expect(await exitStatus).toBe('exited');
    await waitForEvent(logFile, 'window-close-complete');
    app = undefined;
  } finally {
    if (app) {
      await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

// Phase 6 #7: quitting mid-Claude-turn exits via the normal lifecycle
// (destroy window → app.quit) — the Phase 3 app.exit(0) hang scenario.
test('quit while a Claude turn is mid-stream exits within 10 s', async () => {
  const { launchWithClaudeFixture } = await import('./helpers.js');
  const { resolve } = await import('node:path');
  const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD: 'C:\\work\\alpha',
    FAKE_CLAUDE_DELAY_MS: '20000',
  });
  const logFile = join(profile, 'events.jsonl');
  try {
    await expect
      .poll(
        async () =>
          (await app.evaluate(
            () => (globalThis as any).__agentworkspace.claudeState(),
          )).status,
      )
      .toBe('ready');
    const id = (await app.evaluate(() =>
      (globalThis as any).__agentworkspace.claudeNewSession(),
    )) as string;
    await app.evaluate(
      (_e, v: string) => (globalThis as any).__agentworkspace.claudePrompt(v, 'hi'),
      id,
    );
    // Turn is mid-stream (20 s delta delay) — close must still exit.
    await new Promise((r) => setTimeout(r, 500));
    const exitStatus = new Promise<'exited' | 'timeout'>((resolve) => {
      app.process().once('exit', () => resolve('exited'));
      setTimeout(() => resolve('timeout'), 10_000);
    });
    await app.evaluate(() => (globalThis as any).__agentworkspace.closeWindow());
    expect(await exitStatus).toBe('exited');
    await waitForEvent(logFile, 'window-close-complete');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
