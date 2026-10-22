import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import { CLAUDE_FIXTURE_HOME, closeApp, launchWithClaudeFixture, readEvents, state } from './helpers';

// Startup fs gating: a distro whose probe is still 'probing' must not stall
// window creation — every main-process fs path over the wsl UNC waits for
// probe-ready (an unresponsive distro blocks each sync UNC call ~60 s).
// FAKE_WSL_PROBE_DELAY_MS makes the fake wsl.exe sleep inside the probe, so
// the window must be up long before 'ready' can land.

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

test('a slow-probing distro never blocks window creation or the first passes', async () => {
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  const wslClaude = join(uncRoot, 'home', 'u', '.claude');
  mkdirSync(join(wslClaude, 'projects', '-tmp-x'), { recursive: true });
  cpSync(join(CLAUDE_FIXTURE_HOME, '.credentials.json'), join(wslClaude, '.credentials.json'));
  cpSync(
    join(CLAUDE_FIXTURE_HOME, 'projects', 'C--work-alpha', 'usage-a', 'usage-a.jsonl'),
    join(wslClaude, 'projects', '-tmp-x', '55555555-0000-4000-8000-0000000000aa.jsonl'),
  );
  const t0 = Date.now();
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_WSL_DISTROS: 'Slow:Running:default',
    FAKE_WSL_PROBE_DELAY_MS: '8000',
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
    // The helper reads the distro's own fs — the same tree here.
    FAKE_WSL_ROOT: uncRoot,
    // usage-a.jsonl is October 2026 data.
    AGENT_WORKSPACE_TEST_NOW: '2026-10-15T12:00:00.000Z',
  });
  const logFile = join(profile, 'events.jsonl');
  const slowState = async () => (await state(app)).hosts.find((h) => h.id === 'wsl:Slow')?.state;
  try {
    // Window + shell came up well before the probe could have answered.
    const early = await readEvents(logFile);
    for (const name of ['window-created', 'shell-ready']) {
      const entry = early.find((e) => e.event === name);
      expect(entry, name).toBeTruthy();
      expect(Date.parse(entry!.ts as string) - t0).toBeLessThan(10_000);
    }
    // The main loop answers state() while the host is still probing.
    await expect.poll(slowState).toBe('probing');

    // While the probe is still out, a claude-list reports the host skipped
    // (the 'start' refresh may finish before enumeration — wait for one that
    // observed the distro, and assert it happened while still probing).
    await expect
      .poll(async () => {
        if ((await slowState()) !== 'probing') return 'not-probing';
        const lists = (await readEvents(logFile)).filter((e) => e.event === 'claude-list');
        return lists.some(
          (e) =>
            (e.detail as { skippedHosts?: string[] } | undefined)?.skippedHosts?.includes(
              'wsl:Slow',
            ) === true,
        )
          ? 'found'
          : 'none';
      })
      .toBe('found');
    await expect
      .poll(async () => {
        const scans = (await readEvents(logFile)).filter((e) => e.event === 'usage-scan');
        return (scans[0]?.detail as { skippedHosts?: string[] } | undefined)?.skippedHosts;
      })
      .toContain('wsl:Slow');

    // Once the probe lands, the poke/refresh passes pick the host up.
    await expect.poll(slowState, { timeout: 30_000 }).toBe('ready');
    await expect
      .poll(
        async () => {
          const scans = (await readEvents(logFile)).filter((e) => e.event === 'usage-scan');
          const last = scans.at(-1)?.detail as
            | { files?: number; skippedHosts?: string[] }
            | undefined;
          return last && !last.skippedHosts?.includes('wsl:Slow') ? (last.files ?? null) : null;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        async () => {
          const lists = (await readEvents(logFile)).filter((e) => e.event === 'claude-list');
          return (
            (lists.at(-1)?.detail as { skippedHosts?: string[] } | undefined)?.skippedHosts ?? []
          );
        },
        { timeout: 30_000 },
      )
      .not.toContain('wsl:Slow');
    // The seeded distro transcript is scanned inside the distro (helper channel).
    await expect
      .poll(
        async () => {
          const usage = (await app.evaluate(() =>
            (globalThis as any).__agentworkspace.claudeUsageState(),
          )) as { tokens: { byHost: Record<string, { messages: number }> } };
          return usage.tokens.byHost['wsl:Slow']?.messages ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await closeApp(app);
  }
});
