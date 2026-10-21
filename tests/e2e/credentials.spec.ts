import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  evaluateInShell,
  evaluateInView,
  launchApp,
  openTab,
  readEvents,
  state,
  waitForTabTitle,
} from './helpers';

let fixtures: FixtureServers;
const githubOrigin = () => new URL(fixtures.githubUrl).origin;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const fieldValues = (app: ElectronApplication) =>
  evaluateInView(
    app,
    `${fixtures.githubUrl}/login`,
    `({ user: document.getElementById('user').value, pass: document.getElementById('pass').value })`,
  ) as Promise<{ user: string; pass: string }>;

test('credential vault saves, autofills, and keeps secrets out of logs', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  let app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  let closed = false;
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);

    const saved = await app.evaluate((_electron, credential) => {
      return (
        globalThis as typeof globalThis & {
          __agentworkspace: {
            saveCredential(c: typeof credential): Promise<{ id: string } | null>;
          };
        }
      ).__agentworkspace.saveCredential(credential);
    }, { origin: githubOrigin(), username: 'alice', password: 's3cret' });
    expect(saved?.id).toBeTruthy();
    await expect
      .poll(async () =>
        (await state(app)).credentials.some(
          (entry) => entry.origin === githubOrigin() && entry.username === 'alice',
        ),
      )
      .toBe(true);

    // Autofill fills the saved account into the login tab.
    await openTab(app, `${fixtures.githubUrl}/login`);
    await waitForTabTitle(app, 'Fixture login');
    await expect
      .poll(async () => fieldValues(app))
      .toEqual({ user: 'alice', pass: 's3cret' });
    await evaluateInView(
      app,
      `${fixtures.githubUrl}/login`,
      `(() => { document.getElementById('submit').click(); })()`,
    );
    await expect
      .poll(async () => evaluateInView(app, `${fixtures.githubUrl}/login`, `document.title`))
      .toBe('submitted:alice:s3cret');

    // Secrets must not reach the log or the vault file.
    const events = await readEvents(logFile);
    expect(JSON.stringify(events)).not.toContain('s3cret');
    const vault = readFileSync(join(profile, 'credentials.json'), 'utf8');
    expect(vault).not.toContain('s3cret');

    // Cookie persistence across relaunch (fixture github root sets fixture_persist).
    await openTab(app, `${fixtures.githubUrl}/`);
    await waitForTabTitle(app, 'home');
    await expect
      .poll(async () =>
        app.evaluate(async ({ session }) => {
          const cookies = await session
            .fromPartition('persist:github')
            .cookies.get({ name: 'fixture_persist' });
          return cookies.length;
        }),
      )
      .toBe(1);

    // Cookie audit hook returns both partitions, metadata only.
    const audit = await app.evaluate(() =>
      (globalThis as typeof globalThis & {
        __agentworkspace: {
          auditCookies(): Promise<Array<{ partition: string; cookies: Array<Record<string, unknown>> }>>;
        };
      }).__agentworkspace.auditCookies(),
    );
    expect(audit.map((entry) => entry.partition).sort()).toEqual([
      'persist:cloud',
      'persist:github',
    ]);
    for (const entry of audit) {
      for (const cookie of entry.cookies) {
        expect(cookie.value).toBeUndefined();
      }
    }

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await app.close();
    closed = true;

    // Relaunch: cookie survives.
    app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
    closed = false;
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    const persisted = await app.evaluate(async ({ session }) =>
      session.fromPartition('persist:github').cookies.get({ name: 'fixture_persist' }),
    );
    expect(persisted).toHaveLength(1);
    expect(existsSync(join(profile, 'credentials.json'))).toBe(true);
  } finally {
    if (!closed) {
      await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    rmSync(profile, { recursive: true, force: true });
  }
});

test('migrates a v1 credentials.json and manages passwords from Settings', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-e2e-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  // Pre-seed a v1 vault; the store must migrate it to version 2 on launch.
  writeFileSync(
    join(profile, 'credentials.json'),
    JSON.stringify({
      entries: [
        { origin: githubOrigin(), username: 'legacy', passwordEnc: 'dGVzdA==' },
      ],
    }),
    'utf8',
  );
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect
      .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
      .toBe(true);
    await expect
      .poll(async () =>
        (await state(app)).credentials.some(
          (entry) => entry.origin === githubOrigin() && entry.username === 'legacy',
        ),
      )
      .toBe(true);
    const migrated = (await state(app)).credentials.find(
      (entry) => entry.username === 'legacy',
    );
    expect(migrated?.id).toBeTruthy();
    expect(JSON.parse(readFileSync(join(profile, 'credentials.json'), 'utf8')).version).toBe(2);

    // Save a fresh entry to drive the Settings UI flow.
    const saved = await app.evaluate((_electron, credential) => {
      return (
        globalThis as typeof globalThis & {
          __agentworkspace: {
            saveCredential(c: typeof credential): Promise<{ id: string } | null>;
          };
        }
      ).__agentworkspace.saveCredential(credential);
    }, { origin: githubOrigin(), username: 'alice', password: 's3cret' });
    expect(saved?.id).toBeTruthy();
    const id = saved!.id;

    await evaluateInShell(app, `window.agentworkspace.setSurface('settings')`);
    await evaluateInShell(app, `document.querySelector('[data-settings-tab="passwords"]').click()`);
    const rowSelector = `tr[data-credential-id="${id}"]`;
    await expect
      .poll(async () =>
        evaluateInShell(app, `Boolean(document.querySelector('${rowSelector}'))`),
      )
      .toBe(true);

    // Show → the readonly input displays the decrypted password.
    await evaluateInShell(app, `document.getElementById('credentialReveal-${id}').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `document.querySelector('${rowSelector} input[readonly]')?.value`),
      )
      .toBe('s3cret');

    // Edit → change password → Save → reveal shows the new value.
    await evaluateInShell(app, `document.getElementById('credentialEdit-${id}').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `Boolean(document.getElementById('credentialEditPassword-${id}'))`),
      )
      .toBe(true);
    await evaluateInShell(
      app,
      `(() => {
        const input = document.getElementById('credentialEditPassword-${id}');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'n3wSecret');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    );
    await evaluateInShell(app, `document.getElementById('credentialEditSave-${id}').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `Boolean(document.getElementById('credentialEditPassword-${id}'))`),
      )
      .toBe(false);
    // The first Show is still visible (30 s auto-hide) — toggle it off, then on again.
    await evaluateInShell(app, `document.getElementById('credentialReveal-${id}').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `Boolean(document.querySelector('${rowSelector} input[readonly]'))`),
      )
      .toBe(false);
    await evaluateInShell(app, `document.getElementById('credentialReveal-${id}').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `document.querySelector('${rowSelector} input[readonly]')?.value`),
      )
      .toBe('n3wSecret');

    // Delete requires two clicks (confirm step).
    await evaluateInShell(app, `document.getElementById('credentialDelete-${id}').click()`);
    expect(
      await evaluateInShell(
        app,
        `document.getElementById('credentialDelete-${id}').textContent`,
      ),
    ).toBe('Confirm delete');
    expect(
      await evaluateInShell(app, `Boolean(document.querySelector('${rowSelector}'))`),
    ).toBe(true);
    await evaluateInShell(app, `document.getElementById('credentialDelete-${id}').click()`);
    await expect
      .poll(async () =>
        evaluateInShell(app, `Boolean(document.querySelector('${rowSelector}'))`),
      )
      .toBe(false);

    const events = await readEvents(logFile);
    expect(JSON.stringify(events)).not.toContain('s3cret');
    expect(JSON.stringify(events)).not.toContain('n3wSecret');
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
