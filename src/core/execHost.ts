// Execution hosts (pure): a host is where a CLI session actually runs —
// 'local' is this Windows machine, 'wsl:<distro>' is a WSL distribution
// reached through wsl.exe. No node/electron imports; path strings are
// manipulated by hand so behaviour is identical on every platform.

import type { HostStatus } from '../shared/ipc';

export type HostId = 'local' | `wsl:${string}` | `ssh:${string}`;

export type ExecHost =
  | { id: 'local'; kind: 'local' }
  | {
      id: HostId;
      kind: 'wsl';
      distro: string;
      home: string | null;
      /** Automount root for drive paths, '/mnt' unless wsl.conf says otherwise. */
      mount: string;
    }
  | {
      id: HostId;
      kind: 'ssh';
      /** A Host alias from the user's ~/.ssh/config (validated by SSH_ALIAS_RE). */
      alias: string;
      home: string | null;
    };

export const LOCAL_HOST: ExecHost = { id: 'local', kind: 'local' };

export function isWslHost(host: ExecHost): host is Extract<ExecHost, { kind: 'wsl' }> {
  return host.kind === 'wsl';
}

/** Whether a host's config dir may be touched from the main process: local always; a wsl host only once its probe is `ready` (an unresponsive distro makes every UNC call block the loop for the SMB timeout). */
export function isFsReady(host: ExecHost, state: string | null | undefined): boolean {
  return host.kind === 'local' || state === 'ready';
}

/** An ssh alias: no leading '-' (would be parsed as an ssh option), no shell/URL metacharacters. */
export const SSH_ALIAS_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** The stored/keyed form: SSH_ALIAS_RE lower-cased (OpenSSH matches `Host`
 * patterns case-insensitively, so `Box` and `box` are one host). */
export const SSH_ALIAS_CANONICAL_RE = /^[a-z0-9._][a-z0-9._-]*$/;

/** User input → canonical alias (trimmed, lower-cased); null when invalid. */
export function canonicalSshAlias(input: string): string | null {
  const alias = input.trim().toLowerCase();
  return alias.length > 0 && alias.length <= 128 && SSH_ALIAS_RE.test(alias) ? alias : null;
}

/** Aliases that would read as another host kind (`ssh:ssh`, `ssh:local`,
 * `ssh:wsl`) and collide with the log scrub's host-id words. Refused when a
 * host or ssh:// workspace is added; an existing entry is invalid in memory
 * (kept raw in settings.json, ux3 S6). */
const RESERVED_SSH_ALIASES: ReadonlySet<string> = new Set(['ssh', 'local', 'wsl']);

export const RESERVED_SSH_ALIAS_MESSAGE = '"ssh", "local" and "wsl" are reserved — give the host a different alias in ~/.ssh/config';

export const INVALID_SSH_ALIAS_MESSAGE =
  'Invalid SSH alias — use a Host name from ~/.ssh/config (letters, digits, ".", "_", "-"; not starting with "-")';

/** Case-insensitive, after trimming. */
export function isReservedSshAlias(alias: string): boolean {
  return RESERVED_SSH_ALIASES.has(alias.trim().toLowerCase());
}

/** hosts:sshAdd input → canonical alias, or the user-facing reason it is refused. */
export function validateSshAliasInput(input: string): { ok: true; alias: string } | { ok: false; error: string } {
  const alias = canonicalSshAlias(input);
  if (!alias) return { ok: false, error: INVALID_SSH_ALIAS_MESSAGE };
  if (isReservedSshAlias(alias)) return { ok: false, error: RESERVED_SSH_ALIAS_MESSAGE };
  return { ok: true, alias };
}

export function isSshHost(host: ExecHost): host is Extract<ExecHost, { kind: 'ssh' }> {
  return host.kind === 'ssh';
}

export function isValidSshAlias(alias: string): boolean {
  return SSH_ALIAS_RE.test(alias);
}

/** Builds the ssh host for an alias, keyed by its canonical (lower-case) form. */
export function sshHost(alias: string, home: string | null = null): ExecHost {
  if (!isValidSshAlias(alias)) throw new Error('invalid ssh alias');
  const canonical = alias.toLowerCase();
  return { id: `ssh:${canonical}`, kind: 'ssh', alias: canonical, home };
}

/** `ssh://<alias>/<abs>` (scheme and alias case-insensitive; the alias is
 * returned canonical, lower-case) → alias + posix path; null when not that
 * form, the alias is invalid or the path carries a backslash. */
export function parseSshUri(p: string): { alias: string; path: string } | null {
  const m = /^ssh:\/\/([^/]*)(\/.*)?$/i.exec(p);
  if (!m || !m[1] || !isValidSshAlias(m[1])) return null;
  const path = m[2] ?? '/';
  if (path.includes('\\') || path.includes('\0')) return null;
  return { alias: m[1].toLowerCase(), path };
}

