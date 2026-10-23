// B1 T21: OpenHands sessions source + runtime against the fixture server.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ShellState } from '../../src/shared/ipc';
import { evaluateInShell, launchApp, state as publicState } from './helpers';

const state = async (app: ElectronApplication) => (await publicState(app)) as unknown as ShellState;

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launch(profile: string, extraEnv: Record<string, string> = {}) {
  const app = await launchApp(
    profile,
    join(profile, 'events.jsonl'),
    join(profile, 'downloads'),
    fixtures,
    extraEnv,
  );
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return app;
}

async function quit(app: ElectronApplication, profile: string): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const hook = <T>(app: ElectronApplication, name: string, ...args: unknown[]) =>
  app.evaluate(
    async (_electron, [n, a]) => (globalThis as any).__agentworkspace[n as string](...(a as unknown[])) as T,
    [name, args] as [string, unknown[]],
  );

test('lists conversations with a bearer key, never leaks it, and Ctrl+N stays on OpenHands', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohrt-'));
  const app = await launch(profile);
  try {
    fixtures.openhands.requireAuth('bearer');
    fixtures.openhands.setLoginRedirect(false);
    await hook(app, 'secretsSetOpenHands', 'OH-KEY-1');
    await hook(app, 'openhandsRefresh');
    await expect.poll(async () => (await state(app)).openhands.status).toBe('ready');
    const s = (await state(app)).openhands;
    expect(s.connection).toBe('api-key');
    expect(s.sessions).toHaveLength(3);
    expect(s.folders).toEqual(expect.arrayContaining(['acme/web', 'acme/api']));
    expect(fixtures.openhands.lastAuthHeader()).toBe('Bearer OH-KEY-1');
    expect(JSON.stringify(await state(app))).not.toContain('SAK-fixture-secret');
    expect(JSON.stringify(await state(app))).not.toContain('OH-KEY-1');

    // The key never reaches the other origin.
    expect(fixtures.openhandsAlt.requests().every((r) => r.authorization === null)).toBe(true);

    // Cache file carries rows only.
    const cacheFile = join(profile, 'openhands-cache.json');
    await expect.poll(() => existsSync(cacheFile)).toBe(true);
    const cache = readFileSync(cacheFile, 'utf8');
    expect(cache).not.toContain('OH-KEY-1');
    expect(cache).not.toContain('SAK-fixture-secret');

    // Ctrl+N on the OpenHands surface no longer opens a Devin Cloud session.
    await evaluateInShell(app, `document.getElementById('openhandsButton').click()`);
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
    await app.evaluate(() => {
      const shell = (globalThis as any).__agentworkspace.getShellWebContents();
      shell.sendInputEvent({ type: 'keyDown', keyCode: 'n', modifiers: ['control'] });
      shell.sendInputEvent({ type: 'keyUp', keyCode: 'n', modifiers: ['control'] });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await state(app)).surface).toBe('openhands');
  } finally {
    fixtures.openhands.requireAuth('none');
    await quit(app, profile);
  }
});

test('a redirecting API is refused and the key is not sent to the redirect target', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohrt-'));
  const app = await launch(profile);
  try {
    fixtures.openhands.setRedirect('search', `${fixtures.openhandsAlt.url}/api/v1/app-conversations/search`);
    await hook(app, 'secretsSetOpenHands', 'OH-KEY-2');
    await hook(app, 'openhandsRefresh');
    await expect.poll(async () => (await state(app)).openhands.connection).toBe('error');
    const s = (await state(app)).openhands;
    expect(s.lastError?.op).toBe('list');
    expect(s.lastError?.message).toBe('redirect-refused');
    expect(fixtures.openhandsAlt.requests().filter((r) => r.authorization !== null)).toEqual([]);
  } finally {
    fixtures.openhands.setRedirect('search', null);
    await quit(app, profile);
  }
});

const FAST_POLL = { AGENT_WORKSPACE_TEST_OPENHANDS_POLL_MS: '200' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheFor = (tenantUrl: string) =>
  JSON.stringify({
    version: 1,
    tenantUrl,
    savedAt: '2026-10-20T10:00:00.000Z',
    sessions: [],
    folders: [],
    folderTotals: {},
  });

test('no network until the user opts in: idle without a key, cache or surface visit; the surface opens it', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohgate-'));
  const before = fixtures.openhands.requests().length;
  const app = await launch(profile, FAST_POLL);
  try {
    await sleep(1500);
    expect(fixtures.openhands.requests().length).toBe(before);
    expect((await state(app)).openhands).toMatchObject({ status: 'idle', connection: 'idle', sessions: [] });
    // A focus event must not open it either.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('focus'));
    await sleep(500);
    expect(fixtures.openhands.requests().length).toBe(before);

    await evaluateInShell(app, `document.getElementById('openhandsButton').click()`);
    await expect.poll(async () => (await state(app)).openhands.status).toBe('ready');
    expect(fixtures.openhands.requests().length).toBeGreaterThan(before);
  } finally {
    await quit(app, profile);
  }
});

test('setting an API key opens the gate', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohgate-'));
  const before = fixtures.openhands.requests().length;
  const app = await launch(profile, FAST_POLL);
  try {
    await sleep(800);
    expect(fixtures.openhands.requests().length).toBe(before);
    await evaluateInShell(app, `window.agentworkspace.openhandsApiKeySet('OH-KEY-3')`);
    await expect.poll(async () => (await state(app)).openhands.connection).toBe('api-key');
    expect(fixtures.openhands.lastAuthHeader()).toBe('Bearer OH-KEY-3');
  } finally {
    await quit(app, profile);
  }
});

test('a cache for the current tenant opens the gate; a cache for another tenant does not', async () => {
  const matching = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohgate-'));
  writeFileSync(join(matching, 'openhands-cache.json'), cacheFor(fixtures.openhands.url));
  const before = fixtures.openhands.requests().length;
  const app = await launch(matching, FAST_POLL);
  try {
    await expect.poll(() => fixtures.openhands.requests().length).toBeGreaterThan(before);
  } finally {
    await quit(app, matching);
  }

  const other = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-ohgate-'));
  writeFileSync(join(other, 'openhands-cache.json'), cacheFor(fixtures.openhandsAlt.url));
  const mark = fixtures.openhands.requests().length;
  const app2 = await launch(other, FAST_POLL);
  try {
    await sleep(1200);
    expect(fixtures.openhands.requests().length).toBe(mark);
    expect((await state(app2)).openhands.status).toBe('idle');
  } finally {
    await quit(app2, other);
  }
});
