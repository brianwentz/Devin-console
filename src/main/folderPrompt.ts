// In-app folder prompt for remote hosts (P3, RemoteFolderInput): the native
// Windows folder dialog stays for local folders only — a WSL or SSH folder is
// typed with directory autocomplete over the host's helper channel
// (`hosts:readdir` → helper `fs.readdir`), so no folder pick ever browses
// `\\wsl.localhost` from Windows. Main awaits the shell's answer the same way
// it awaits the native dialog; the shell is raised over the hosted views while
// the prompt is open.

import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { isRemoteHost, type ExecHost } from '../core/execHost';
import type { HostReaddirResult, ShellState } from '../shared/ipc';
import { pickerStartPath } from '../core/pickerFolder';
import { openFolderDialog } from './dialogs';
import { hosts } from './hosts';
import { state, testMode } from './state';
import { applyLayout, lowerShell, overlayOpen, raiseShell } from './window';

type PromptHost = NonNullable<ShellState['folderPrompt']>['hosts'][number];

interface OpenPrompt {
  id: string;
  title: string;
  hostId: string;
  start: string | null;
  hosts: PromptHost[];
  resolve: (path: string | null) => void;
}

let open: OpenPrompt | null = null;
let lastPrompt: { title: string; hostId: string; start: string | null; hosts: string[] } | null = null;

export function folderPromptOpen(): boolean {
  return open !== null;
}

/** ShellState.folderPrompt. */
export function folderPromptPublic(): ShellState['folderPrompt'] {
  return open
    ? { id: open.id, title: open.title, hostId: open.hostId, start: open.start, hosts: open.hosts }
    : null;
}

/** Test hook: the most recent remote prompt (ids / host paths only). */
export function lastFolderPrompt(): typeof lastPrompt {
  return lastPrompt;
}

const label = (host: ExecHost): string =>
  host.kind === 'wsl' ? host.distro : host.kind === 'ssh' ? host.alias : 'This PC';

/** Remote hosts a surface may pick folders on: every enabled WSL distro and,
 * for Claude, every enabled SSH host (Devin Local runs on this PC and WSL). */
export function remoteFolderHosts(surface: 'local' | 'claude'): PromptHost[] {
  return hosts()
    .list()
    .filter(isRemoteHost)
    .filter((host) => surface === 'claude' || host.kind === 'wsl')
    .map((host) => {
      const current = hosts().hostById(host.id) ?? host;
      const home = current.kind === 'local' ? null : current.home;
      return { id: host.id, label: label(host), home: home && home.startsWith('/') ? home : null };
    });
}

function close(path: string | null): void {
  const current = open;
  if (!current) return;
  open = null;
  if (!overlayOpen()) lowerShell();
  applyLayout();
  current.resolve(path);
}

/**
 * Opens the in-app prompt on `hostId` (one of `choices`) starting in `start`
 * (a host-side path) and resolves with the picked folder in its stored
 * Windows-side form (`\\wsl.localhost\D\…`, `ssh://<alias>/…`), or null on
 * cancel. A newer prompt cancels an open one.
 */
export function promptRemoteFolder(
  title: string,
  hostId: string,
  start: string | null,
  choices: PromptHost[],
): Promise<string | null> {
  if (testMode) lastPrompt = { title, hostId, start, hosts: choices.map((h) => h.id) };
  if (testMode && process.env.AGENT_WORKSPACE_TEST_PICKER_CANCEL === '1') return Promise.resolve(null);
  close(null);
  return new Promise((resolve) => {
    open = { id: randomUUID(), title, hostId, start, hosts: choices, resolve };
    raiseShell();
    applyLayout();
  });
}

/** hosts:folderPromptResolve — validated: the prompt id, an offered host, an absolute posix path. */
export function resolveFolderPrompt(arg: { id: string; hostId?: string | undefined; path: string | null }): void {
  const current = open;
  if (!current || arg.id !== current.id) return;
  if (arg.path === null) {
    close(null);
    return;
  }
  const choice = current.hosts.find((h) => h.id === (arg.hostId ?? current.hostId));
  const host = choice ? hosts().hostById(choice.id) : null;
  if (!host || host.kind === 'local' || arg.path.includes('\0') || arg.path.includes('\\')) {
    close(null);
    return;
  }
  const normalized = posix.normalize(arg.path).replace(/(.)\/+$/, '$1');
  close(hosts().windowsPath(host, normalized));
}

/**
 * Folder pick for a workspace / new session. The target host is the surface's
 * default WSL distro, else the host of a configured picker folder on a remote
 * host, else (for `remote`, the header's "Add remote workspace…") the first
 * remote host; otherwise this PC. A remote target opens the in-app prompt,
 * starting in the configured picker folder when it is on that host and exists
 * (the helper's `fs.stat`), else the host's home; this PC opens the native
 * dialog, which never starts on a remote path. `onMissing` fires when the
 * configured folder is on the target host but gone (it is never cleared).
 */
export async function pickFolder(opts: {
  surface: 'local' | 'claude';
  title: string;
  defaultDistro: string | null | undefined;
  remote?: boolean;
  pickerFolder: string | null | undefined;
  onMissing: () => void;
  native: (defaultPath: string | undefined) => Electron.OpenDialogOptions;
}): Promise<string | null> {
  const choices = remoteFolderHosts(opts.surface);
  const configured = opts.pickerFolder?.trim() || null;
  const configuredHost = configured ? hosts().pathHostId(configured) : null;
  const byId = (id: string | null): PromptHost | undefined => (id ? choices.find((h) => h.id === id) : undefined);
  const target =
    byId(opts.defaultDistro ? `wsl:${opts.defaultDistro}` : null) ??
    byId(configuredHost !== 'local' ? configuredHost : null) ??
    (opts.remote ? choices[0] : undefined);
  if (opts.remote && !target) {
    throw new Error('No WSL distro or SSH host is enabled — add one in Settings → General → Hosts');
  }
  const exists = (path: string): Promise<boolean> => hosts().pathExists(path);
  if (target) {
    const host = hosts().hostById(target.id);
    if (!host || host.kind === 'local') return null;
    // ux3 S3 precedence on the target host: the configured folder when it is
    // there and exists, else the probed home (never checked).
    const home = target.home ? hosts().windowsPath(host, target.home) : undefined;
    const startWin = await pickerStartPath(
      configuredHost === target.id ? configured : null,
      home,
      exists,
      opts.onMissing,
    );
    const start = startWin ? hosts().hostPath(host, startWin) : target.home;
    return promptRemoteFolder(opts.title, target.id, start, choices);
  }
  const win = state.windowRef;
  if (!win) return null;
  const defaultPath = await pickerStartPath(
    configuredHost === 'local' ? configured : null,
    undefined,
    exists,
    opts.onMissing,
  );
  const result = await openFolderDialog(win, opts.native(defaultPath));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** hosts:readdir — directories under a host-side path over the helper channel. */
export async function readRemoteDir(hostId: string, path: string): Promise<HostReaddirResult> {
  const host = hosts().hostById(hostId);
  if (!host || host.kind === 'local') throw new Error('not a remote host');
  const channel = hosts().fsReady(host) ? hosts().channel(host) : null;
  if (!channel) throw new Error('host helper is not ready');
  const res = await channel.request<{ entries?: unknown; truncated?: unknown } | null>('fs.readdir', { path });
  const entries: unknown[] = Array.isArray(res?.entries) ? res.entries : [];
  const names = entries
    .map((e) => (typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.length > 0 && !/[/\0]/.test(name));
  return { entries: names.map((name) => ({ name, dir: true })), truncated: res?.truncated === true };
}
