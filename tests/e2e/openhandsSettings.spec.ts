// B1 T20: OpenHands descriptor, Settings tab and API key. No OpenHands runtime
// exists yet — the surface is a placeholder that must switch safely.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import type { ShellState } from '../../src/shared/ipc';
import { evaluateInShell, launchApp, readEvents, setInputValue, state as publicState } from './helpers';

// The helper's PublicState is a partial view; these specs read the OpenHands fields.
const state = async (app: ElectronApplication) => (await publicState(app)) as unknown as ShellState;

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launch(profile: string, logFile: string, extraEnv: Record<string, string> = {}) {
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, extraEnv);
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

const shell = (app: ElectronApplication, expr: string) => evaluateInShell(app, expr);
const hasEl = (app: ElectronApplication, id: string) =>
  shell(app, `Boolean(document.getElementById('${id}'))`);
const attr = (app: ElectronApplication, id: string, name: string) =>
  shell(app, `document.getElementById('${id}')?.getAttribute('${name}') ?? null`);

test('the openhands rail button switches to a placeholder surface with GLOBAL tabs', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-openhands-'));
  const app = await launch(profile, join(profile, 'events.jsonl'));
  try {
    await expect.poll(async () => hasEl(app, 'openhandsButton')).toBe(true);
    await shell(app, `document.getElementById('openhandsButton').click()`);
    await expect.poll(async () => (await state(app)).surface).toBe('openhands');
    await expect.poll(async () => hasEl(app, 'openhandsPanel')).toBe(true);
    const s = await state(app);
    expect(s.tabs.scope).toBe('');
    // The runtime (T21) lists the fixture over the cookie path (no key set).
    await expect.poll(async () => (await state(app)).openhands.status).toBe('ready');
    expect((await state(app)).openhands).toMatchObject({ connection: 'web-session' });
    expect(await attr(app, 'openhandsButton', 'aria-pressed')).toBe('true');
    // Back to Cloud works (no hosted OpenHands view was attached).
    await shell(app, `document.getElementById('cloudButton').click()`);
    await expect.poll(async () => (await state(app)).surface).toBe('cloud');
  } finally {
    await quit(app, profile);
  }
});

test('Settings → OpenHands: API key save/clear never exposes the key; base URL is validated and normalised', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-openhands-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile, {
    AGENT_WORKSPACE_TEST_OPENHANDS_URL: 'http://127.0.0.1:9/oh/',
  });
  const KEY = 'SAK-e2e-secret-value-123';
  try {
    expect(
      await app.evaluate(() => (globalThis as any).__agentworkspace.openhandsBaseUrl()),
    ).toBe('http://127.0.0.1:9/oh');
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await expect.poll(async () => hasEl(app, 'settingsTabs')).toBe(true);
    await shell(app, `document.querySelector('[data-settings-tab="openhands"]').click()`);
    await expect.poll(async () => hasEl(app, 'openhandsApiKeyInput')).toBe(true);
    for (const id of [
      'openhandsBaseUrlInput',
      'openhandsPollSecondsInput',
      'openhandsMaxLiveViewsInput',
      'openhandsKeepAliveInput',
      'openhandsApiKeySave',
      'openhandsApiKeyClear',
    ]) {
      expect(await hasEl(app, id), id).toBe(true);
    }
    // No gate is open (no key, no cache, surface not entered): nothing was contacted.
    expect(await attr(app, 'openhandsConnectionStatus', 'data-status')).toBe('idle');
    expect(await attr(app, 'openhandsConnectionStatus', 'data-key-set')).toBe('false');

    await setInputValue(app, 'openhandsApiKeyInput', KEY);
    await shell(app, `document.getElementById('openhandsApiKeySave').click()`);
    await expect.poll(async () => (await state(app)).openhandsApiKeySet).toBe(true);
    await expect
      .poll(async () => shell(app, `document.getElementById('openhandsApiKeyInput').value`))
      .toBe('');
    expect(await attr(app, 'openhandsConnectionStatus', 'data-key-set')).toBe('true');
    expect(JSON.stringify(await state(app))).not.toContain(KEY);

    await shell(app, `document.getElementById('openhandsApiKeyClear').click()`);
    await expect.poll(async () => (await state(app)).openhandsApiKeySet).toBe(false);

    // Invalid URL: leaving the tab is refused, the error sits under the field.
    await setInputValue(app, 'openhandsBaseUrlInput', 'http://x');
    await shell(app, `document.querySelector('[data-settings-tab="general"]').click()`);
    await expect.poll(async () => hasEl(app, 'openhandsBaseUrlInputError')).toBe(true);
    expect(await attr(app, 'openhandsBaseUrlInput', 'aria-invalid')).toBe('true');

    // A sub-path https URL is stored normalised.
    await setInputValue(app, 'openhandsBaseUrlInput', 'https://corp.example/openhands/');
    await shell(app, `document.querySelector('[data-settings-tab="general"]').click()`);
    await expect
      .poll(async () => (await state(app)).settings.openhands.baseUrl)
      .toBe('https://corp.example/openhands');

    expect((await readEvents(logFile)).some((e) => JSON.stringify(e).includes(KEY))).toBe(false);
  } finally {
    await quit(app, profile);
  }
});
