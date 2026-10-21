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
const loginUrl = () => `${fixtures.githubUrl}/login`;

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

// The prompt show-fallback is shortened for tests; the auto-dismiss stays at
// the default 10 s so polls have a wide visibility window (the auto-dismiss
// test opts into a short window via DISMISS_MS).
async function launch(
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; profile: string; logFile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-capture-'));
  const logFile = join(profile, 'events.jsonl');
  writeFileSync(logFile, '', 'utf8');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, {
    AGENT_WORKSPACE_TEST_AUTOFILL_PROMPT_MS: '300',
    ...extraEnv,
  });
  await expect
    .poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace)))
    .toBe(true);
  return { app, profile, logFile };
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await closeApp(app);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

async function saveCredential(
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

async function listCredentials(app: ElectronApplication): Promise<SavedCredential[]> {
  return app.evaluate(() =>
    (globalThis as typeof globalThis & {
      __agentworkspace: { listCredentials(): SavedCredential[] };
    }).__agentworkspace.listCredentials(),
  );
}

async function reveal(app: ElectronApplication, id: string): Promise<string | null> {
  return app.evaluate((_electron, credId: string) =>
    (globalThis as typeof globalThis & {
      __agentworkspace: { revealCredential(id: string): Promise<string | null> };
    }).__agentworkspace.revealCredential(credId), id);
}

// Mirror real typing: native setter + input event.
async function type(app: ElectronApplication, urlPrefix: string, id: string, value: string) {
  await evaluateInView(
    app,
    urlPrefix,
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
}

async function clickInView(app: ElectronApplication, urlPrefix: string, id: string) {
  await evaluateInView(
    app,
    urlPrefix,
    `(() => { document.getElementById(${JSON.stringify(id)}).click(); })()`,
  );
}

test('submit captures credentials and Save persists them', async () => {
  const { app, profile, logFile } = await launch();
  try {
    await openTab(app, loginUrl());
    await waitForTabTitle(app, 'Fixture login');
    await type(app, loginUrl(), 'user', 'carol');
    await type(app, loginUrl(), 'pass', 'pw1');
    await clickInView(app, loginUrl(), 'submit');

    // The fixture form doesn't navigate — the show fallback fires.
    await expect
      .poll(async () => (await state(app)).autofill.prompt)
      .toMatchObject({ kind: 'save', username: 'carol' });
    await expect
      .poll(async () =>
        evaluateInShell(app, `Boolean(document.getElementById('autofillPrompt'))`),
      )
      .toBe(true);

    await evaluateInShell(app, `document.getElementById('autofillPromptSave').click()`);
    await expect.poll(async () => (await state(app)).autofill.prompt).toBe(null);

    const creds = await listCredentials(app);
    const carol = creds.find(
      (c) => c.origin === githubOrigin() && c.username === 'carol',
    );
    expect(carol).toBeTruthy();
    expect(await reveal(app, carol!.id)).toBe('pw1');

    // Shell lowered back to the bottom of the stack.
    await expect
      .poll(async () =>
        app.evaluate(() =>
          (globalThis as typeof globalThis & {
            __agentworkspace: { childViews(): { url: string | null }[] };
          }).__agentworkspace.childViews()[0]?.url?.startsWith('app://shell/'),
        ),
      )
      .toBe(true);

    // Secrets stay out of the log and the vault.
    expect(JSON.stringify(await readEvents(logFile))).not.toContain('pw1');
    expect(readFileSync(join(profile, 'credentials.json'), 'utf8')).not.toContain('pw1');
  } finally {
    await close(app, profile);
  }
});

test('submitting unchanged credentials does not prompt', async () => {
  const { app, profile, logFile } = await launch();
  try {
    await saveCredential(app, 'carol', 'pw1');
    await openTab(app, loginUrl());
    await waitForTabTitle(app, 'Fixture login');
    await expect
      .poll(async () =>
        evaluateInView(app, loginUrl(), `document.getElementById('pass').value`),
      )
      .toBe('pw1');
    await clickInView(app, loginUrl(), 'submit');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await state(app)).autofill.prompt).toBe(null);
    const events = await readEvents(logFile);
    expect(
      events.some(
        (entry) =>
          entry.event === 'autofill-capture' &&
          JSON.stringify(entry.detail).includes('"unchanged"'),
      ),
    ).toBe(true);
  } finally {
    await close(app, profile);
  }
});

test('submitting a changed password offers an update', async () => {
  const { app, profile } = await launch();
  try {
    const carol = await saveCredential(app, 'carol', 'pw1');
    await openTab(app, loginUrl());
    await waitForTabTitle(app, 'Fixture login');
    await expect
      .poll(async () =>
        evaluateInView(app, loginUrl(), `document.getElementById('pass').value`),
      )
      .toBe('pw1');
    await type(app, loginUrl(), 'pass', 'pw2');
    await clickInView(app, loginUrl(), 'submit');

    await expect
      .poll(async () => (await state(app)).autofill.prompt?.kind)
      .toBe('update');
    await evaluateInShell(app, `document.getElementById('autofillPromptSave').click()`);
    await expect.poll(async () => (await state(app)).autofill.prompt).toBe(null);
    expect(await reveal(app, carol.id)).toBe('pw2');
    const creds = await listCredentials(app);
    expect(creds.filter((c) => c.username === 'carol')).toHaveLength(1);
  } finally {
    await close(app, profile);
  }
});

