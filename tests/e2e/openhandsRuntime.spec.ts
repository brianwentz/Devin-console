// B1 T21: OpenHands sessions source + runtime against the fixture server.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

async function launch(profile: string) {
  const app = await launchApp(profile, join(profile, 'events.jsonl'), join(profile, 'downloads'), fixtures);
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
