import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  launchApp,
  state,
  waitForDecision,
  waitForTabCount,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launch(profile: string, logFile: string) {
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
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
const clickTab = (app: ElectronApplication, id: string) =>
  shell(app, `document.querySelector('[data-settings-tab="${id}"]').click()`);

// React-compatible value set on a row control (native setter + bubbling event).
function setRuleControl(
  app: ElectronApplication,
  selector: string,
  value: string,
  checked?: boolean,
): Promise<unknown> {
  return shell(
    app,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (${JSON.stringify(checked === undefined ? 'value' : 'checked')} === 'checked') {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
        setter.call(el, ${JSON.stringify(checked ?? false)});
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('click', { bubbles: true }));
      } else {
        const proto = el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      }
      return true;
    })()`,
  );
}

test('a prefix rule routes matching links to a pane tab and logs rule-tab', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-linkrules-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'links');
    await expect
      .poll(async () => shell(app, `Boolean(document.getElementById('linkRuleAdd'))`))
      .toBe(true);

    // Add a prefix rule for the fixture IdP origin (an "external" origin).
    await shell(app, `document.getElementById('linkRuleAdd').click()`);
    await expect
      .poll(async () => shell(app, `document.querySelectorAll('#linkRulesList [data-rule-id]').length`))
      .toBe(1);
    expect(
      await setRuleControl(app, '#linkRulesList [data-rule-pattern]', `${fixtures.idpUrl}/`),
    ).toBe(true);

    // Tab switch commits implicitly.
    await clickTab(app, 'passwords');
    await expect
      .poll(async () => ((await state(app)).settings.routing as any)?.rules?.length)
      .toBe(1);

    // A matching link opens a pane tab and logs rule-tab (never the pattern).
    await app.evaluate(
      (_e, url: string) => (globalThis as any).__agentworkspace.routeLink(url),
      `${fixtures.idpUrl}/away`,
    );
    const entry = await waitForDecision(logFile, 'rule-tab', '/away');
    expect((entry.detail as any)?.ruleId).toBeTruthy();
    expect((entry.detail as any)?.ruleKind).toBe('prefix');
    await waitForTabCount(app, 1);

    // Disabling the rule sends the link back to the system browser.
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'links');
    await expect
      .poll(async () => shell(app, `Boolean(document.querySelector('#linkRulesList [data-rule-enabled]'))`))
      .toBe(true);
    await shell(app, `document.querySelector('#linkRulesList [data-rule-enabled]').click()`);
    await clickTab(app, 'passwords');
    await expect
      .poll(async () => ((await state(app)).settings.routing as any)?.rules?.[0]?.enabled)
      .toBe(false);

    await app.evaluate(
      (_e, url: string) => (globalThis as any).__agentworkspace.routeLink(url),
      `${fixtures.idpUrl}/elsewhere`,
    );
    await waitForDecision(logFile, 'external', 'elsewhere');
    expect((await state(app)).tabs.tabs).toHaveLength(1);
  } finally {
    await quit(app, profile);
  }
});

const profileOptions = (app: ElectronApplication) =>
  shell(
    app,
    `[...document.querySelectorAll('#favoritesProfileSelect option')].map((o) => o.value + '=' + o.textContent)`,
  ) as Promise<string[]>;

test('Favorites: the Chrome profile select lists Local State profiles and commits the choice', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-favorites-'));
  const chrome = join(profile, 'chrome-user-data');
  cpSync(join(process.cwd(), 'tests/fixtures/chrome-user-data'), chrome, { recursive: true });
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_CHROME_USER_DATA: chrome,
  });
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'links');
    await expect
      .poll(() => profileOptions(app))
      .toEqual(['=Last used Chrome profile', 'Default=Person 1', 'Profile 1=Work']);
    expect(await shell(app, `document.getElementById('favoritesProfileSelect').value`)).toBe('');
    expect(await setRuleControl(app, '#favoritesProfileSelect', 'Default')).toBe(true);
    await clickTab(app, 'passwords');
    await expect
      .poll(async () => ((await state(app)).settings as any).favorites?.chromeProfile)
      .toBe('Default');
  } finally {
    await quit(app, profile);
  }
});

test('Favorites: without Chrome the select keeps an unlisted configured profile', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-favorites-missing-'));
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ favorites: { chromeProfile: 'Profile 7' } }));
  const logFile = join(profile, 'events.jsonl');
  const app = await launch(profile, logFile);
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await clickTab(app, 'links');
    await expect
      .poll(() => profileOptions(app))
      .toEqual(['=Last used Chrome profile', 'Profile 7=Profile 7 (not found)']);
    expect(await shell(app, `document.getElementById('favoritesProfileSelect').value`)).toBe('Profile 7');
    expect(
      await shell(app, `document.querySelector('[data-settings-section="links-favorites"]').textContent.includes('Google Chrome profiles not found')`),
    ).toBe(true);
    await clickTab(app, 'passwords');
    expect(((await state(app)).settings as any).favorites?.chromeProfile).toBe('Profile 7');
  } finally {
    await quit(app, profile);
  }
});
