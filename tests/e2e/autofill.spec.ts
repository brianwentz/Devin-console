import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  closeApp,
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

interface SavedCredential {
  id: string;
  origin: string;
  username: string;
}

async function launch(): Promise<{ app: ElectronApplication; profile: string; logFile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-autofill-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return { app, profile, logFile };
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await closeApp(app);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

async function save(
  app: ElectronApplication,
  username: string,
  password: string,
): Promise<SavedCredential> {
  const entry = await app.evaluate((_electron, credential) => {
    return (
      globalThis as typeof globalThis & {
        __agentworkspace: {
          saveCredential(c: typeof credential): Promise<SavedCredential | null>;
        };
      }
    ).__agentworkspace.saveCredential(credential);
  }, { origin: githubOrigin(), username, password });
  expect(entry?.id).toBeTruthy();
  return entry!;
}

const fieldValues = (app: ElectronApplication, urlPrefix: string) =>
  evaluateInView(
    app,
    urlPrefix,
    `({ user: document.getElementById('user')?.value ?? document.getElementById('identifier')?.value ?? null, pass: document.getElementById('pass')?.value ?? null })`,
  ) as Promise<{ user: string | null; pass: string | null }>;

test('single account auto-fills without submitting and marks lastUsedAt', async () => {
  const { app, profile, logFile } = await launch();
  try {
    const entry = await save(app, 'alice', 's3cret');
    await openTab(app, `${fixtures.githubUrl}/login`);
    await waitForTabTitle(app, 'Fixture login');

    await expect
      .poll(async () => fieldValues(app, `${fixtures.githubUrl}/login`))
      .toEqual({ user: 'alice', pass: 's3cret' });
    // Never auto-submits.
    expect(await evaluateInView(app, `${fixtures.githubUrl}/login`, 'document.title')).toBe(
      'Fixture login',
    );
    // Clicking submit uses the filled values.
    await evaluateInView(
      app,
      `${fixtures.githubUrl}/login`,
      `document.getElementById('submit').click()`,
    );
    await expect
      .poll(async () => evaluateInView(app, `${fixtures.githubUrl}/login`, 'document.title'))
      .toBe('submitted:alice:s3cret');

    // A fill that sent a password touches lastUsedAt.
    await expect
      .poll(async () =>
        app.evaluate((_electron, id: string) => {
          const list = (
            globalThis as typeof globalThis & {
              __agentworkspace: {
                listCredentials(): { id: string; lastUsedAt: number | null }[];
              };
            }
          ).__agentworkspace.listCredentials();
          return list.find((item) => item.id === id)?.lastUsedAt ?? null;
        }, entry.id),
      )
      .not.toBe(null);

    // Isolation: nothing leaked into the page's main world.
    const isolation = await evaluateInView(
      app,
      `${fixtures.githubUrl}/login`,
      `[typeof require, typeof process, typeof window.agentworkspace, typeof ipcRenderer]`,
    );
    expect(isolation).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);

    // Secrets stay out of the log and the vault file.
    const events = await readEvents(logFile);
    expect(JSON.stringify(events)).not.toContain('s3cret');
    expect(readFileSync(join(profile, 'credentials.json'), 'utf8')).not.toContain('s3cret');
  } finally {
    await close(app, profile);
  }
});

test('two-step login fills username then password', async () => {
  const { app, profile } = await launch();
  try {
    await save(app, 'alice', 's3cret');
    await openTab(app, `${fixtures.githubUrl}/login-steps`);
    await waitForTabTitle(app, 'Fixture login steps');

    await expect
      .poll(async () =>
        evaluateInView(
          app,
          `${fixtures.githubUrl}/login-steps`,
          `document.getElementById('identifier').value`,
        ),
      )
      .toBe('alice');
    await evaluateInView(
      app,
      `${fixtures.githubUrl}/login-steps`,
      `document.getElementById('next').click()`,
    );
    await expect
      .poll(async () =>
        evaluateInView(
          app,
          `${fixtures.githubUrl}/login-steps`,
          `document.getElementById('pass').value`,
        ),
      )
      .toBe('s3cret');
    await evaluateInView(
      app,
      `${fixtures.githubUrl}/login-steps`,
      `document.getElementById('submit2').click()`,
    );
    await expect
      .poll(async () => evaluateInView(app, `${fixtures.githubUrl}/login-steps`, 'document.title'))
      .toBe('submitted:alice:s3cret');
  } finally {
    await close(app, profile);
  }
});

