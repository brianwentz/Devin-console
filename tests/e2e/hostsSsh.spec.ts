import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  closeApp,
  evaluateInShell,
  launchWithClaudeFixture,
  readEvents,
  setInputValue,
  shellPage,
  state,
} from './helpers';

// P3 Task 13: the `ssh:<alias>` host kind end to end over the fake ssh.exe
// (tests/fixtures/fakeSsh.ts, AGENT_WORKSPACE_TEST_SSH_CMD): it splits the ONE
// remote command string and runs the REAL built helper bundle under
// FAKE_SSH_ROOT, so probe → deploy → hello → store.list → chat/pty spawn specs
// are exercised exactly as the app builds them. The alias never reaches the
// event log (sha256-8 only).

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

const HOST = 'ssh:box';
const FAKE_SDK = resolve(__dirname, '../../out/fixtures/fakeClaudeSdk.mjs');
const FAKE_PTY = `node ${join(process.cwd(), 'out/fixtures/fakePty.cjs')}`;
const STORE_ID = '55555555-0000-4000-8000-000000000055';
const ALIAS_HASH = createHash('sha256').update('box').digest('hex').slice(0, 8);

type SshCall = { argv: string[]; alias: string; tty: boolean; reverse: string | null; forward: boolean; remote: string };
const logLines = (log: string): Record<string, unknown>[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
const sshCalls = (log: string): SshCall[] => logLines(log).filter((l) => Array.isArray(l.argv)) as SshCall[];
/** KEYS of env the fake ssh decoded from a run script's stdin line / staged file (values are never logged). */
const stagedEnvKeys = (log: string): string[][] =>
  logLines(log)
    .filter((l) => Array.isArray(l.stagedEnvKeys))
    .map((l) => l.stagedEnvKeys as string[]);
const hookInfo = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as any).__agentworkspace.claudeHookInfo()) as Promise<{ port: number; token: string } | null>;
const forwardVerified = (app: ElectronApplication) =>
  app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostHookForwardVerified(id), HOST) as Promise<boolean>;

const transcriptLine = (id: string, cwd: string, text: string): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: '99999999-0000-4000-8000-000000000555',
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: id,
    version: '2.1.302',
    gitBranch: 'main',
  }) + '\n';

