// ux3 S1b: real-pointer drags through Chromium's native HTML5 DnD. Runs in the
// default quiet mode (invisible, never activated) like every other spec — do
// not opt out with AGENT_WORKSPACE_TEST_QUIET=0 (tests/unit/quietGuard.test.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  closeApp,
  evaluateInShell,
  launchApp,
  launchWithClaudeFixture,
  shellPage,
  waitForEvent,
} from './helpers';

const FAKE_AGENT_CMD = 'node out/fixtures/fakeAcpAgent.cjs';

let fixtures: FixtureServers;
test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});
test.afterAll(async () => {
  await fixtures.close();
});

// Locates a header by data-section-name index (paths contain backslashes).
const sectionIndex = (app: ElectronApplication, name: string) =>
  evaluateInShell(
    app,
    `[...document.querySelectorAll('[data-section-name]')].findIndex((e) => e.getAttribute('data-section-name') === ${JSON.stringify(name)})`,
  ) as Promise<number>;

const sectionOrder = (app: ElectronApplication) =>
  evaluateInShell(
    app,
    `[...document.querySelectorAll('[data-section-name]')].map((e) => e.getAttribute('data-section-name'))`,
  ) as Promise<string[]>;

async function sectionAt(shell: Page, app: ElectronApplication, name: string) {
  const i = await sectionIndex(app, name);
  if (i < 0) throw new Error(`section not found: ${name}`);
  return shell.locator('[data-section-name]').nth(i);
}

async function pointerDrag(from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>) {
  const fb = (await from.boundingBox())!;
  const tb = (await to.boundingBox())!;
  const page = from.page();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test('Local: real-pointer workspace header drag reorders and persists', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'dndp-local-'));
  const wsA = mkdtempSync(join(tmpdir(), 'dndp-wsA-'));
  const wsB = mkdtempSync(join(tmpdir(), 'dndp-wsB-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_LIST: '1',
  });
  try {
    await app.evaluate(
      (_e, v: string) => (globalThis as any).__agentworkspace.localAddWorkspace(v),
      wsA,
    );
    await app.evaluate(
      (_e, v: string) => (globalThis as any).__agentworkspace.localAddWorkspace(v),
      wsB,
    );
    await app.evaluate((_e, v: string) => (globalThis as any).__agentworkspace.localNewSession(v), wsA);
    await app.evaluate((_e, v: string) => (globalThis as any).__agentworkspace.localNewSession(v), wsB);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('local'));
    const shell = await shellPage(app);
    const secA = await sectionAt(shell, app, wsA);
    const secB = await sectionAt(shell, app, wsB);
    await secA.waitFor();
    expect(await sectionOrder(app)).toEqual([wsA, wsB]);

    await pointerDrag(secB, secA);
    await expect.poll(() => sectionOrder(app)).toEqual([wsB, wsA]);
    await waitForEvent(logFile, 'local-workspace-reorder');
    expect(
      (JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as any).workspaces,
    ).toEqual([wsB, wsA]);
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  }
});

test('Claude: real-pointer workspace header drag reorders and persists', async () => {
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
  });
  try {
    const wsA = 'C:\\work\\dndp-alpha';
    const wsB = 'C:\\work\\dndp-beta';
    const shell = await shellPage(app);
    for (const w of [wsA, wsB]) {
      await shell.evaluate((path) => window.agentworkspace.claudeWorkspaceAdd(path), w);
    }
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    const secA = await sectionAt(shell, app, wsA);
    const secB = await sectionAt(shell, app, wsB);
    await expect.poll(async () => sectionIndex(app, wsA)).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => sectionIndex(app, wsB)).toBeGreaterThanOrEqual(0);

    await pointerDrag(secB, secA);
    const order = await sectionOrder(app);
    expect(order.indexOf(wsB)).toBeLessThan(order.indexOf(wsA));
    await expect
      .poll(
        () =>
          (JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as any)?.claude
            ?.workspaces,
      )
      .toEqual([wsB, wsA]);
    await waitForEvent(join(profile, 'events.jsonl'), 'claude-workspace-reorder');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('negative: a lone workspace header is not draggable', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'dndp-single-'));
  const ws = mkdtempSync(join(tmpdir(), 'dndp-ws-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_LOCAL_AGENT_CMD: FAKE_AGENT_CMD,
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    FAKE_ACP_LIST: '1',
  });
  try {
    await app.evaluate(
      (_e, v: string) => (globalThis as any).__agentworkspace.localAddWorkspace(v),
      ws,
    );
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('local'));
    const shell = await shellPage(app);
    const sec = await sectionAt(shell, app, ws);
    await sec.waitFor();
    await expect(sec).toHaveAttribute('draggable', 'false');
  } finally {
    await closeApp(app);
    rmSync(profile, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
