// Execution host registry (main): enumerates `wsl.exe` distros into ExecHost
// records, probes each enabled host once per app run (home/shell/env capture/
// CLIs/hook reachability), and hands out spawn/pty/exec specs shaped by
// core/execHost. `withConfigDir` serialises SDK store calls across hosts.
// Never logs env values or resolved paths.

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import {
  hostIdForPath as coreHostIdForPath,
  mergeShellEnv,
  isWslHost,
  LOCAL_HOST,
  parseShellEnv,
  parseWslList,
  ptySpec,
  spawnSpec,
  toHostPath as coreToHostPath,
  toWindowsPath as coreToWindowsPath,
  type ExecHost,
  type HostCommand,
  type HostId,
} from '../core/execHost';
import type { HostStatus, Settings } from '../shared/ipc';
import { log } from './log';
import { state, testMode } from './state';
import { resolveClaudePath } from './claude/claudePath';
import { resolveDevinPath } from './local/acpHost';
import { sdkTargetCliVersion } from './claude/sdk';

const execFileAsync = promisify(execFile);

const ENUM_CACHE_MS = 5 * 60_000;
const ENV_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const ENV_MARKER = '__DW_ENV__';

export interface HostPtySpec {
  file: string;
  args: string[];
  cwd: string | null;
}

interface WslEntry {
  host: Extract<ExecHost, { kind: 'wsl' }>;
  status: HostStatus;
  probed: boolean;
  probing: Promise<void> | null;
  envAt: number;
  env: Record<string, string> | null;
  hookAddr: string | null;
}

// The local row re-resolves CLI paths at most once a minute — `where` spawns.
let localStatusCache: { at: number; status: HostStatus } | null = null;
const localStatus = (): HostStatus => {
  if (localStatusCache && Date.now() - localStatusCache.at < 60_000) return localStatusCache.status;
  const status: HostStatus = {
    id: 'local',
    kind: 'local',
    label: 'This PC',
    state: 'ready',
    error: null,
    probedAt: null,
    home: null,
    shell: null,
    claude: {
      path: resolveClaudePath(state.settings?.current.claude.path ?? null),
      version: null,
    },
    devin: { path: resolveDevinPath(state.settings?.current.local.devinPath) },
    shellEnv: null,
    hooks: 'untested',
    inotify: false,
    gh: true,
  };
  localStatusCache = { at: Date.now(), status };
  return status;
};

export class HostsRegistry {
  private wsl: { file: string; args: string[] } | null | undefined;
  private distros: { at: number; rows: ReturnType<typeof parseWslList> } | null = null;
  private entries = new Map<HostId, WslEntry>();
  private configMutex: Promise<unknown> = Promise.resolve();
  private hostErrors: Record<string, string> = {};

  // --- command plumbing ----------------------------------------------------

  /** The `wsl.exe` invocation prefix ([file, ...args]) or null when absent. */
  wslCmd(): string[] | null {
    if (this.wsl !== undefined) return this.wsl ? [this.wsl.file, ...this.wsl.args] : null;
    if (testMode && process.env.DEVIN_WORKSPACES_TEST_WSL_CMD?.trim()) {
      const parts = process.env.DEVIN_WORKSPACES_TEST_WSL_CMD.trim().split(/\s+/).filter(Boolean);
      this.wsl = parts.length ? { file: parts[0]!, args: parts.slice(1) } : null;
      return this.wsl ? [this.wsl.file, ...this.wsl.args] : null;
    }
    if (process.platform !== 'win32') {
      this.wsl = null;
      return null;
    }
    try {
      const found = spawnSync(
        process.platform === 'win32' ? 'where.exe' : 'which',
        ['wsl.exe'],
        { encoding: 'utf8', windowsHide: true },
      );
      this.wsl = found.status === 0 ? { file: 'wsl.exe', args: [] } : null;
    } catch {
      this.wsl = null;
    }
    return this.wsl ? [this.wsl.file, ...this.wsl.args] : null;
  }