async function launchSsh(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-ssh-'));
  const projectDir = join(root, 'home', 'u', '.claude', 'projects', '-home-u-proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${STORE_ID}.jsonl`), transcriptLine(STORE_ID, '/home/u/proj', 'hello from the ssh box'));
  const sshLog = join(root, 'ssh.log');
  currentSshLog = sshLog;
  const { app, profile } = await launchWithClaudeFixture(fixtures, {
    FAKE_SSH_ROOT: root,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_HOSTS: 'box',
    AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS: '300',
    AGENT_WORKSPACE_TEST_SESSIONS_OPEN: '1',
    ...env,
  });
  return { app, profile, root, sshLog, logFile: join(profile, 'events.jsonl') };
}

type SshSettings = {
  hosts: { ssh: { alias: string; enabled: boolean }[] };
  claude: { workspaces: string[] };
  local: { defaultWslDistro: string | null };
  workspaces: string[];
};
const settingsOf = async (app: ElectronApplication) => (await state(app)).settings as unknown as SshSettings;
const hostRow = async (app: ElectronApplication, id = HOST) => (await state(app)).hosts.find((h) => h.id === id);
/** ssh.log of the latest launchSsh (diagnostics only). */
let currentSshLog: string | null = null;
const hostSummary = async (app: ElectronApplication, id: string): Promise<string> => {
  const st = await state(app);
  const row = st.hosts.find((h) => h.id === id);
  if (row) return `${row.state}|helper=${row.helper?.state ?? '-'}|${row.error ?? ''}`;
  // R40 e: say why there is no row — what settings hold and how far ssh got.
  const configured = JSON.stringify((st.settings as unknown as SshSettings).hosts?.ssh ?? null);
  const lines = currentSshLog ? logLines(currentSshLog).length : -1;
  return `no-row|hosts.ssh=${configured}|ssh.log=${lines}`;
};
// Two conditions, not one wall-clock budget for the whole chain: the host
// stays `probing` through probe → env capture → deploy (each ssh run bounded
// by its own timeout in sshHosts.ts), and only then does the helper channel
// start and say hello. Under full-suite load the probe chain alone can eat a
// single 30 s budget; the failure message carries state|helper|error.
const helperReady = async (app: ElectronApplication, id = HOST): Promise<void> => {
  await expect
    .poll(() => hostSummary(app, id), { timeout: 90_000, message: `${id} probe finished` })
    .not.toMatch(/^(no-row|probing\|)/);
  await expect
    .poll(() => hostSummary(app, id), { timeout: 45_000, message: `${id} helper ready` })
    .toMatch(/^ready\|helper=ready\|/);
};
const addSsh = (app: ElectronApplication, alias: string) =>
  app.evaluate((_e, a: string) => (globalThis as any).__agentworkspace.hostSshAdd(a), alias) as Promise<{ ok: boolean }>;
const claudeRows = async (app: ElectronApplication) =>
  ((await app.evaluate(() => (globalThis as any).__agentworkspace.claudeState())) as {
    sessions: { id: string; host: string }[];
  }).sessions;

/** The alias appears in no log line; every host-ssh event is {aliasHash, op}. */
async function expectAliasNeverLogged(logFile: string): Promise<void> {
  const text = readFileSync(logFile, 'utf8');
  expect(text).not.toMatch(/ssh:\/?\/?box/i);
  const sshEvents = (await readEvents(logFile)).filter((e) => e.event === 'host-ssh');
  expect(sshEvents.length).toBeGreaterThan(0);
  for (const e of sshEvents) {
    expect(Object.keys(e.detail as object).sort()).toEqual(['aliasHash', 'op']);
    expect((e.detail as { aliasHash: string }).aliasHash).toBe(ALIAS_HASH);
  }
  // host-exec etc. carry the hashed id form.
  expect(text).toContain(`ssh:#${ALIAS_HASH}`);
}

test('add ssh host → helper ready → sessions listed with host chip', async () => {
  const { app, sshLog, logFile } = await launchSsh();
  try {
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    const shell = await shellPage(app);
    await evaluateInShell(app, `document.querySelector('[data-settings-tab="general"]').click()`);
    await shell.locator('#sshHostAdd').click();
    // A malformed alias is refused with a visible message.
    expect(await setInputValue(app, 'sshHostAliasInput', '-oProxyCommand=x')).toBe(true);
    await shell.locator('#sshHostAddConfirm').click();
    await expect(shell.locator('#sshHostAliasInputError')).toContainText('Invalid SSH alias');
    // Mixed case is stored canonical (lower-case).
    expect(await setInputValue(app, 'sshHostAliasInput', 'Box')).toBe(true);
    await shell.locator('#sshHostAddConfirm').click();
    await expect(shell.locator(`[data-host-id="${HOST}"]`)).toBeVisible();
    expect((await settingsOf(app)).hosts.ssh).toEqual([{ alias: 'box', enabled: true }]);

    await helperReady(app);
    // probe → deploy → helper launch, all BatchMode, all -T.
    const calls = sshCalls(sshLog);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.alias).toBe('box');
      expect(call.argv).toContain('-T');
      expect(call.tty).toBe(false);
    }
    expect(calls.some((c) => c.remote.includes('mkdir -p "$1"'))).toBe(true);
    expect(calls.some((c) => c.remote.includes('exit 86;'))).toBe(true);
    // Every invocation bounds the connect (fix round 1 #3).
    for (const call of calls) {
      expect(call.argv.slice(0, 10)).toEqual([
        '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      ]);
    }
    await expect(shell.locator(`[data-host-id="${HOST}"] [data-host-helper]`)).toHaveAttribute('data-host-helper', 'ready');

    // The remote transcript lists over the channel as an ssh-host row.
    await expect
      .poll(async () => (await claudeRows(app)).find((s) => s.id === STORE_ID)?.host, { timeout: 15_000 })
      .toBe(HOST);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    await expect(shell.locator(`[data-session-id="${STORE_ID}"] [data-host-chip]`)).toHaveText('box', {
      timeout: 10_000,
    });
    await expectAliasNeverLogged(logFile);
  } finally {
    await closeApp(app);
  }
});

test('claude chat on an ssh workspace spawns via ssh -T with the quoted cwd — no env values in argv', async () => {
  const { app, root, sshLog, logFile } = await launchSsh({
    AGENT_WORKSPACE_TEST_CLAUDE_SDK: FAKE_SDK,
    FAKE_CLAUDE_SPAWN: '1',
  });
  try {
    await addSsh(app, 'box');
    await helperReady(app);
    mkdirSync(join(root, 'home', 'u', 'my proj'), { recursive: true });
    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__agentworkspace.claudeNewSession(cwd),
      'ssh://Box/home/u/my proj',
    )) as string | null;
    expect(id).toBeTruthy();
    const chat = (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeChatState())) as {
      sessions: Record<string, { host: string; cwd: string }>;
    };
    expect(chat.sessions[id!]).toMatchObject({ host: HOST, cwd: '/home/u/my proj' });

    await app.evaluate(
      (_e, a: { id: string }) => (globalThis as any).__agentworkspace.claudePrompt(a.id, 'hello over ssh'),
      { id: id! },
    );
    await expect
      .poll(() => sshCalls(sshLog).find((c) => c.remote.includes('--fake-sdk-spawn')) ?? null, { timeout: 15_000 })
      .not.toBeNull();
    const spawned = sshCalls(sshLog).find((c) => c.remote.includes('--fake-sdk-spawn'))!;
    expect(spawned.argv).toContain('-T');
    expect(spawned.tty).toBe(false);
    expect(spawned.argv.slice(spawned.argv.indexOf('box'), spawned.argv.indexOf('box') + 2)).toEqual(['box', '--']);
    // /bin/sh → the login shell; cwd and argv are quoted words.
    expect(spawned.remote.startsWith(`exec '/bin/sh' '-c' `)).toBe(true);
    expect(spawned.remote).toContain(`'/home/u/my proj' '/bin/bash' '/home/u/.local/bin/claude' '--fake-sdk-spawn'`);
    // Fix round 1 #4: no env on the command line — neither the SDK's additions
    // nor the captured login env; they arrive on stdin (keys logged by the fake).
    for (const leaked of ['CLAUDE_CODE_ENTRYPOINT', 'sdk-ts', 'FAKE_WSL_HELPER', 'PATH=', 'HOME=']) {
      expect(spawned.argv.join(' ')).not.toContain(leaked);
    }
    await expect.poll(() => stagedEnvKeys(sshLog).some((keys) => keys.includes('CLAUDE_CODE_ENTRYPOINT'))).toBe(true);
    await expect
      .poll(async () =>
        ((await app.evaluate(() => (globalThis as any).__agentworkspace.claudeChatState())) as {
          sessions: Record<string, { running?: boolean }>;
        }).sessions[id!]?.running,
      )
      .toBeFalsy();
    await expectAliasNeverLogged(logFile);
  } finally {
    await app.evaluate((_e, v: string) => (globalThis as any).__agentworkspace.claudeCancel?.(v), '').catch(() => undefined);
    await closeApp(app);
  }
});