/** Anything that claims to be an ssh path (`ssh:` scheme, any case) — the
 * input boundary rejects it explicitly when normalizeSshPath returns null. */
export function isSshPathLike(p: string): boolean {
  return /^ssh:/i.test(p.trim());
}

/** Canonical stored form `ssh://<alias>/<abs>` (lower-case alias, collapsed
 * slashes, no trailing slash); null for a malformed ssh path. */
export function normalizeSshPath(p: string): string | null {
  const parsed = parseSshUri(p.trim());
  if (!parsed) return null;
  return `ssh://${parsed.alias}${stripTrailing(collapseSlashes(parsed.path))}`;
}

export const INVALID_SSH_PATH_MESSAGE = 'Invalid SSH path — use ssh://<alias>/<absolute path>';

/** Workspace/cwd key at the input boundary: an ssh path is canonicalised (a
 * malformed one throws INVALID_SSH_PATH_MESSAGE — never `resolve()`d into a
 * Windows path), anything else goes through `resolveLocal`. A reserved alias
 * throws RESERVED_SSH_ALIAS_MESSAGE unless `existing` (rename/remove of an
 * entry that is already stored). */
export function normalizeWorkspacePath(
  p: string,
  resolveLocal: (p: string) => string,
  opts: { existing?: boolean } = {},
): string {
  if (!isSshPathLike(p)) return resolveLocal(p);
  const parsed = parseSshUri(p.trim());
  if (!parsed) throw new Error(INVALID_SSH_PATH_MESSAGE);
  if (!opts.existing && isReservedSshAlias(parsed.alias)) throw new Error(RESERVED_SSH_ALIAS_MESSAGE);
  return normalizeSshPath(p)!;
}

/** A host that is reached over the helper channel (WSL or SSH). */
export function isRemoteHost(host: ExecHost): host is Exclude<ExecHost, { kind: 'local' }> {
  return host.kind !== 'local';
}

export function wslHost(distro: string, home: string | null, mount = '/mnt'): ExecHost {
  return { id: `wsl:${distro}`, kind: 'wsl', distro, home, mount };
}

/** The local host's Claude home: `CLAUDE_CONFIG_DIR` (trimmed, non-empty) else
 * `<home>/.claude`. Pure so the registry can capture it once at startup
 * (`hosts().localConfigDir()`); app code never reads the env var live. */
export function resolveLocalConfigDir(
  env: { CLAUDE_CONFIG_DIR?: string | undefined },
  home: string,
  joinPath: (...parts: string[]) => string,
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured || joinPath(home, '.claude');
}