  private async execWsl(args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
    const cmd = this.wslCmd();
    if (!cmd) throw new Error('wsl.exe not found');
    const [file, ...prefix] = cmd;
    const { stdout } = await execFileAsync(file!, [...prefix, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }

  private execWslSync(args: string[], encoding: BufferEncoding = 'utf8'): string | null {
    const cmd = this.wslCmd();
    if (!cmd) return null;
    const [file, ...prefix] = cmd;
    try {
      const result = spawnSync(file!, [...prefix, ...args], {
        encoding,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return result.status === 0 ? (result.stdout as string) : null;
    } catch {
      return null;
    }
  }

  // --- enumeration -----------------------------------------------------------

  /** Distro list from `wsl.exe -l -v` (5 min cache). */
  enumerate(): ReturnType<typeof parseWslList> {
    if (this.distros && Date.now() - this.distros.at < ENUM_CACHE_MS) return this.distros.rows;
    const wslEnabled = state.settings?.current.hosts.wslEnabled ?? true;
    const out = wslEnabled ? this.execWslSync(['-l', '-v'], 'utf16le') : null;
    const rows = out ? parseWslList(out) : [];
    this.distros = { at: Date.now(), rows };
    log('host', 'host-list', { detail: { count: rows.length, wsl: rows.length > 0 } });
    return rows;
  }

  /** Enabled wsl distros: explicit settings list, else Running or default. */
  private enabledDistros(): { name: string; stopped: boolean }[] {
    const explicit = state.settings?.current.hosts.wslDistros ?? null;
    return this.enumerate()
      .filter((row) =>
        explicit !== null ? explicit.includes(row.name) : row.state === 'Running' || row.default,
      )
      .map((row) => ({ name: row.name, stopped: row.state === 'Stopped' }));
  }

  private entryFor(name: string, stopped: boolean): WslEntry {
    const id: HostId = `wsl:${name}`;
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        host: { id, kind: 'wsl', distro: name, home: null, mount: '/mnt' },
        status: {
          id,
          kind: 'wsl',
          label: name,
          state: stopped ? 'stopped' : 'probing',
          error: null,
          probedAt: null,
          home: null,
          shell: null,
          claude: { path: null, version: null },
          devin: { path: null },
          shellEnv: null,
          hooks: 'untested',
          inotify: false,
          gh: false,
        },
        probed: false,
        probing: null,
        envAt: 0,
        env: null,
        hookAddr: null,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Enabled ExecHosts: local first, then each enabled wsl distro. */
  list(): ExecHost[] {
    const hosts: ExecHost[] = [LOCAL_HOST];
    for (const { name } of this.enabledDistros()) {
      hosts.push(this.entryFor(name, false).host);
    }
    return hosts;
  }

  /** Enabled hosts plus every host we've seen this run — used by the hooks
   * opt-in so a disabled host still gets our block removed. */
  allHosts(): ExecHost[] {
    const seen = new Map<HostId, ExecHost>();
    for (const host of this.list()) seen.set(host.id, host);
    for (const entry of this.entries.values()) seen.set(entry.host.id, entry.host);
    return [LOCAL_HOST, ...[...seen.values()].filter((h) => h.id !== 'local')];
  }

  hostById(id: HostId | string): ExecHost | null {
    if (id === 'local') return LOCAL_HOST;
    return this.entries.get(id as HostId)?.host ?? null;
  }

  statuses(): HostStatus[] {
    const statuses: HostStatus[] = [localStatus()];
    for (const { name, stopped } of this.enabledDistros()) {
      const entry = this.entryFor(name, stopped);
      statuses.push(entry.status);
      // Lazily probe each enabled, running distro once per app run.
      if (!stopped && !entry.probed && !entry.probing) void this.probe(entry);
    }
    return statuses;
  }

  errors(): Record<string, string> {
    return { ...this.hostErrors };
  }

  /** A wsl host whose settings overrides apply (path/shell/home). */
  private overrides(id: HostId): NonNullable<Settings['hosts']['overrides'][string]> {
    return state.settings?.current.hosts.overrides[id] ?? {};
  }

  // --- probe -----------------------------------------------------------------

  private async probe(entry: WslEntry): Promise<void> {
    if (entry.probing) return entry.probing;
    entry.status = { ...entry.status, state: 'probing' };
    const t0 = Date.now();
    entry.probing = (async () => {
      const distro = entry.host.distro;
      const id = entry.host.id;
      const overrides = this.overrides(id);
      try {
        // home / user / login shell in one sh call.
        const out = await this.execWsl([
          '-d',
          distro,
          '-e',
          '/bin/sh',
          '-c',
          'echo "$HOME"; id -un; getent passwd "$(id -un)" | cut -d: -f7',
        ]);
        const [home, , shell] = out.trim().split('\n');
        entry.host = { ...entry.host, home: overrides.home ?? home?.trim() ?? null };
        entry.status = {
          ...entry.status,
          home: entry.host.home,
          shell: overrides.shell ?? shell?.trim() ?? '/bin/bash',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.status = { ...entry.status, state: 'error', error: message.slice(0, 200), probedAt: new Date().toISOString() };
        entry.probed = true;
        log('host', 'host-probe', { detail: { host: id, ok: false, ms: Date.now() - t0 } });
        return;
      }
      const shell = overrides.shell ?? entry.status.shell ?? '/bin/bash';
      // §1.4 shell environment capture (escape hatch: envCaptureDisabled).
      if (overrides.envCaptureDisabled === true) {
        entry.env = null;
        entry.status = { ...entry.status, shellEnv: null };
      } else {
        await this.captureEnv(entry, shell);
      }
      // CLI resolution under the captured PATH; settings overrides win.
      const resolve = async (bin: string): Promise<string | null> => {
        try {
          const out = await this.execWsl(['-d', distro, '-e', shell, '-ilc', `command -v ${bin}`]);
          return out.trim().split('\n')[0]?.trim() || null;
        } catch {
          return null;
        }
      };
      const claudePath = overrides.claudePath ?? (await resolve('claude'));
      const devinPath = overrides.devinPath ?? (await resolve('devin'));
      const gh = (await resolve('gh')) !== null;
      const inotify = (await resolve('inotifywait')) !== null;
      let version: string | null = null;
      if (claudePath) {
        try {
          const home = entry.host.home ?? '/';
          const out = await this.execOn(entry.host, {
            file: claudePath,
            args: ['--version'],
            cwd: home,
          });
          version = out.trim().split(/\s+/)[0] ?? null;
        } catch {
          version = null;
        }
      }
      const sdkTarget = sdkTargetCliVersion();
      if (claudePath && version && sdkTarget && version !== sdkTarget) {
        this.hostErrors[id] = `claude ${version} (SDK targets ${sdkTarget})`;
      } else if (!claudePath) {
        this.hostErrors[id] = 'Claude Code not found — set the path in Settings';
      } else {
        delete this.hostErrors[id];
      }
      // Hook listener reachability: loopback first, then the WSL vEthernet
      // address for NAT-mode distros.
      const hooks = await this.probeHooks(entry);
      entry.status = {
        ...entry.status,
        state: 'ready',
        error: null,
        probedAt: new Date().toISOString(),
        claude: { path: claudePath, version },
        devin: { path: devinPath },
        hooks,
        inotify,
        gh,
      };
      log('host', 'host-probe', {
        detail: {
          host: id,
          ok: true,
          ms: Date.now() - t0,
          claude: claudePath !== null,
          devin: devinPath !== null,
          hooks,
        },
      });
      entry.probed = true;
    })().finally(() => {
      entry.probing = null;
      this.onStatusChange?.();
    });
    await entry.probing;
  }

  /** §1.4 capture: `<shell> -ilc 'printf "\0__DW_ENV__\0"; env -0'`. */
  private async captureEnv(entry: WslEntry, shell: string): Promise<void> {
    const t0 = Date.now();
    const id = entry.host.id;
    try {
      const cmd = `printf "\\0${ENV_MARKER}\\0"; env -0`;
      const { stdout } = await this.rawWsl([
        '-d',
        entry.host.distro,
        '-e',
        shell,
        '-ilc',
        cmd,
      ]);
      const env = parseShellEnv(stdout, ENV_MARKER);
      if (env === null) {
        entry.env = null;
        entry.envAt = Date.now();
        entry.status = { ...entry.status, shellEnv: { ok: false, count: 0, ms: Date.now() - t0 } };
        this.hostErrors[id] = 'shell environment unavailable — using the plain WSL environment';
        log('host', 'host-env', {
          detail: { host: id, ok: false, ms: Date.now() - t0, count: 0, reason: 'no-marker' },
        });
        return;
      }
      entry.env = env;
      entry.envAt = Date.now();
      entry.status = {
        ...entry.status,
        shellEnv: { ok: true, count: Object.keys(env).length, ms: Date.now() - t0 },
      };
      delete this.hostErrors[id];
      log('host', 'host-env', {
        detail: { host: id, ok: true, ms: Date.now() - t0, count: Object.keys(env).length },
      });
    } catch (error) {
      entry.env = null;
      entry.envAt = Date.now();
      entry.status = { ...entry.status, shellEnv: { ok: false, count: 0, ms: Date.now() - t0 } };
      this.hostErrors[id] = 'shell environment unavailable — using the plain WSL environment';
      log('host', 'host-env', {
        detail: {
          host: id,
          ok: false,
          ms: Date.now() - t0,
          count: 0,
          reason: error instanceof Error ? error.message.slice(0, 80) : 'error',
        },
      });
    }
  }

  private rawWsl(args: string[]): Promise<{ stdout: Buffer; stderr: Buffer }> {
    const cmd = this.wslCmd();
    if (!cmd) return Promise.reject(new Error('wsl.exe not found'));
    const [file, ...prefix] = cmd;
    return new Promise((resolve, reject) => {
      execFile(
        file!,
        [...prefix, ...args],
        {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        },
      );
    });
  }

  private async probeHooks(entry: WslEntry): Promise<'ok' | 'unreachable' | 'untested'> {
    const port = this.hookPort?.();
    if (!port) return 'untested';
    const curl = (addr: string) =>
      this.execWsl([
        '-d',
        entry.host.distro,
        '-e',
        'curl',
        '-s',
        '-m',
        '2',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        `http://${addr}:${port}/devin-workspaces/hook/health`,
      ]).then((code) => ['200', '401', '404'].includes(code.trim()));
    try {
      if (await curl('127.0.0.1')) return 'ok';
    } catch {
      /* fall through to vEthernet */
    }
    const veth = this.vEthernetAddr();
    if (veth) {
      try {
        if (await curl(veth)) {
          entry.hookAddr = veth;
          this.hookAddrBind?.(veth);
          return 'ok';
        }
      } catch {
        /* unreachable */
      }
    }
    return 'unreachable';
  }

  private vEthernetAddr(): string | null {
    for (const [name, infos] of Object.entries(networkInterfaces())) {
      if (!name.startsWith('vEthernet (WSL')) continue;
      const ipv4 = infos?.find((i) => i.family === 'IPv4');
      if (ipv4) return ipv4.address;
    }
    return null;
  }

  /** Wired by the hook collaborator: the listener port and a vEthernet bind. */
  hookPort: (() => number | null) | null = null;
  hookAddrBind: ((addr: string) => void) | null = null;
  /** Called when a probe/env capture finishes so consumers can re-publish. */
  onStatusChange: (() => void) | null = null;

  /** The vEthernet address a NAT-mode host reaches the hook listener on. */
  hookAddrFor(id: string): string | null {
    return this.entries.get(id as HostId)?.hookAddr ?? null;
  }

  /** Record or clear a per-host status line (hooks install, store errors). */
  setError(id: string, message: string | null): void {
    if (message) this.hostErrors[id] = message;
    else delete this.hostErrors[id];
  }

  // --- env + spawn -------------------------------------------------------------

  /** The cached §1.4 environment; re-captures when stale (call before spawns). */
  async shellEnv(host: ExecHost): Promise<Record<string, string> | null> {
    if (!isWslHost(host)) return null;
    const entry = this.entries.get(host.id);
    if (!entry) return null;
    if (Date.now() - entry.envAt < ENV_CACHE_MS) return entry.env;
    if (!entry.probed && !entry.probing) await this.probe(entry);
    else if (entry.probing) await entry.probing;
    if (Date.now() - entry.envAt < ENV_CACHE_MS) return entry.env;
    await this.captureEnv(entry, entry.status.shell ?? '/bin/bash');
    return entry.env;
  }

  /** Synchronous cached env for the spawn path (shellEnv() refreshes first). */
  private cachedEnv(host: ExecHost): Record<string, string> | null {
    if (!isWslHost(host)) return null;
    return this.entries.get(host.id)?.env ?? null;
  }

  /** env refresh for `claude:recheckEnv` — forces a capture for the host. */
  async recheckEnv(id: string): Promise<void> {
    const entry = this.entries.get(id as HostId);
    if (!entry) return;
    await this.captureEnv(entry, entry.status.shell ?? '/bin/bash');
  }

  /** `K=V` diff of `env` vs process.env — exactly the additions a child needs. */
  private envDiff(env: Record<string, string | undefined> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value !== undefined && value !== process.env[key]) out[key] = value;
    }
    return out;
  }

  /** Piped child (SDK stream, ACP, gh, probes). shellEnv() primes the cache. */
  spawnOn(host: ExecHost, cmd: HostCommand, opts?: { signal?: AbortSignal }): ChildProcess {
    const spec = spawnSpec(host, cmd, this.cachedEnv(host));
    const t0 = Date.now();
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd ?? homedir(),
      env: host.kind === 'local' ? { ...process.env, ...cmd.env } : process.env,
      windowsHide: true,
      signal: opts?.signal,
      stdio: 'pipe',
    });
    child.once('spawn', () => {
      log('host', 'host-spawn', {
        detail: { host: host.id, kind: 'pipe', ok: true, ms: Date.now() - t0 },
      });
    });
    child.once('error', () => {
      log('host', 'host-spawn', {
        detail: { host: host.id, kind: 'pipe', ok: false, ms: Date.now() - t0 },
      });
    });
    return child;
  }

  /** execFile-style run returning stdout (probes, agents, gh). */
  async execOn(host: ExecHost, cmd: HostCommand, timeout = PROBE_TIMEOUT_MS): Promise<string> {
    await this.shellEnv(host);
    const spec = spawnSpec(host, cmd, this.cachedEnv(host));
    const { stdout } = await execFileAsync(spec.file, spec.args, {
      cwd: spec.cwd ?? homedir(),
      env: host.kind === 'local' ? { ...process.env, ...cmd.env } : process.env,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }

  /** node-pty spec; the caller supplies the pty options (cols/rows/env). */
  ptySpawnSpec(host: ExecHost, cmd: HostCommand): HostPtySpec {
    const shell = isWslHost(host) ? (this.entries.get(host.id)?.status.shell ?? null) : null;
    return ptySpec(host, cmd, shell);
  }

  // --- paths -------------------------------------------------------------------

  /** Windows-side path → host id; honours the test UNC root seam. */
  pathHostId(p: string): HostId {
    const root = testMode ? process.env.DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT : undefined;
    if (root && p.startsWith(root)) {
      const first = this.list().find((h) => h.kind === 'wsl');
      if (first) return first.id;
    }
    return coreHostIdForPath(p);
  }

  /** Windows-side path → host path (UNC root seam post-processes here). */
  hostPath(host: ExecHost, winPath: string): string {
    const root = testMode ? process.env.DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT : undefined;
    if (root && winPath.startsWith(root) && isWslHost(host)) {
      const rest = winPath.slice(root.length).replace(/\\/g, '/');
      const cleaned = rest.replace(/^\/+/, '');
      return cleaned ? `/${cleaned}` : '/';
    }
    return coreToHostPath(host, winPath);
  }

  /** Host path → Windows-side (UNC root seam: \\wsl.localhost\<D> → the root). */
  windowsPath(host: ExecHost, hostPath: string): string {
    const out = coreToWindowsPath(host, hostPath);
    const root = testMode ? process.env.DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT : undefined;
    if (root && isWslHost(host)) {
      return out.replace(`\\\\wsl.localhost\\${host.distro}`, root);
    }
    return out;
  }

  configDir(host: ExecHost): string {
    if (!isWslHost(host)) {
      return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
    }
    const home = this.entries.get(host.id)?.host.home ?? this.overrides(host.id).home ?? null;
    return this.windowsPath(host, `${home ?? ''}/.claude`);
  }

  /** Serialised `CLAUDE_CONFIG_DIR` swap around an SDK store call (§1.2). */
  withConfigDir<T>(host: ExecHost, fn: () => Promise<T>): Promise<T> {
    const dir = this.configDir(host);
    const run = this.configMutex.then(async () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = dir;
      try {
        return await fn();
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
    this.configMutex = run.catch(() => undefined);
    return run;
  }

  // --- membership --------------------------------------------------------------

  /** hosts:setEnabled — the explicit wslDistros list is the source of truth. */
  setEnabled(id: string, enabled: boolean): void {
    const distro = id.startsWith('wsl:') ? id.slice(4) : null;
    if (!distro) return;
    const current = state.settings?.current.hosts.wslDistros ?? null;
    // null (auto) → materialise today's enabled set before toggling.
    const base =
      current ??
      this.enumerate()
        .filter((row) => row.state === 'Running' || row.default)
        .map((row) => row.name);
    const next = enabled
      ? [...new Set([...base, distro])]
      : base.filter((name) => name !== distro);
    state.settings?.merge({ hosts: { wslDistros: next } });
    this.distros = null;
  }

  /** hosts:refresh — re-enumerate and re-probe. */
  async refresh(id?: string): Promise<void> {
    this.distros = null;
    const targets = id
      ? [...this.entries.values()].filter((e) => e.host.id === id)
      : [...this.entries.values()];
    this.enumerate();
    for (const entry of targets) {
      entry.probed = false;
      await this.probe(entry);
    }
  }

  /** `gh` invocation for a host: wsl → wsl.exe-wrapped with the captured env;
   * anything else → null (caller falls back to local gh resolution). */
  ghSpec(id: HostId): { cmd: string; args: string[] } | null {
    const entry = this.entries.get(id);
    if (!entry || !entry.status.gh || !isWslHost(entry.host)) return null;
    const wsl = this.wslCmd();
    if (!wsl) return null;
    const [file, ...prefix] = wsl;
    const env = mergeShellEnv(this.cachedEnv(entry.host) ?? {}, {});
    const kv = Object.keys(env)
      .sort()
      .map((key) => `${key}=${env[key]}`);
    return {
      cmd: file!,
      args: [...prefix, '-d', entry.host.distro, '-e', '/usr/bin/env', ...kv, 'gh'],
    };
  }

  // --- test seams ---------------------------------------------------------------

  /** Test hooks: status rows and env key names (never values). */
  status(id: string): HostStatus | null {
    return this.entries.get(id as HostId)?.status ?? null;
  }

  shellEnvKeys(id: string): string[] {
    return Object.keys(this.entries.get(id as HostId)?.env ?? {}).sort();
  }
}

let registry: HostsRegistry | null = null;

export function hosts(): HostsRegistry {
  registry ??= new HostsRegistry();
  return registry;
}