test('terminal uses ssh -t; the hook token is staged, never in argv', async () => {
  const { app, root } = await launchSsh({ AGENT_WORKSPACE_TEST_TERMINAL_CMD: FAKE_PTY });
  try {
    await expect.poll(() => hookInfo(app), { timeout: 15_000 }).not.toBeNull();
    const { token } = (await hookInfo(app))!;
    await addSsh(app, 'box');
    await helperReady(app);
    await expect.poll(() => forwardVerified(app), { timeout: 20_000 }).toBe(true);
    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__agentworkspace.claudeNewSession(cwd),
      'ssh://box/home/u/proj',
    )) as string | null;
    expect(id).toBeTruthy();
    const opened = (await app.evaluate(
      (_e, sessionId: string) => (globalThis as any).__agentworkspace.claudeTerminalOpen(sessionId),
      id!,
    )) as { ok: boolean; id?: string };
    expect(opened.ok).toBe(true);
    const read = () =>
      app.evaluate(
        (_e, tid: string) => (globalThis as any).__agentworkspace.terminalRead(tid),
        opened.id!,
      ) as Promise<string>;
    await expect.poll(read).toContain(
      '-o BatchMode=yes -o ServerAliveInterval=15 -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=none -t box --',
    );
    await expect.poll(read).toContain(`exec '/bin/sh' '-c' `);
    await expect.poll(read).toContain(`'/home/u/proj' '/bin/bash' '/home/u/.local/bin/claude'`);
    // Verified forward → hooks injected: the --settings flag names only the
    // env var; the token itself sits in a staged 0600 file whose path is the
    // one thing in argv.
    await expect.poll(read).toContain('--settings');
    const text = await read();
    expect(text).not.toContain(' -T ');
    expect(text).not.toContain(token);
    const staged = /'\/home\/u\/\.agent-workspace\/run\/([0-9a-f]{32})'/.exec(text);
    expect(staged).not.toBeNull();
    // The fake pty never runs the remote script, so the staged file is still there.
    const stagedFile = join(root, 'home', 'u', '.agent-workspace', 'run', staged![1]!);
    expect(readFileSync(stagedFile, 'utf8')).toContain(`export AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN='${token}'`);
    if (process.platform !== 'win32') expect(statSync(stagedFile).mode & 0o777).toBe(0o600);
  } finally {
    await closeApp(app);
  }
});

