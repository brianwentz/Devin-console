// Execution hosts (pure): a host is where a CLI session actually runs —
// 'local' is this Windows machine, 'wsl:<distro>' is a WSL distribution
// reached through wsl.exe. No node/electron imports; path strings are
// manipulated by hand so behaviour is identical on every platform.

export type HostId = 'local' | `wsl:${string}`;

export type ExecHost =
  | { id: 'local'; kind: 'local' }
  | {
      id: HostId;
      kind: 'wsl';
      distro: string;
      home: string | null;
      /** Automount root for drive paths, '/mnt' unless wsl.conf says otherwise. */
      mount: string;
    };

export const LOCAL_HOST: ExecHost = { id: 'local', kind: 'local' };

export function isWslHost(host: ExecHost): host is Extract<ExecHost, { kind: 'wsl' }> {
  return host.kind === 'wsl';
}

export function wslHost(distro: string, home: string | null, mount = '/mnt'): ExecHost {
  return { id: `wsl:${distro}`, kind: 'wsl', distro, home, mount };
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

// '\\\\wsl.localhost\<distro>\…', '\\wsl$\<distro>\…' and the forward-slash
// spellings '//wsl.localhost/<d>/…'. Server part is case-insensitive.
export function hostIdForPath(p: string): HostId {
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
  const norm = winPath.replace(/\\/g, '/');
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
export function displayPath(host: ExecHost, hostPath: string, multiHost: boolean): string {
  return multiHost && isWslHost(host) ? `${host.distro} · ${hostPath}` : hostPath;
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
  const env = mergeShellEnv({}, cmd.env ?? {});
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
      'exec "$@"',
      '--',
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