test('dismissing the prompt stores nothing', async () => {
  const { app, profile, logFile } = await launch();
  try {
    await openTab(app, loginUrl());
    await waitForTabTitle(app, 'Fixture login');
    await type(app, loginUrl(), 'user', 'dave');
    await type(app, loginUrl(), 'pass', 'x');
    await clickInView(app, loginUrl(), 'submit');
    await expect
      .poll(async () => (await state(app)).autofill.prompt?.kind)
      .toBe('save');
    await evaluateInShell(app, `document.getElementById('autofillPromptDismiss').click()`);
    await expect.poll(async () => (await state(app)).autofill.prompt).toBe(null);
    expect((await listCredentials(app)).some((c) => c.username === 'dave')).toBe(false);
    const events = await readEvents(logFile);
    expect(events.some((entry) => entry.event === 'autofill-dismiss')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('dave');
  } finally {
    await close(app, profile);
  }
});

test('a two-step SPA submit captures username and password', async () => {
  const { app, profile } = await launch();
  try {
    const stepsUrl = `${fixtures.githubUrl}/login-steps`;
    await openTab(app, stepsUrl);
    await waitForTabTitle(app, 'Fixture login steps');
    await type(app, stepsUrl, 'identifier', 'erin');
    await clickInView(app, stepsUrl, 'next');
    await expect
      .poll(async () =>
        evaluateInView(
          app,
          stepsUrl,
          `document.getElementById('step2').hidden === false`,
        ),
      )
      .toBe(true);
    await type(app, stepsUrl, 'pass', 'pw-erin');
    await clickInView(app, stepsUrl, 'submit2');
    await expect
      .poll(async () => (await state(app)).autofill.prompt)
      .toMatchObject({ kind: 'save', username: 'erin' });
  } finally {
    await close(app, profile);
  }
});

test('the prompt survives a real navigation', async () => {
  const { app, profile } = await launch();
  try {
    const url = `${fixtures.githubUrl}/login-redirect`;
    const tabId = await openTab(app, url);
    await waitForTabTitle(app, 'Fixture login redirect');
    await type(app, url, 'user', 'frank');
    await type(app, url, 'pass', 'pw-frank');
    // The click starts a real navigation — the evaluate may not resolve, so
    // don't wait on it.
    await Promise.race([
      clickInView(app, url, 'submit'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    await expect.poll(async () => (await state(app)).autofill.prompt).not.toBe(null);
    // The prompt only appears once navigation completed.
    const tab = (await state(app)).tabs.tabs.find((entry) => entry.id === tabId);
    expect(new URL(tab!.url).origin).toBe(githubOrigin());
    expect(new URL(tab!.url).pathname).toBe('/');
  } finally {
    await close(app, profile);
  }
});

test('a pending capture survives a scope switch caused by another navigation', async () => {
  const { app, profile, logFile } = await launch();
  try {
    const url = `${fixtures.githubUrl}/login-redirect`;
    await openTab(app, url);
    await waitForTabTitle(app, 'Fixture login redirect');
    await type(app, url, 'user', 'heidi');
    await type(app, url, 'pass', 'pw-h');
    await Promise.race([
      clickInView(app, url, 'submit'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    // Immediately flip the scope by navigating the devin view to a session —
    // historically this ran onActiveChanged and dropped the armed capture.
    await app.evaluate((_electron, target: string) => {
      (globalThis as typeof globalThis & {
        __agentworkspace: { loadDevinUrl(url: string): void };
      }).__agentworkspace.loadDevinUrl(target);
    }, `${fixtures.devinUrl}/sessions/B`);
    // Whether the prompt shows before or after the switch, the capture must not
    // be dropped — assert via the persisted prompt event.
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some((entry) => entry.event === 'autofill-prompt'),
      )
      .toBe(true);
    await expect.poll(async () => (await state(app)).tabs.scope).toBe('B');
  } finally {
    await close(app, profile);
  }
});

test('the prompt auto-dismisses', async () => {
  const { app, profile, logFile } = await launch({
    AGENT_WORKSPACE_TEST_AUTOFILL_DISMISS_MS: '1000',
  });
  try {
    await openTab(app, loginUrl());
    await waitForTabTitle(app, 'Fixture login');
    await type(app, loginUrl(), 'user', 'grace');
    await type(app, loginUrl(), 'pass', 'pw-g');
    await clickInView(app, loginUrl(), 'submit');
    // The prompt may appear and vanish between polls — assert via the log.
    await expect
      .poll(async () =>
        (await readEvents(logFile)).some((entry) => entry.event === 'autofill-prompt'),
      )
      .toBe(true);
    await expect.poll(async () => (await state(app)).autofill.prompt).toBe(null);
  } finally {
    await close(app, profile);
  }
});

test('quitting while the save prompt is shown exits cleanly', async () => {
  const { app, profile } = await launch();
  let exited = false;
  try {
    await openTab(app, loginUrl());
    await waitForTabTitle(app, 'Fixture login');
    await type(app, loginUrl(), 'user', 'ivy');
    await type(app, loginUrl(), 'pass', 'pw-i');
    await clickInView(app, loginUrl(), 'submit');
    await expect.poll(async () => (await state(app)).autofill.prompt).not.toBe(null);
    // Quit with the prompt (raised shell) still shown: teardown must not
    // restack views over dying webContents — the process must exit.
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.quit()),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        const proc = app.process();
        if (!proc) return resolve(false);
        if (proc.exitCode !== null) return resolve(true);
        proc.once('exit', () => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    expect(exited).toBe(true);
  } finally {
    if (!exited) await closeApp(app);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