test('RemoteFolderInput autocompletes via the channel and returns ssh://box/<path>', async () => {
  const { app, root } = await launchSsh();
  for (const dir of ['alpha', 'apollo', 'beta', '.hidden']) {
    mkdirSync(join(root, 'home', 'u', 'projects', dir), { recursive: true });
  }
  writeFileSync(join(root, 'home', 'u', 'projects', 'afile.txt'), 'x');
  try {
    await addSsh(app, 'box');
    await helperReady(app);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    const shell = await shellPage(app);

    // The header menu offers "Add remote workspace…" once a remote host is enabled.
    void shell.evaluate(() => (window as any).agentworkspace.claudeContextMenu({ kind: 'header', x: 1, y: 1 }));
    await expect
      .poll(async () =>
        ((await app.evaluate(() => (globalThis as any).__agentworkspace.claudeMenuItems())) as { label: string }[]).map(
          (i) => i.label,
        ),
      )
      .toContain('Add remote workspace…');
    const items = (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeMenuItems())) as {
      id: string;
      label: string;
      enabled: boolean;
    }[];
    const item = items.find((i) => i.label === 'Add remote workspace…')!;
    expect(item.enabled).toBe(true);
    const clicked = (await app.evaluate(
      (_e, id: string) => (globalThis as any).__agentworkspace.claudeMenuClick(id),
      item.id,
    )) as { action: string };
    expect(clicked.action).toBe('add-remote');
    // What ClaudeSidebar does with that action.
    void shell.evaluate(() => (window as any).agentworkspace.claudeWorkspaceAdd(undefined, { remote: true }));

    await expect(shell.locator('#remoteFolderPrompt')).toBeVisible();
    await expect(shell.locator('#remoteFolderHost')).toHaveValue(HOST);
    await expect(shell.locator('#remoteFolderInput')).toHaveValue('/home/u/');
    // M6: a folder that is not there is refused with a message; the prompt stays.
    await shell.locator('#remoteFolderInput').fill('/home/u/projects/nope');
    await shell.locator('#remoteFolderConfirm').click();
    await expect(shell.locator('#remoteFolderPromptError')).toHaveText('That folder does not exist on the host');
    await shell.locator('#remoteFolderInput').fill('/home/u/projects/afile.txt');
    await shell.locator('#remoteFolderConfirm').click();
    await expect(shell.locator('#remoteFolderPromptError')).toHaveText('That path is not a folder');
    await shell.locator('#remoteFolderInput').fill('/home/u/projects/a');
    const options = shell.locator('[data-remote-folder-option]');
    await expect(options).toHaveCount(2);
    expect(await options.evaluateAll((els) => els.map((e) => e.getAttribute('data-remote-folder-option')))).toEqual([
      '/home/u/projects/alpha',
      '/home/u/projects/apollo',
    ]);
    await shell.locator('[data-remote-folder-option="/home/u/projects/alpha"]').dispatchEvent('mousedown');
    await expect(shell.locator('#remoteFolderInput')).toHaveValue('/home/u/projects/alpha/');
    await expect(shell.locator('#remoteFolderPreview')).toHaveText('ssh://box/home/u/projects/alpha');
    await shell.locator('#remoteFolderConfirm').click();
    await expect
      .poll(async () => (await settingsOf(app)).claude.workspaces)
      .toContain('ssh://box/home/u/projects/alpha');
    await expect(shell.locator('#remoteFolderPrompt')).toHaveCount(0);
    // No native dialog was ever opened.
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.lastOpenDialogOptions())).toBeNull();
    // A malformed ssh path is refused at the IPC boundary with a message.
    const bad = (await shell.evaluate(() =>
      (window as any).agentworkspace.claudeWorkspaceAdd('ssh:box/home/u'),
    )) as { ok: boolean; error?: string };
    expect(bad).toEqual({ ok: false, error: 'Invalid SSH path — use ssh://<alias>/<absolute path>' });
  } finally {
    await closeApp(app);
  }
});