test('multiple accounts open the picker; pick fills and lowers the shell', async () => {
  const { app, profile } = await launch();
  try {
    await save(app, 'alice', 's3cret');
    const bob = await save(app, 'bob', 'b0b-pw');
    await openTab(app, `${fixtures.githubUrl}/login`);
    await waitForTabTitle(app, 'Fixture login');

    // Nothing auto-fills while multiple accounts match.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await fieldValues(app, `${fixtures.githubUrl}/login`)).toEqual({
      user: '',
      pass: '',
    });

    // Focusing a login field asks main for the picker.
    await evaluateInView(
      app,
      `${fixtures.githubUrl}/login`,
      `(() => { const el=document.getElementById('user'); el.focus(); el.dispatchEvent(new FocusEvent('focusin',{bubbles:true})); })()`,
    );
    await expect
      .poll(async () => (await state(app)).autofill.picker?.accounts.length)
      .toBe(2);
    await expect
      .poll(async () => evaluateInShell(app, `Boolean(document.getElementById('autofillPicker'))`))
      .toBe(true);

    // Picking bob fills both fields and dismisses the picker.
    await evaluateInShell(
      app,
      `document.querySelector('#autofillPicker [data-account-id="${bob.id}"]').click()`,
    );
    await expect
      .poll(async () => fieldValues(app, `${fixtures.githubUrl}/login`))
      .toEqual({ user: 'bob', pass: 'b0b-pw' });
    await expect.poll(async () => (await state(app)).autofill.picker).toBe(null);
    // Shell is back at the bottom of the stacking order.
    await expect
      .poll(async () =>
        app.evaluate(() =>
          (globalThis as typeof globalThis & {
            __agentworkspace: { childViews(): { url: string | null }[] };
          }).__agentworkspace.childViews()[0]?.url?.startsWith('app://shell/'),
        ),
      )
      .toBe(true);

    // Reopen then dismiss via the backdrop.
    await evaluateInView(
      app,
      `${fixtures.githubUrl}/login`,
      `(() => { const el=document.getElementById('pass'); el.focus(); el.dispatchEvent(new FocusEvent('focusin',{bubbles:true})); })()`,
    );
    await expect
      .poll(async () => (await state(app)).autofill.picker !== null)
      .toBe(true);
    await evaluateInShell(app, `(() => { document.getElementById('autofillBackdrop').dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); })()`);
    await expect.poll(async () => (await state(app)).autofill.picker).toBe(null);
    await expect
      .poll(async () =>
        app.evaluate(() =>
          (globalThis as typeof globalThis & {
            __agentworkspace: { childViews(): { url: string | null }[] };
          }).__agentworkspace.childViews()[0]?.url?.startsWith('app://shell/'),
        ),
      )
      .toBe(true);
  } finally {
    await close(app, profile);
  }
});

test('a cross-origin iframe is not filled and its IPC would be rejected', async () => {
  const { app, profile, logFile } = await launch();
  try {
    await save(app, 'alice', 's3cret');
    const tabId = await openTab(app, `${fixtures.devinUrl}/embed-login`);
    await waitForTabTitle(app, 'Fixture embed login');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The cross-origin frame's fields stay empty.
    const userValue = await app.evaluate((_electron, id: string) => {
      const contents = (
        globalThis as typeof globalThis & {
          __agentworkspace: { getTabWebContents(id: string): Electron.WebContents | null };
        }
      ).__agentworkspace.getTabWebContents(id);
      const frame = contents?.mainFrame.frames.find((f) => f.url.includes('/login'));
      return frame?.executeJavaScript(`document.getElementById('user').value`);
    }, tabId);
    expect(userValue).toBe('');

    // Either the frame bailed in the preload (no query at all) or main rejected it.
    const events = await readEvents(logFile);
    const queries = events.filter((entry) => entry.event === 'autofill-query');
    const rejected = events.filter(
      (entry) =>
        entry.event === 'ipc-rejected' &&
        JSON.stringify(entry.detail).includes('autofill:query'),
    );
    expect(queries.length === 0 || rejected.length > 0).toBe(true);
  } finally {
    await close(app, profile);
  }
});

test('a search-only page never triggers an autofill query', async () => {
  const { app, profile, logFile } = await launch();
  try {
    await save(app, 'alice', 's3cret');
    await openTab(app, `${fixtures.githubUrl}/search`);
    await waitForTabTitle(app, 'Fixture search');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const events = await readEvents(logFile);
    expect(events.filter((entry) => entry.event === 'autofill-query')).toEqual([]);
  } finally {
    await close(app, profile);
  }
});