export interface HostCommand {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

// A returned `cwd: null` means "let the platform pick" — wsl.exe rejects a UNC
// process cwd, so callers use the Windows home directory there.
export interface HostSpawnSpec {
  file: string;
  args: string[];
  cwd: string | null;
}

const WSL_UNC_SERVERS = ['wsl.localhost', 'wsl$'];

/** Extended-length `\\?\UNC\server\share` → `\\server\share`. */
const plainUnc = (p: string): string => p.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\');

// '\\\\wsl.localhost\<distro>\…', '\\wsl$\<distro>\…', the forward-slash
// spellings '//wsl.localhost/<d>/…' and the `\\?\UNC\` extended-length forms.
// Server part is case-insensitive.
export function hostIdForPath(rawPath: string): HostId {
  const ssh = parseSshUri(rawPath);
  if (ssh) return `ssh:${ssh.alias}`;
  const p = plainUnc(rawPath);
  const m = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(p);
  if (m && m[1] && m[2] && WSL_UNC_SERVERS.includes(m[1].toLowerCase())) {
    return `wsl:${m[2]}`;
  }
  return 'local';
}

const collapseSlashes = (s: string): string => s.replace(/\/+/g, '/');
const stripTrailing = (s: string): string => (s.length > 1 ? s.replace(/\/+$/g, '') : s);

/** Windows-side path → the path as the host sees it. */
export function toHostPath(host: ExecHost, winPath: string): string {
  if (host.kind === 'local') return winPath;
  if (host.kind === 'ssh') {
    const ssh = parseSshUri(winPath);
    return ssh && ssh.alias === host.alias ? stripTrailing(collapseSlashes(ssh.path)) : winPath;
  }
  const norm = plainUnc(winPath).replace(/\\/g, '/');
  const unc = /^\/{2}([^/]+)\/([^/]+)(\/.*)?$/.exec(norm);
  if (unc && unc[1] && unc[2] && WSL_UNC_SERVERS.includes(unc[1].toLowerCase()) && unc[2] === host.distro) {
    const rest = unc[3] ?? '/';
    return stripTrailing(collapseSlashes(rest));
  }
  // Drive path → <mount>/<lower-letter>/rest.
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(norm);
  if (drive && drive[1]) {
    const rest = drive[2] ?? '/';
    return stripTrailing(collapseSlashes(`${host.mount}/${drive[1].toLowerCase()}${rest}`));
  }
  // Already POSIX — handed through unchanged.
  return winPath;
}

/** Host-side path → the Windows-side form. */
export function toWindowsPath(host: ExecHost, hostPath: string): string {
  if (host.kind === 'local') return hostPath;
  if (host.kind === 'ssh') return `ssh://${host.alias}${hostPath.startsWith('/') ? '' : '/'}${hostPath}`;
  const norm = hostPath.replace(/\\/g, '/');
  // <mount>/<drive>/<rest> → 'X:\rest'
  const mount = host.mount.endsWith('/') ? host.mount.slice(0, -1) : host.mount;
  if (norm.startsWith(`${mount}/`)) {
    const rest = norm.slice(mount.length + 1);
    const m = /^([A-Za-z])(\/.*)?$/.exec(rest);
    if (m && m[1]) {
      const tail = (m[2] ?? '').replace(/\//g, '\\');
      return `${m[1].toUpperCase()}:${tail || '\\'}`;
    }
  }
  return `\\\\wsl.localhost\\${host.distro}${norm.replace(/\//g, '\\')}`;
}

/** How the shell displays a host path; host chip only when several hosts exist. */
/** Sidebar label for a stored workspace path: UNC paths get
 * `<distro> · <linux>` form when a host map is given, else the stored string. */
export function workspaceLabel(path: string): string {
  const id = hostIdForPath(path);
  if (id === 'local') return path;
  const host = id.startsWith('ssh:') ? sshHost(id.slice(4)) : wslHost(id.slice(4), null);
  return displayPath(host, toHostPath(host, path), true);
}

export function displayPath(host: ExecHost, hostPath: string, multiHost: boolean): string {
  if (!multiHost) return hostPath;
  if (isWslHost(host)) return `${host.distro} · ${hostPath}`;
  if (isSshHost(host)) return `${host.alias} · ${hostPath}`;
  return hostPath;
}

/** Per-invocation variables WSL itself provides — they must be the ones of the
 * child's own wsl.exe call, never replayed from a captured environment. */
export const WSL_ENV_DENYLIST: ReadonlySet<string> = new Set([
  'WSL_INTEROP',
  'WSLENV',
  'WSL_DISTRO_NAME',
  'WSL2_GUI_APPS_ENABLED',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'PULSE_SERVER',
  'XDG_RUNTIME_DIR',
  'HOSTTYPE',
  'NAME',
]);

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// `printf "\0<marker>\0"; env -0` output → env map, or null when the marker is
// absent (broken rc file, command not found). Anything before the marker is
// rc chatter and ignored; entries without '=' or with invalid keys are dropped.
export function parseShellEnv(
  stdout: Uint8Array | string,
  marker: string,
): Record<string, string> | null {
  const text = typeof stdout === 'string' ? stdout : new TextDecoder('utf-8').decode(stdout);
  const sep = `\0${marker}\0`;
  const at = text.indexOf(sep);
  if (at === -1) return null;
  const body = text.slice(at + sep.length);
  const env: Record<string, string> = {};
  for (const entry of body.split('\0')) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const key = entry.slice(0, eq);
    if (!ENV_KEY.test(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return env;
}

/** Captured environment minus WSL-provided vars, with `extra` overlaid
 * (extra wins and is never dropped — hook tokens, CLAUDE_CODE_* vars). */
export function mergeShellEnv(
  captured: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(captured)) {
    if (!WSL_ENV_DENYLIST.has(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value;
  }
  return out;
}

/** The helper's `env.get` result → a spawnable env: string values under valid
 * keys only, minus WSL_ENV_DENYLIST. */
export function sanitizeEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && ENV_KEY.test(key)) env[key] = value;
  }
  return mergeShellEnv(env, {});
}

const kvPairs = (env: Record<string, string>): string[] =>
  Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`);

/**
 * spawn() spec for a piped child (SDK stream, ACP, gh, probes). `shellEnv` is
 * the §1.4 `-ilc` capture; null means "not captured yet" — only `cmd.env` is
 * sent. For wsl the returned cwd is null (callers substitute a Windows dir;
 * wsl.exe rejects UNC process cwds).
 */
export function spawnSpec(
  host: ExecHost,
  cmd: HostCommand,
  shellEnv: Record<string, string> | null,
): HostSpawnSpec {
  if (host.kind === 'local') {
    return { file: cmd.file, args: cmd.args, cwd: cmd.cwd };
  }
  if (host.kind === 'ssh') throw new Error('spawnSpec: use sshSpawnSpec for ssh hosts');
  const env = mergeShellEnv(shellEnv ?? {}, cmd.env ?? {});
  return {
    file: 'wsl.exe',
    args: [
      '-d',
      host.distro,
      '--cd',
      cmd.cwd,
      '-e',
      '/usr/bin/env',
      ...kvPairs(env),
      cmd.file,
      ...cmd.args,
    ],
    cwd: null,
  };
}

// Posix-shell invocation style for `-c 'exec …' <argv0> <args…>`: bash/zsh/sh
// accept `exec "$0" "$@"` ($0 is the first positional after the command
// string); fish's positional list is $argv.
export function shellFamily(shell: string | null): 'fish' | 'posix' {
  const base = (shell ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  return base === 'fish' ? 'fish' : 'posix';
}

/**
 * node-pty spec: an interactive login shell `exec`ing the CLI — exactly what
 * the user gets in Windows Terminal. Only `cmd.env` is sent through
 * `/usr/bin/env` (the interactive shell provides the environment).
 */
export function ptySpec(
  host: ExecHost,
  cmd: HostCommand,
  shell: string | null,
): HostSpawnSpec {
  if (host.kind === 'local') {
    return { file: cmd.file, args: cmd.args, cwd: cmd.cwd };
  }
  if (host.kind === 'ssh') throw new Error('ptySpec: use sshPtySpec for ssh hosts');
  const env = mergeShellEnv({}, cmd.env ?? {});
  const family = shellFamily(shell);
  return {
    file: 'wsl.exe',
    args: [
      '-d',
      host.distro,
      '--cd',
      cmd.cwd,
      '-e',
      shell ?? '/bin/bash',
      '-ilc',
      family === 'fish' ? 'exec $argv' : 'exec "$0" "$@"',
      '/usr/bin/env',
      ...kvPairs(env),
      cmd.file,
      ...cmd.args,
    ],
    cwd: null,
  };
}

export interface WslDistroRow {
  name: string;
  state: 'Running' | 'Stopped';
  default: boolean;
}

// `wsl.exe -l -v` output (already text-decoded). Rows: `* Name    Running   2`.
// Rows whose state is neither Running nor Stopped are ignored.
export function parseWslList(text: string): WslDistroRow[] {
  const out: WslDistroRow[] = [];
  const lines = text.replace(/\0/g, '').replace(/\r/g, '').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const isHeader = /^NAME\s/i.test(line);
    if (i === 0 && isHeader) continue;
    const isDefault = line.startsWith('*');
    // Columns are separated by runs of spaces; distro names may contain one.
    const cols = (isDefault ? line.slice(1) : line).trim().split(/\s{2,}/);
    const name = cols[0];
    const state = cols[1];
    if (!name) continue;
    if (state === 'Running' || state === 'Stopped') {
      out.push({ name, state, default: isDefault });
    }
  }
  return out;
}

const SEMVER_LINE = /^\d+\.\d+\.\d+/;

/** Second marker the env-capture command prints after `env -0`, followed by the node version or `NONODE`. */
export const NODE_MARKER = '__DW_NODE__';

/** Token the probe line prints when the helper bundle is already deployed. */
export const HELPER_PRESENT = 'HELPER_PRESENT';

/** Exit code of the helper launch line when the bundle file is missing (→ redeploy). */
export const HELPER_MISSING_EXIT = 86;

export const HELPER_DIR = '.agent-workspace';

const HELPER_HASH_RE = /^[0-9a-f]{12}$/;

/** `helper-hash.json` → the 12-hex bundle hash; null when absent or malformed. */
export function parseHelperHash(json: string | null): string | null {
  if (!json) return null;
  try {
    const hash = (JSON.parse(json) as { hash?: unknown } | null)?.hash;
    return typeof hash === 'string' && HELPER_HASH_RE.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

export function helperFileName(hash: string): string {
  return `helper-${hash}.mjs`;
}

/** Absolute helper path under the probed home — neither `wsl.exe -e` nor `"$0"` expands `~`. */
export function helperPath(home: string, hash: string): string {
  return `${home.replace(/\/+$/, '')}/${HELPER_DIR}/${helperFileName(hash)}`;
}

/** POSIX single-quoting: the string stays one shell word, no expansion. */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The existing probe line (home / user / login shell) plus, when a bundle
 * exists, the presence check — no extra spawn. `home` is the resolved home
 * (a `hosts.overrides[id].home`) when known before the probe; deploy and launch
 * build their paths from the same value, so all three agree. Null = `$HOME`.
 */
export function probeLine(hash: string | null, home: string | null = null): string {
  const base = 'echo "$HOME"; id -un; getent passwd "$(id -un)" | cut -d: -f7';
  if (hash === null) return base;
  const file = home ? posixQuote(helperPath(home, hash)) : `"$HOME/${HELPER_DIR}/${helperFileName(hash)}"`;
  return `${base}; if test -f ${file}; then echo ${HELPER_PRESENT}; fi`;
}

/** Probe line output: `$HOME`, user, login shell. The presence token is not a shell. */
export function parseProbeOutput(out: string): { home: string | undefined; shell: string | undefined } {
  const lines = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== HELPER_PRESENT);
  return { home: lines[0] || undefined, shell: lines[2] || undefined };
}

export function parseHelperPresent(out: string): boolean {
  return out.split('\n').some((l) => l.trim() === HELPER_PRESENT);
}

export type HelperState = NonNullable<HostStatus['helper']>['state'];

/**
 * Initial helper state after the probe. `envOk` = the interactive-login env
 * capture succeeded; with it failed/disabled the node version is unknown and
 * the host stays eligible (a failed channel start surfaces the problem).
 */
export function deriveHelperState(input: {
  envOk: boolean;
  node: string | null;
  present: boolean;
}): HelperState {
  if (input.envOk) {
    if (input.node === null) return 'node-missing';
    const major = Number(input.node.split('.')[0]);
    if (Number.isFinite(major) && major < 18) return 'unsupported-node';
  }
  return input.present ? 'starting' : 'absent';
}

/**
 * Helper launch: interactive login shell (full PATH/nvm/SSH_AUTH_SOCK) running
 * the deployed bundle on stdio. `$0` (fish: `$argv[1]`) is the bundle path, so
 * paths with spaces stay one argv element. Exit 86 = bundle missing.
 * `--apply-hooks-off` is the one-shot opt-out run (no stdio protocol).
 */
export type HelperMode = '--stdio' | '--apply-hooks-off';

function helperLaunchLine(shell: string, mode: HelperMode): string {
  return shellFamily(shell) === 'fish'
    ? `test -f $argv[1]; or exit ${HELPER_MISSING_EXIT}; exec node $argv ${mode}`
    : `test -f "$0" || exit ${HELPER_MISSING_EXIT}; exec node "$0" ${mode}`;
}

const HELPER_DEPLOY_SCRIPT =
  'mkdir -p "$1" && cat > "$1/.tmp.$$" && test "$(wc -c < "$1/.tmp.$$")" -eq "$3" && mv "$1/.tmp.$$" "$1/$2" || { rm -f "$1/.tmp.$$"; exit 1; }';

export function helperSpec(
  host: ExecHost,
  home: string,
  shell: string,
  hash: string,
  mode: HelperMode = '--stdio',
): HostSpawnSpec {
  if (host.kind !== 'wsl') throw new Error('helperSpec: not a wsl host');
  const line = helperLaunchLine(shell, mode);
  return {
    file: 'wsl.exe',
    args: ['-d', host.distro, '--cd', home, '-e', shell, '-ilc', line, helperPath(home, hash)],
    cwd: null,
  };
}

/**
 * Deploy: bundle on stdin, written atomically (tmp + mv) to `$1/$2`. `cat`
 * exits 0 on a short stdin (the writer was killed mid-pipe), so the tmp file
 * only moves into place when its size equals `$3` (the bundle's byte count);
 * otherwise it is removed and the run exits 1.
 */
export function helperDeploySpec(host: ExecHost, home: string, hash: string, bytes: number): HostSpawnSpec {
  if (host.kind !== 'wsl') throw new Error('helperDeploySpec: not a wsl host');
  return {
    file: 'wsl.exe',
    args: [
      '-d',
      host.distro,
      '-e',
      '/bin/sh',
      '-c',
      HELPER_DEPLOY_SCRIPT,
      'sh',
      `${home.replace(/\/+$/, '')}/${HELPER_DIR}`,
      helperFileName(hash),
      String(bytes),
    ],
    cwd: null,
  };
}

// ---- ssh transport ---------------------------------------------------------
// ssh.exe sends the remote side ONE command string that the remote login shell
// parses (unlike wsl.exe -e, which passes argv), so every user-influenced word
// is quoted with sshQuote. The string parses identically under POSIX shells
// and fish.

// ConnectTimeout bounds a dead network (fix round 1 #3); BatchMode never
// prompts; no OpenSSH multiplexing (R36 #6) — a user's ControlMaster could
// otherwise keep a hook forward alive past child.kill() or let a client
// return at once while a mux master holds the connection.
const SSH_BASE_ARGS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
];

/**
 * posixQuote, plus backslash handling: fish treats `\\` and `\'` as escapes
 * inside single quotes (a trailing backslash would swallow the closing quote),
 * POSIX does not. A backslash is emitted as `"\\"` (double-quoted), which both
 * shell families read as one literal backslash. Identical to posixQuote when
 * the input has no backslash.
 */
export function sshQuote(s: string): string {
  if (s.includes('\0')) throw new Error('ssh: NUL in argument');
  return s
    .split('\\')
    .map((part) => posixQuote(part))
    .join('"\\\\"');
}

function assertAlias(alias: string): void {
  if (!isValidSshAlias(alias)) throw new Error('ssh: invalid alias');
}

function assertAbs(p: string, what: string): void {
  if (!p.startsWith('/')) throw new Error(`ssh: ${what} must be an absolute posix path`);
}

function assertCmd(cmd: string): void {
  // A leading '-' would be read as an option by the exec'ing shell.
  if (!cmd || cmd.startsWith('-')) throw new Error('ssh: invalid command');
}

function sshSpec(alias: string, flags: string[], remote: string): HostSpawnSpec {
  assertAlias(alias);
  return { file: 'ssh.exe', args: [...SSH_BASE_ARGS, ...flags, alias, '--', remote], cwd: null };
}

/**
 * Env for an ssh spawn/pty (fix round 1 #4): only the app's own additions
 * (SDK vars, the hook token) — never the captured login env — as `export
 * K='v'` lines. They never appear in any argv: a piped spawn sends them
 * base64'd as the first stdin line (sshEnvLine), a pty sources a 0600 file the
 * helper staged (`env.stage`) and only that random path is in argv.
 */
export function sshEnvFileContent(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => {
      if (!ENV_KEY.test(key)) throw new Error('ssh: invalid env key');
      if (env[key]!.includes('\0')) throw new Error('ssh: NUL in env value');
      return `export ${key}=${posixQuote(env[key]!)}\n`;
    })
    .join('');
}

const base64Utf8 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** The first stdin line of an sshSpawnSpec child: base64 of sshEnvFileContent (empty line = no env). */
export function sshEnvLine(env: Record<string, string>): string {
  const content = sshEnvFileContent(env);
  return content ? `${base64Utf8(content)}\n` : '\n';
}

/**
 * `sh -c` script of sshSpawnSpec — $0 = login-shell body, $1 cwd, $2 shell,
 * rest = argv. The real stdin moves to fd 3 and the shell (and so the login
 * shell's rc files) gets /dev/null — an rc that reads stdin can't eat the
 * CLI's first stream-json line (R36 #5); the env line is read from fd 3 (one
 * byte at a time on a pipe, so the CLI keeps the rest) and the login body
 * hands fd 3 back as the CLI's stdin. A line that does not decode fails closed
 * (exit 97 + one stderr line) instead of running the CLI without its env (R36 #3).
 */
export const SSH_RUN_STDIN_SCRIPT =
  'exec 3<&0 </dev/null; IFS= read -r e <&3 || exit 97; ' +
  // `-d` is GNU/busybox, `--decode` is BSD/macOS (whose documented short form is -D);
  // each attempt gets its own printf, so a failed one never eats the next one's input.
  'if [ -n "$e" ]; then v=$(printf \'%s\\n\' "$e" | base64 -d 2>/dev/null) || v=$(printf \'%s\\n\' "$e" | base64 --decode 2>/dev/null) || { echo "agent-workspace: env decode failed" >&2; exit 97; }; eval "$v"; fi; ' +
  'cd "$1" || exit 1; shift; s="$1"; shift; exec "$s" -ilc "$0" "$@"';

/** `sh -c` script of sshPtySpec — $0 body, $1 staged env file ('' = none, removed after sourcing), $2 cwd, $3 shell, rest = argv. */
export const SSH_RUN_FILE_SCRIPT =
  'f="$1"; shift; if [ -n "$f" ]; then set -a; . "$f" || exit 97; set +a; rm -f "$f"; fi; ' +
  'cd "$1" || exit 1; shift; s="$1"; shift; exec "$s" -ilc "$0" "$@"';

const loginBody = (shell: string): string => (shellFamily(shell) === 'fish' ? 'exec $argv' : 'exec "$0" "$@"');
/** The piped-spawn body: the CLI's stdin is fd 3 again (SSH_RUN_STDIN_SCRIPT moved it there). */
const loginBodyFd3 = (shell: string): string =>
  shellFamily(shell) === 'fish' ? 'exec $argv <&3 3<&-' : 'exec "$0" "$@" <&3 3<&-';

/**
 * ssh counterpart of spawnSpec: `/bin/sh` (any login shell may be fish) reads
 * the env line from stdin, `cd`s and execs the CLI through the user's
 * interactive login shell (PATH/nvm come from it — the captured env is never
 * replayed). The caller writes sshEnvLine(env) to the child's stdin first.
 */
export function sshSpawnSpec(alias: string, cwd: string, shell: string, cmd: string, args: string[]): HostSpawnSpec {
  assertAbs(cwd, 'cwd');
  assertAbs(shell, 'shell');
  assertCmd(cmd);
  const words = ['/bin/sh', '-c', SSH_RUN_STDIN_SCRIPT, loginBodyFd3(shell), cwd, shell, cmd, ...args].map(sshQuote);
  return sshSpec(alias, ['-T'], `exec ${words.join(' ')}`);
}

/** ssh counterpart of ptySpec: forced tty; env (the hook token) from a staged file whose path alone is in argv. */
export function sshPtySpec(
  alias: string,
  cwd: string,
  envFile: string | null,
  cmd: string,
  args: string[],
  shell: string | null,
): HostSpawnSpec {
  const sh = shell ?? '/bin/bash';
  assertAbs(cwd, 'cwd');
  assertAbs(sh, 'shell');
  if (envFile !== null) assertAbs(envFile, 'env file');
  assertCmd(cmd);
  const words = ['/bin/sh', '-c', SSH_RUN_FILE_SCRIPT, loginBody(sh), envFile ?? '', cwd, sh, cmd, ...args].map(sshQuote);
  return sshSpec(alias, ['-t'], `exec ${words.join(' ')}`);
}

/** ssh counterpart of helperSpec (the hook forward is a separate connection: sshForwardSpec). */
export function sshHelperSpec(
  alias: string,
  home: string,
  shell: string,
  hash: string,
  mode: HelperMode = '--stdio',
): HostSpawnSpec {
  assertAbs(home, 'home');
  assertAbs(shell, 'shell');
  if (!HELPER_HASH_RE.test(hash)) throw new Error('ssh: invalid helper hash');
  return sshSpec(
    alias,
    ['-T'],
    `cd ${sshQuote(home)} && exec ${sshQuote(shell)} -ilc ${sshQuote(helperLaunchLine(shell, mode))} ${sshQuote(helperPath(home, hash))}`,
  );
}

/**
 * The hook listener's reverse forward on its own connection (fix round 1 #1):
 * bound to the remote loopback only, and `ExitOnForwardFailure` — a port
 * already taken on the remote (squatted) ends the connection instead of
 * leaving hooks pointed at someone else. Not `-N` (R39 #3): the remote command
 * reads the app's stdin pipe and exits on EOF, so the forward dies with the
 * app (crash / kill included) instead of orphaning the remote port.
 */
export const SSH_FORWARD_REMOTE = 'exec cat >/dev/null';

export function sshForwardSpec(alias: string, port: number): HostSpawnSpec {
  assertAlias(alias);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ssh: invalid forward port');
  return {
    file: 'ssh.exe',
    args: [
      ...SSH_BASE_ARGS,
      '-o',
      'ExitOnForwardFailure=yes',
      '-T',
      '-R',
      `127.0.0.1:${port}:127.0.0.1:${port}`,
      alias,
      '--',
      SSH_FORWARD_REMOTE,
    ],
    cwd: null,
  };
}

/** A failed ssh run worth retrying on its own (network/sleep): exit 255 or a timeout. Shell/node/helper failures are not. */
export function sshFailureClass(run: { code: number | null; timedOut: boolean }): 'connection' | 'other' {
  return run.timedOut || run.code === 255 ? 'connection' : 'other';
}

export const SSH_RECOVERY_MIN_MS = 60_000;

/** Recovery triggers (resume / unlock / focus) run at most once a minute. */
export function sshRecoveryDue(lastAt: number | null, now: number, minMs = SSH_RECOVERY_MIN_MS): boolean {
  return lastAt === null || now - lastAt >= minMs;
}

/** One plain command on the remote (probe curl, `claude stop`): `exec <argv…>`, every word quoted. */
export function sshCommandSpec(alias: string, argv: string[]): HostSpawnSpec {
  if (argv.length === 0) throw new Error('ssh: empty command');
  assertCmd(argv[0]!);
  return sshSpec(alias, ['-T'], `exec ${argv.map(sshQuote).join(' ')}`);
}

/** The WSL probe line (home / user / login shell / helper presence) under
 * `/bin/sh -c` — the remote login shell may be fish, which can't parse it. */
export function sshProbeSpec(alias: string, hash: string | null, home: string | null): HostSpawnSpec {
  return sshCommandSpec(alias, ['/bin/sh', '-c', probeLine(hash, home)]);
}

/** Marker between the node version and the CLI lookups in sshEnvSpec's output. */
export const CLI_MARKER = '__DW_CLI__';

/**
 * One interactive-login run per ssh probe (each ssh.exe is a full handshake):
 * the env capture, the node version, then `claude`/`devin`/`gh` lookups and
 * `claude --version`. Plain `cmd || cmd` and `;` only, so POSIX shells and
 * fish ≥ 3 parse it alike.
 */
export function sshEnvSpec(alias: string, shell: string): HostSpawnSpec {
  assertAbs(shell, 'shell');
  const cmd =
    `printf "\\0__DW_ENV__\\0"; env -0; printf "\\0${NODE_MARKER}\\0"; ` +
    'command -v node >/dev/null && node -p process.versions.node || echo NONODE; ' +
    `printf "\\0${CLI_MARKER}\\0"; ` +
    'printf "claude="; command -v claude || echo; ' +
    'printf "devin="; command -v devin || echo; ' +
    'printf "gh="; command -v gh || echo; ' +
    'printf "version="; claude --version 2>/dev/null || echo';
  return sshSpec(alias, ['-T'], `exec ${sshQuote(shell)} -ilc ${sshQuote(cmd)}`);
}

export interface SshEnvProbe {
  env: Record<string, string> | null;
  node: string | null;
  claude: string | null;
  devin: string | null;
  gh: boolean;
  version: string | null;
}

/** sshEnvSpec output → env / node / CLI paths. Everything is null/false when the markers are missing. */
export function parseSshEnvProbe(stdout: Uint8Array | string): SshEnvProbe {
  const text = typeof stdout === 'string' ? stdout : new TextDecoder('utf-8').decode(stdout);
  const sep = `\0${CLI_MARKER}\0`;
  const at = text.lastIndexOf(sep);
  const head = at === -1 ? text : text.slice(0, at);
  const env = parseShellEnv(head, '__DW_ENV__');
  const node = env === null ? null : parseNodeVersion(head, NODE_MARKER);
  const lines = at === -1 ? [] : text.slice(at + sep.length).split('\n');
  const field = (key: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${key}=`));
    const value = line?.slice(key.length + 1).trim() ?? '';
    return value || null;
  };
  const abs = (value: string | null): string | null => (value && value.startsWith('/') ? value : null);
  const version = field('version')?.split(/\s+/)[0] ?? null;
  return {
    env,
    node,
    claude: abs(field('claude')),
    devin: abs(field('devin')),
    gh: abs(field('gh')) !== null,
    version: version && SEMVER_LINE.test(version) ? version : null,
  };
}

/** ssh counterpart of helperDeploySpec: same byte-count-gated atomic script, bundle on stdin. */
export function sshHelperDeploySpec(alias: string, home: string, hash: string, bytes: number): HostSpawnSpec {
  assertAbs(home, 'home');
  if (!HELPER_HASH_RE.test(hash)) throw new Error('ssh: invalid helper hash');
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error('ssh: invalid byte count');
  const words = [
    '/bin/sh',
    '-c',
    HELPER_DEPLOY_SCRIPT,
    'sh',
    `${home.replace(/\/+$/, '')}/${HELPER_DIR}`,
    helperFileName(hash),
    String(bytes),
  ].map(sshQuote);
  return sshSpec(alias, ['-T'], `exec ${words.join(' ')}`);
}

/**
 * Node version from the env-capture output (`…env -0; printf "\0<marker>\0";
 * command -v node && node -p process.versions.node || echo NONODE`). Null for
 * `NONODE`, a missing marker (capture failed or an old shell) or junk.
 */
export function parseNodeVersion(stdout: Uint8Array | string, marker: string = NODE_MARKER): string | null {
  const text = typeof stdout === 'string' ? stdout : new TextDecoder('utf-8').decode(stdout);
  const sep = `\0${marker}\0`;
  const at = text.lastIndexOf(sep);
  if (at === -1) return null;
  const token = text.slice(at + sep.length).trim().split(/\s+/).pop() ?? '';
  return SEMVER_LINE.test(token) ? token : null;
}

/** Structural comparison of host status lists — ignores probe timestamps and env-capture timings so a re-probe that learned nothing new doesn't republish. */
export function statusesChanged(prev: HostStatus[] | null, next: HostStatus[]): boolean {
  if (prev === null) return true;
  const norm = (rows: HostStatus[]): string =>
    JSON.stringify(
      rows.map((row) => ({
        ...row,
        probedAt: null,
        shellEnv: row.shellEnv ? { ok: row.shellEnv.ok, count: row.shellEnv.count } : null,
      })),
    );
  return norm(prev) !== norm(next);
}