test('WSL workspace add uses RemoteFolderInput — no native dialog', async () => {
  const wslRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-wslfs-'));
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  mkdirSync(join(wslRoot, 'home', 'u', 'ws'), { recursive: true });
  const { app } = await launchSsh({
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_ROOT: wslRoot,
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
  });
  try {
    await addSsh(app, 'box');
    await helperReady(app, 'wsl:Fake');
    await helperReady(app);
    const shell = await shellPage(app);
    await shell.evaluate(() => (window as any).agentworkspace.setSettings({ local: { defaultWslDistro: 'Fake' } }));
    await expect
      .poll(async () => (await settingsOf(app)).local.defaultWslDistro)
      .toBe('Fake');
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('local'));
    await shell.locator('#workspaceAdd').click();

    await expect(shell.locator('#remoteFolderPrompt')).toBeVisible();
    await expect(shell.locator('#remoteFolderHost')).toHaveValue('wsl:Fake');
    // Devin Local offers WSL distros only — never the ssh host.
    expect(
      await shell.locator('#remoteFolderHost option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)),
    ).toEqual(['wsl:Fake', 'local']);
    await shell.locator('#remoteFolderInput').fill('/home/u/w');
    await expect(shell.locator('[data-remote-folder-option="/home/u/ws"]')).toHaveCount(1);
    await shell.locator('#remoteFolderInput').press('Tab');
    await expect(shell.locator('#remoteFolderInput')).toHaveValue('/home/u/ws/');
    await shell.locator('#remoteFolderInput').press('Enter');
    await expect
      .poll(async () => (await settingsOf(app)).workspaces)
      .toContain(`${uncRoot}\\home\\u\\ws`);
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.lastOpenDialogOptions())).toBeNull();
    const prompt = (await app.evaluate(() => (globalThis as any).__agentworkspace.lastFolderPrompt())) as {
      hostId: string;
      start: string | null;
      hosts: string[];
    };
    expect(prompt).toMatchObject({ hostId: 'wsl:Fake', start: '/home/u', hosts: ['wsl:Fake'] });
    // Nothing touched the Windows-side UNC stand-in.
    expect(readdirSync(uncRoot)).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('R39 #4: with a default distro, "This PC (browse…)" in the prompt opens the native dialog (Claude: createDirectory)', async () => {
  const wslRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-wslfs-'));
  const uncRoot = mkdtempSync(join(tmpdir(), 'agent-workspace-unc-'));
  mkdirSync(join(wslRoot, 'home', 'u'), { recursive: true });
  const { app } = await launchSsh({
    FAKE_WSL_DISTROS: 'Fake:Running:default',
    FAKE_WSL_ROOT: wslRoot,
    AGENT_WORKSPACE_TEST_WSL_UNC_ROOT: uncRoot,
  });
  try {
    await addSsh(app, 'box');
    await helperReady(app, 'wsl:Fake');
    await helperReady(app);
    const shell = await shellPage(app);
    await shell.evaluate(() => (window as any).agentworkspace.setSettings({ claude: { defaultWslDistro: 'Fake' } }));
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    const added = shell.evaluate(() => (window as any).agentworkspace.claudeWorkspaceAdd());
    await expect(shell.locator('#remoteFolderPrompt')).toBeVisible();
    // Remote hosts first (the default distro selected), this PC last.
    await expect(shell.locator('#remoteFolderHost')).toHaveValue('wsl:Fake');
    expect(
      await shell.locator('#remoteFolderHost option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)),
    ).toEqual(['wsl:Fake', HOST, 'local']);
    await expect(shell.locator('#remoteFolderHost option[value="local"]')).toHaveText('This PC (browse…)');
    expect(await app.evaluate(() => (globalThis as any).__agentworkspace.lastOpenDialogOptions())).toBeNull();
    // The native dialog must not really open: cancel it from here on.
    await app.evaluate(() => {
      process.env.AGENT_WORKSPACE_TEST_PICKER_CANCEL = '1';
    });
    await shell.locator('#remoteFolderHost').selectOption('local');
    await expect(shell.locator('#remoteFolderPrompt')).toHaveCount(0);
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).__agentworkspace.lastOpenDialogOptions()))
      .toMatchObject({ title: 'Add Claude workspace folder', properties: ['openDirectory', 'createDirectory'] });
    expect(await added).toMatchObject({ ok: true });
  } finally {
    await closeApp(app);
  }
});

