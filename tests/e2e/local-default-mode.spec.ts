import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  launchApp,
  readEvents,
  state,
  waitForEvent,
} from './helpers';

const FAKE_AGENT_CMD = 'node out/fixtures/fakeAcpAgent.cjs';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
  expect(existsSync(join('out', 'fixtures', 'fakeAcpAgent.cjs'))).toBe(true);
});

test.afterAll(async () => {
  await fixtures.close();
});

const shell = (app: ElectronApplication, expr: string) => evaluateInShell(app, expr);

async function newProfileWorkspace(tag: string) {
  const profile = mkdtempSync(join(tmpdir(), `agent-workspace-e2e-mode-${tag}-`));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-workspace-ws-'));
  return { profile, workspace, logFile: join(profile, 'events.jsonl') };
}

async function addWorkspace(app: ElectronApplication, path: string): Promise<string> {
  const added = await app.evaluate(
    (_electron, value: string) => (globalThis as any).__agentworkspace.localAddWorkspace(value),
    path,
  );
  if (!added) throw new Error('localAddWorkspace returned null');
  return added;
}

async function readyAgent(app: ElectronApplication, workspace: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await app.evaluate(() => (globalThis as any).__agentworkspace.localState())).agents[
          workspace
        ]?.status,
    )
    .toBe('ready');
}

async function newSession(app: ElectronApplication, workspace: string): Promise<string> {
  return app.evaluate(
    (_electron, value: string) => (globalThis as any).__agentworkspace.localNewSession(value),
    workspace,
  );
}

test('local.defaultMode applies to a new session via session/set_mode', async () => {
  const { profile, workspace, logFile } = await newProfileWorkspace('apply');
  const modeLog = join(profile, 'acp-modes.log');
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ local: { defaultMode: 'smart' } }));
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    FAKE_ACP_MODES: '1',
    FAKE_ACP_MODE_LOG: modeLog,
  });
  try {
    await addWorkspace(app, workspace);
    await readyAgent(app, workspace);
    const sessionId = await newSession(app, workspace);
    // The fake agent appends `<remoteId> <modeId>` when it honours set_mode.
    await expect.poll(() => existsSync(modeLog)).toBe(true);
    expect(readFileSync(modeLog, 'utf8').trim()).toBe(`${sessionId} smart`);
    await waitForEvent(logFile, 'session-mode-set');
    const event = (await readEvents(logFile)).find((entry) => entry.event === 'session-mode-set')!;
    expect((event.detail as Record<string, unknown>).modeId).toBe('smart');
    expect((event.detail as Record<string, unknown>).source).toBe('new');
    const local = await app.evaluate(() => (globalThis as any).__agentworkspace.localState());
    expect(local.sessions[sessionId]?.modes?.currentModeId).toBe('smart');
    expect(local.sessions[sessionId]?.modes?.availableModes.length).toBe(5);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('no local.defaultMode → no session/set_mode call', async () => {
  const { profile, workspace, logFile } = await newProfileWorkspace('unset');
  const modeLog = join(profile, 'acp-modes.log');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    FAKE_ACP_MODES: '1',
    FAKE_ACP_MODE_LOG: modeLog,
  });
  try {
    await addWorkspace(app, workspace);
    await readyAgent(app, workspace);
    const sessionId = await newSession(app, workspace);
    await expect
      .poll(
        async () =>
          (await app.evaluate(() => (globalThis as any).__agentworkspace.localState())).sessions[
            sessionId
          ]?.modes?.currentModeId,
      )
      .toBe('accept-edits');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(modeLog)).toBe(false);
    expect(
      (await readEvents(logFile)).filter((entry) => entry.event === 'session-mode-set'),
    ).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('Settings → Devin Local: #localDefaultModeSelect persists local.defaultMode', async () => {
  const { profile, logFile } = await newProfileWorkspace('ui');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  const clickTab = (id: string) =>
    shell(app, `document.querySelector('[data-settings-tab="${id}"]').click()`);
  const hasEl = (id: string) => shell(app, `Boolean(document.getElementById('${id}'))`);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab('local');
    await expect.poll(async () => hasEl('localDefaultModeSelect')).toBe(true);
    // No live agent modes → the static fallback list is offered.
    expect(
      await shell(app, `document.getElementById('localDefaultModeSelect').value`),
    ).toBe('');
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('#localDefaultModeSelect option')].map((o) => o.value).join(',')`,
      ),
    ).toBe(',accept-edits,smart,ask,plan,bypass');
    expect(
      await shell(
        app,
        `[...document.querySelectorAll('#localDefaultModeSelect option')].map((o) => o.textContent)[0]`,
      ),
    ).toBe('Agent default');

    const changed = await shell(
      app,
      `(() => {
        const el = document.getElementById('localDefaultModeSelect');
        el.value = 'smart';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    expect(changed).toBe(true);
    // Switching tabs commits the dirty draft.
    await clickTab('general');
    await expect
      .poll(
        async () =>
          ((await state(app)).settings as unknown as { local: { defaultMode: string | null } })
            .local.defaultMode,
      )
      .toBe('smart');
    expect(
      (JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as {
        local: { defaultMode: string | null };
      }).local.defaultMode,
    ).toBe('smart');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