test('hooks reach the listener through -R', async () => {
  const { app, root, sshLog, logFile } = await launchSsh();
  try {
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).__agentworkspace.claudeHookInfo()), { timeout: 15_000 })
      .not.toBeNull();
    const { port, token } = (await app.evaluate(() => (globalThis as any).__agentworkspace.claudeHookInfo())) as {
      port: number;
      token: string;
    };
    const shell = await shellPage(app);
    // R40 e: the add must land (and persist) before the probe wait starts.
    expect(await addSsh(app, 'box')).toMatchObject({ ok: true });
    await expect.poll(async () => (await settingsOf(app)).hosts.ssh.map((h) => h.alias)).toContain('box');
    await helperReady(app);
    await shell.evaluate(() => (window as any).agentworkspace.setSettings({ claude: { hooksEnabled: true } }));

    // Fix round 1 #1: the forward is its own connection (ExitOnForwardFailure,
    // remote-loopback bind); the helper connection carries no -R. R39 #3: no
    // -N — the remote `cat` ends the forward when the app's stdin pipe closes.
    const launch = sshCalls(sshLog).find((c) => c.remote.includes('exit 86;'))!;
    expect(launch.reverse).toBeNull();
    await expect.poll(() => sshCalls(sshLog).find((c) => c.forward) ?? null).not.toBeNull();
    const forward = sshCalls(sshLog).find((c) => c.forward)!;
    expect(forward.reverse).toBe(`127.0.0.1:${port}:127.0.0.1:${port}`);
    expect(forward.argv).toEqual(expect.arrayContaining(['-o', 'ExitOnForwardFailure=yes', 'ControlMaster=no', 'ControlPath=none']));
    expect(forward.argv).not.toContain('-N');
    expect(forward.remote).toBe('exec cat >/dev/null');

    // R39 #1: even with the opt-in on, the global (literal-token) block is
    // never written to an ssh host's settings.json — the opt-in's apply pass
    // ran for the host (as a removal) and left no block behind.
    const settingsFile = join(root, 'home', 'u', '.claude', 'settings.json');
    const sshInstalls = async (enabled: boolean) =>
      (await readEvents(logFile)).filter(
        (e) =>
          e.event === 'claude-hooks-install' &&
          (e.detail as { host?: string }).host === `ssh:#${ALIAS_HASH}` &&
          (e.detail as { enabled?: boolean }).enabled === enabled,
      ).length;
    await expect.poll(() => sshInstalls(false), { timeout: 15_000 }).toBeGreaterThan(0);
    if (existsSync(settingsFile)) expect(readFileSync(settingsFile, 'utf8')).not.toContain('/agent-workspace/hook/');
    const stop = { url: `http://127.0.0.1:${port}/agent-workspace/hook/Stop`, headers: { Authorization: `Bearer ${token}` } };

    // The challenge (a remote curl of health?nonce= through the forward,
    // answered with HMAC(token, nonce)) verified the forward.
    await expect.poll(async () => (await hostRow(app))?.hooks, { timeout: 45_000 }).toBe('ok');
    expect(sshCalls(sshLog).some((c) => c.remote.startsWith(`exec 'curl'`) && c.remote.includes('health?nonce='))).toBe(true);
    expect(await forwardVerified(app)).toBe(true);

    // A hook posted to that URL (what the remote CLI does via -R) lands.
    const body = JSON.stringify({ session_id: STORE_ID, hook_event_name: 'Stop' });
    const status = await new Promise<number>((resolveStatus, reject) => {
      const req = request(
        stop.url,
        { method: 'POST', headers: { 'content-type': 'application/json', Authorization: stop.headers.Authorization } },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(200);
    await expect
      .poll(async () => (await readEvents(logFile)).some((e) => e.event === 'claude-hook' && (e.detail as { event?: string }).event === 'Stop'))
      .toBe(true);
    // Verified forward or not, the global block never went in.
    expect(await sshInstalls(true)).toBe(0);
    if (existsSync(settingsFile)) expect(readFileSync(settingsFile, 'utf8')).not.toContain('/agent-workspace/hook/');
    await expectAliasNeverLogged(logFile);
  } finally {
    await closeApp(app);
  }
});

test('R39 #1: a global hook block left on an ssh host by an earlier build is removed once the channel is ready', async () => {
  const { app, root } = await launchSsh();
  const claudeDir = join(root, 'home', 'u', '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsFile = join(claudeDir, 'settings.json');
  const foreign = { type: 'command', command: 'echo mine' };
  writeFileSync(
    settingsFile,
    JSON.stringify({
      model: 'keep-me',
      hooks: {
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:50123/agent-workspace/hook/Stop', headers: { Authorization: 'Bearer old' } }] }],
        UserPromptSubmit: [{ hooks: [foreign] }],
      },
    }),
  );
  try {
    const shell = await shellPage(app);
    await shell.evaluate(() => (window as any).agentworkspace.setSettings({ claude: { hooksEnabled: true } }));
    await addSsh(app, 'box');
    await helperReady(app);
    await expect
      .poll(() => readFileSync(settingsFile, 'utf8').includes('/agent-workspace/hook/'), { timeout: 20_000 })
      .toBe(false);
    const after = JSON.parse(readFileSync(settingsFile, 'utf8')) as { model: string; hooks: Record<string, unknown> };
    expect(after.model).toBe('keep-me');
    expect(after.hooks).toEqual({ UserPromptSubmit: [{ hooks: [foreign] }] });
    // R40 b: the removal pass never copies the token-bearing file into a backup.
    for (const name of readdirSync(claudeDir).filter((n) => n.includes('.bak'))) {
      const text = readFileSync(join(claudeDir, name), 'utf8');
      expect(text).not.toContain('/agent-workspace/hook/');
      expect(text).not.toContain('Bearer');
    }
    expect(existsSync(join(claudeDir, 'settings.json.agent-workspace.bak'))).toBe(false);
  } finally {
    await closeApp(app);
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('R39 #3: closing the hook forward stdin ends it; it never outlives a killed app', async () => {
  const { app, sshLog, logFile } = await launchSsh({ AGENT_WORKSPACE_TEST_SSH_FORWARD_BACKOFF_MS: '500' });
  let killed = false;
  try {
    await expect.poll(() => hookInfo(app), { timeout: 15_000 }).not.toBeNull();
    await addSsh(app, 'box');
    await helperReady(app);
    await expect.poll(() => forwardVerified(app), { timeout: 20_000 }).toBe(true);
    expect(logLines(sshLog).some((l) => l.forwardEnded === true)).toBe(false);
    // stdin EOF (what the app's death does to the pipe on any OS) → the remote
    // `cat` returns → the forward connection ends; the app sees it go down.
    expect(await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.hostSshForwardEndStdin(id), HOST)).toBe(true);
    await expect.poll(() => logLines(sshLog).some((l) => l.forwardEnded === true), { timeout: 15_000 }).toBe(true);
    await expect
      .poll(async () => (await readEvents(logFile)).some((e) => e.event === 'host-ssh-forward' && (e.detail as { state?: string }).state === 'down'))
      .toBe(true);
    // The restarted forward does not survive a hard kill of the app (no stopChannels).
    await expect.poll(() => forwardVerified(app), { timeout: 30_000 }).toBe(true);
    const forwards = sshCalls(sshLog).filter((c) => c.forward) as (SshCall & { pid: number })[];
    const live = forwards[forwards.length - 1]!;
    expect(alive(live.pid)).toBe(true);
    // A crash of the Electron main process itself (app.process() is a launcher
    // on Windows): no stopChannels, no child.kill() — only the OS closing pipes.
    const mainPid = (await app.evaluate(() => process.pid)) as number;
    process.kill(mainPid, 'SIGKILL');
    app.process().kill();
    killed = true;
    await expect.poll(() => alive(live.pid), { timeout: 15_000 }).toBe(false);
  } finally {
    if (!killed) await closeApp(app);
  }
});

test('R39 #11: removing an ssh host drops its overrides; ssh rows have no devin path override', async () => {
  const { app } = await launchSsh();
  type WithOverrides = { hosts: { overrides: Record<string, unknown> } };
  const overrides = async () => ((await state(app)).settings as unknown as WithOverrides).hosts.overrides;
  try {
    await addSsh(app, 'box');
    const shell = await shellPage(app);
    await shell.evaluate(() =>
      (window as any).agentworkspace.commitSettings({ hosts: { overrides: { 'ssh:box': { shell: '/bin/zsh' } } } }),
    );
    await expect.poll(async () => Object.keys(await overrides())).toContain(HOST);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('settings'));
    await evaluateInShell(app, `document.querySelector('[data-settings-tab="general"]').click()`);
    await shell.locator(`[data-host-id="${HOST}"] [data-host-overrides-toggle]`).click();
    await expect(shell.locator(`[data-host-id="${HOST}"] [data-host-override="shell"]`)).toBeVisible();
    await expect(shell.locator(`[data-host-id="${HOST}"] [data-host-override="devinPath"]`)).toHaveCount(0);
    await shell.locator(`[data-host-id="${HOST}"] [data-host-remove]`).click();
    await expect.poll(async () => Object.keys(await overrides())).not.toContain(HOST);
  } finally {
    await closeApp(app);
  }
});

test('R39 #12: an open remote folder prompt is closed (null) when the shell reloads', async () => {
  const { app } = await launchSsh();
  try {
    await addSsh(app, 'box');
    await helperReady(app);
    await app.evaluate(() => (globalThis as any).__agentworkspace.setSurface('claude'));
    const shell = await shellPage(app);
    void shell.evaluate(() => (window as any).agentworkspace.claudeWorkspaceAdd(undefined, { remote: true })).catch(() => undefined);
    await expect(shell.locator('#remoteFolderPrompt')).toBeVisible();
    await app.evaluate(() => (globalThis as any).__agentworkspace.getShellWebContents().reload());
    await expect
      .poll(async () => ((await state(app)) as unknown as { folderPrompt: unknown }).folderPrompt ?? null, { timeout: 15_000 })
      .toBeNull();
    await expect(shell.locator('#remoteFolderPrompt')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('a squatted hook port (forward fails closed) → no hook injection in an ssh pty, hooks unreachable, no hooks block', async () => {
  const { app, root, sshLog } = await launchSsh({
    AGENT_WORKSPACE_TEST_TERMINAL_CMD: FAKE_PTY,
    FAKE_SSH_FORWARD_FAIL: '1',
    AGENT_WORKSPACE_TEST_SSH_FORWARD_BACKOFF_MS: '60000',
  });
  try {
    await expect.poll(() => hookInfo(app), { timeout: 15_000 }).not.toBeNull();
    const shell = await shellPage(app);
    await shell.evaluate(() => (window as any).agentworkspace.setSettings({ claude: { hooksEnabled: true, defaultPermissionMode: 'plan' } }));
    await addSsh(app, 'box');
    await helperReady(app);
    await expect.poll(() => sshCalls(sshLog).some((c) => c.forward), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await hostRow(app))?.hooks, { timeout: 15_000 }).toBe('unreachable');
    expect(await forwardVerified(app)).toBe(false);
    const errors = ((await state(app)) as unknown as { claude: { hostErrors: Record<string, string> } }).claude.hostErrors;
    expect(errors[HOST]).toContain('Hooks unavailable');
    // The remote settings.json never got our block.
    const settingsFile = join(root, 'home', 'u', '.claude', 'settings.json');
    if (existsSync(settingsFile)) expect(readFileSync(settingsFile, 'utf8')).not.toContain('/agent-workspace/hook/');
    const id = (await app.evaluate(
      (_e, cwd: string) => (globalThis as any).__agentworkspace.claudeNewSession(cwd),
      'ssh://box/home/u/proj',
    )) as string;
    const opened = (await app.evaluate(
      (_e, sessionId: string) => (globalThis as any).__agentworkspace.claudeTerminalOpen(sessionId),
      id,
    )) as { ok: boolean; id?: string };
    expect(opened.ok).toBe(true);
    const read = () =>
      app.evaluate((_e, tid: string) => (globalThis as any).__agentworkspace.terminalRead(tid), opened.id!) as Promise<string>;
    await expect.poll(read).toContain(`'/home/u/.local/bin/claude'`);
    const text = await read();
    expect(text).not.toContain('--settings');
    expect(text).not.toContain('.agent-workspace/run/');
    // R40 M1: the configured permission mode survives an unverified forward.
    expect(text).toContain(`'--permission-mode' 'plan'`);
  } finally {
    await closeApp(app);
  }
});

test('an ssh host whose connection failed recovers on resume once the network is back', async () => {
  const failFile = join(mkdtempSync(join(tmpdir(), 'agent-workspace-ssh-fail-')), 'down');
  writeFileSync(failFile, '');
  const { app, logFile } = await launchSsh({ FAKE_SSH_FAIL_FILE: failFile });
  try {
    await addSsh(app, 'box');
    await expect.poll(async () => (await hostRow(app))?.state, { timeout: 30_000 }).toBe('error');
    expect((await hostRow(app))?.error).toContain('exit 255');
    rmSync(failFile);
    await app.evaluate(() => (globalThis as any).__agentworkspace.hostSshRecover('resume'));
    await helperReady(app);
    const recovered = (await readEvents(logFile)).filter((e) => e.event === 'host-ssh-recover');
    expect(recovered.map((e) => e.detail)).toContainEqual({ trigger: 'resume', count: 1 });
  } finally {
    await closeApp(app);
  }
});

test('R36 #2: execOn over ssh returns the whole stdout (resolved on close, not exit)', async () => {
  const { app } = await launchSsh();
  try {
    await addSsh(app, 'box');
    await helperReady(app);
    for (let i = 0; i < 3; i++) {
      const out = (await app.evaluate(
        (_e, a: { id: string }) =>
          (globalThis as any).__agentworkspace.hostExecOn(a.id, 'node', ['-e', 'process.stdout.write("x".repeat(400000))']),
        { id: HOST },
      )) as string;
      expect(out.length).toBe(400000);
    }
  } finally {
    await closeApp(app);
  }
});
