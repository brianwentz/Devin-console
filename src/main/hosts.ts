// Execution host registry (main): enumerates `wsl.exe` distros into ExecHost
// records, probes each enabled host once per app run (home/shell/env capture/
// CLIs/hook reachability), and hands out spawn/pty/exec specs shaped by
// core/execHost. `withConfigDir` serialises SDK store calls across hosts.
// Never logs env values or resolved paths.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { app } from 'electron';
import {
  hostIdForPath as coreHostIdForPath,
  mergeShellEnv,
  isFsReady,
  isWslHost,
  LOCAL_HOST,
  parseShellEnv,
  parseWslList,
  ptySpec,
  resolveLocalConfigDir,
  spawnSpec,
  toHostPath as coreToHostPath,
  toWindowsPath as coreToWindowsPath,
  type ExecHost,
  type HostCommand,
  type HostId,
  parseNodeVersion,
  parseProbeOutput,
  parseHelperPresent,
  probeLine,
  deriveHelperState,
  helperDeploySpec,
  NODE_MARKER,
  statusesChanged,
} from '../core/execHost';
import type { HostStatus, Settings } from '../shared/ipc';
import { log } from './log';
import { HOOK_PATH_PREFIX } from '../core/claudeHooks';
import { state, testMode } from './state';
import { resolveClaudePath } from './claude/claudePath';
import { resolveDevinPath } from './local/acpHost';
import { sdkTargetCliVersion } from './claude/sdk';
import { loadHelperBundleInfo, type HelperBundleInfo } from './helperBundle';

const execFileAsync = promisify(execFile);

let helperInfo: HelperBundleInfo | null | undefined;
/** The shipped helper bundle (`out/helper/helper-hash.json`), null until the build produces one - then no deploy, no probe token, no channel. Read once per run. */
export function helperBundle(): HelperBundleInfo | null {
  if (helperInfo === undefined) helperInfo = loadHelperBundleInfo(join(app.getAppPath(), 'out'));
  return helperInfo;
}
export const helperAvailable = (): boolean => helperBundle() !== null;

const ENUM_CACHE_MS = 5 * 60_000;
// Background WSL work (agents poll, change check, gh fallback) re-reads an
// enumeration older than this first — a distro stopped or crashed since the
// last 5-min pass must not be booted again by the next tick.
const ENUM_FRESH_MS = 60_000;

function enumFreshMs(): number {
  const override = testMode ? Number(process.env.AGENT_WORKSPACE_TEST_ENUM_FRESH_MS) : NaN;
  return Number.isFinite(override) && override > 0 ? override : ENUM_FRESH_MS;
}
const ENV_CACHE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const ENV_MARKER = '__DW_ENV__';
const HOOK_HEALTH_PATH = `${HOOK_PATH_PREFIX}health`;

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
    node: null,
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

/** Every `wsl.exe` invocation logs `host-exec {host, kind}` so a soak can count them. */
type WslExecKind = 'enum' | 'probe' | 'env' | 'exec' | 'spawn';

type HostErrorPart = 'env' | 'cli' | 'hooksInstall' | 'store';

interface WslRun {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
}

export class HostsRegistry {
  private wsl: { file: string; args: string[] } | null | undefined;
  /** Resolves once the async `wsl.exe` lookup settles; awaited where the
   * binary is needed, never on the publish path. */
  private ready: Promise<void>;
  private distros: { at: number; rows: ReturnType<typeof parseWslList> } | null = null;
  private enumInFlight: Promise<void> | null = null;
  private started = false;
  private lastPublished: HostStatus[] | null = null;
  private enumWaiters: Array<() => void> = [];
  private entries = new Map<HostId, WslEntry>();
  private configMutex: Promise<unknown> = Promise.resolve();
  private errorParts = new Map<string, Partial<Record<HostErrorPart, string>>>();
  /** The local Claude home, captured once at construction. `withConfigDir`
   * rewrites `process.env.CLAUDE_CONFIG_DIR` for the SDK while a store call
   * runs, so reading the env var live would hand a WSL store to any caller
   * that asks for the local host mid-swap (the usage scanner did). */
  private readonly localConfigDirValue: string;

  constructor() {
    this.localConfigDirValue = resolveLocalConfigDir(process.env, homedir(), join);
    this.ready = this.resolveWsl();
  }

  // --- command plumbing ----------------------------------------------------

  private async resolveWsl(): Promise<void> {
    if (testMode && process.env.AGENT_WORKSPACE_TEST_WSL_CMD?.trim()) {
      const parts = process.env.AGENT_WORKSPACE_TEST_WSL_CMD.trim().split(/\s+/).filter(Boolean);
      this.wsl = parts.length ? { file: parts[0]!, args: parts.slice(1) } : null;
      return;
    }
    if (process.platform !== 'win32') {
      this.wsl = null;
      return;
    }
    try {
      const { stdout } = await execFileAsync('where.exe', ['wsl.exe'], { windowsHide: true });
      this.wsl = stdout.trim() ? { file: 'wsl.exe', args: [] } : null;
    } catch {
      this.wsl = null;
    }
  }

  /** False until the async `wsl.exe` lookup settles (callers caching a null
   * result should check this first). */
  get wslResolved(): boolean {
    return this.wsl !== undefined;
  }

  /** The `wsl.exe` invocation prefix ([file, ...args]); null when absent or
   * the async lookup hasn't settled yet. */
  wslCmd(): string[] | null {
    return this.wsl ? [this.wsl.file, ...this.wsl.args] : null;
  }

  // Spawn with stdin closed — an rc file that reads stdin must not hang the
  // probe until the timeout; a non-zero exit only rejects when
  // `requireSuccess` is set (an rc file may `exit 1` after `env -0` has
  // already printed, and the marker-validated output is still usable).
  private runWsl(
    args: string[],
    opts: { kind: WslExecKind; host: string; timeout?: number; requireSuccess?: boolean; input?: Buffer },
  ): Promise<WslRun> {
    const timeout = opts.timeout ?? PROBE_TIMEOUT_MS;
    const requireSuccess = opts.requireSuccess ?? true;
    return new Promise((resolvePromise, reject) => {
      void this.ready.then(() => {
        const cmd = this.wslCmd();
        if (!cmd) {
          reject(new Error('wsl.exe not found'));
          return;
        }
        const [file, ...prefix] = cmd;
        log('host', 'host-exec', { detail: { host: opts.host, kind: opts.kind } });
        const child = spawn(file!, [...prefix, ...args], {
          stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        if (opts.input) {
          // EPIPE when wsl.exe dies early surfaces through the exit code.
          child.stdin!.on('error', () => undefined);
          child.stdin!.end(opts.input);
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeout);
        timer.unref?.();
        child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (requireSuccess && code !== 0) {
            reject(new Error(`wsl.exe exited ${code ?? 'unknown'}`));
            return;
          }
          resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
        });
      });
    });
  }

  private async execWsl(args: string[], kind: WslExecKind, host: string): Promise<string> {
    const { stdout } = await this.runWsl(args, { kind, host });
    return stdout.toString('utf8');
  }

  // --- enumeration -----------------------------------------------------------

  /** Cached distro rows ([] until the first async `-l -v` lands). Read paths
   * (statuses/list/enabledDistros) never spawn: enumeration runs at start, on
   * a 5-minute interval, on window focus once the cache is stale, and on
   * refresh(). */
  enumerate(): ReturnType<typeof parseWslList> {
    return this.distros?.rows ?? [];
  }

  /** Kicks the first enumeration and the periodic re-enumeration. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.enumerateAsync();
    const timer = setInterval(() => void this.enumerateAsync(), ENUM_CACHE_MS);
    timer.unref?.();
  }

  /** Window focus: re-enumerate only when the cache has gone stale. */
  onWindowFocus(): void {
    if (!this.started) return;
    if (!this.distros || Date.now() - this.distros.at >= ENUM_CACHE_MS) void this.enumerateAsync();
  }

  /** Fires onStatusChange only when the status rows changed structurally. */
  private publish(): void {
    const next = this.statuses();
    if (!statusesChanged(this.lastPublished, next)) return;
    this.lastPublished = next;
    this.onStatusChange?.();
  }

  /** Resolves once at least one enumeration has landed (immediately when a
   * list — even an empty one — is already cached). Lets startup work that
   * maps UNC workspaces to distros wait without re-probing. */
  whenEnumerated(): Promise<void> {
    if (this.distros) return Promise.resolve();
    void this.enumerateAsync();
    return new Promise((resolveWait) => this.enumWaiters.push(resolveWait));
  }

  private enumerateAsync(): Promise<void> {
    this.enumInFlight ??= this.runEnumeration().finally(() => {
      this.enumInFlight = null;
    });
    return this.enumInFlight;
  }

  private async runEnumeration(): Promise<void> {
    try {
      const wslEnabled = state.settings?.current.hosts.wslEnabled ?? true;
      let rows: ReturnType<typeof parseWslList> = [];
      if (wslEnabled) {
        try {
          const { stdout } = await this.runWsl(['-l', '-v'], { kind: 'enum', host: 'all' });
          rows = parseWslList(stdout.toString('utf16le'));
        } catch {
          rows = [];
        }
      }
      this.distros = { at: Date.now(), rows };
      log('host', 'host-list', { detail: { count: rows.length, wsl: rows.length > 0 } });
      this.publish();
    } finally {
      const waiters = this.enumWaiters;
      this.enumWaiters = [];
      for (const wake of waiters) wake();
    }
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
          node: null,
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
    for (const { name, stopped } of this.enabledDistros()) {
      hosts.push(this.entryFor(name, stopped).host);
    }
    return hosts;
  }

  /** The cached enumeration reports the distro Stopped. Implicit work (probe,
   * env capture, background exec, UNC fs) must not touch it — any of those
   * boots the distro. */
  private enumStopped(id: HostId): boolean {
    return this.enumerate().some((row) => `wsl:${row.name}` === id && row.state === 'Stopped');
  }

  /** Public form of the Stopped check (autostart skips such hosts). */
  isStopped(id: HostId | string): boolean {
    return this.enumStopped(id as HostId);
  }

  /** Gate for recurring background WSL work: re-enumerates first when the
   * cached table is older than ENUM_FRESH_MS (`wsl -l -v` never boots a
   * distro; concurrent callers share the in-flight run), then fsReady. */
  async backgroundReady(host: ExecHost): Promise<boolean> {
    if (!isWslHost(host)) return true;
    if (!this.distros || Date.now() - this.distros.at >= enumFreshMs()) {
      await this.enumerateAsync();
    }
    return this.fsReady(host);
  }

  /** Enabled hosts plus every host we've seen this run — used by the hooks
   * opt-in so a disabled host still gets our block removed. */
  allHosts(): ExecHost[] {
    const seen = new Map<HostId, ExecHost>();
    for (const host of this.list()) seen.set(host.id, host);
    for (const entry of this.entries.values()) seen.set(entry.host.id, entry.host);
    return [LOCAL_HOST, ...[...seen.values()].filter((h) => h.id !== 'local')];
  }

  /** True when main-process fs may touch the host's config dir: local always,
   * a wsl host only once its probe is `ready` (UNC on a hung distro blocks). */
  fsReady(host: ExecHost): boolean {
    if (!isWslHost(host)) return true;
    // A stale `ready` entry outlives disabling or stopping the distro.
    if (this.enumStopped(host.id)) return false;
    if (!this.enabledDistros().some((d) => `wsl:${d.name}` === host.id)) return false;
    return isFsReady(host, this.entries.get(host.id)?.status.state);
  }

  /** fsReady without the enabled check: the hooks opt-out still removes our
   * block (it embeds the bearer token) from a disabled but running distro. */
  fsSafe(host: ExecHost): boolean {
    if (!isWslHost(host)) return true;
    if (this.enumStopped(host.id)) return false;
    return isFsReady(host, this.entries.get(host.id)?.status.state);
  }

  /** list() minus wsl hosts whose probe hasn't reached `ready` yet. */
  readyList(): ExecHost[] {
    return this.list().filter((h) => this.fsReady(h));
  }

  hostById(id: HostId | string): ExecHost | null {
    if (id === 'local') return LOCAL_HOST;
    return this.entries.get(id as HostId)?.host ?? null;
  }

  statuses(): HostStatus[] {
    const statuses: HostStatus[] = [localStatus()];
    const explicit = state.settings?.current.hosts.wslDistros ?? null;
    const enabled = new Set(this.enabledDistros().map((d) => d.name));
    for (const row of this.enumerate()) {
      if (!enabled.has(row.name)) {
        // Not enabled: an existing entry reports disabled (explicit list) or
        // stopped (auto mode); an unknown distro gets a bare status row so
        // Settings can list it with an unchecked box. Never probed.
        const entry = this.entries.get(`wsl:${row.name}` as HostId);
        if (entry) {
          statuses.push({
            ...entry.status,
            state: explicit !== null ? 'disabled' : 'stopped',
          });
        } else {
          statuses.push({
            id: `wsl:${row.name}`,
            kind: 'wsl',
            label: row.name,
            state: explicit !== null ? 'disabled' : 'stopped',
            error: null,
            probedAt: null,
            home: null,
            shell: null,
            node: null,
            claude: { path: null, version: null },
            devin: { path: null },
            shellEnv: null,
            hooks: 'untested',
            inotify: false,
            gh: false,
          });
        }
        continue;
      }
      const entry = this.entryFor(row.name, row.state === 'Stopped');
      // A distro stopped since its probe reports stopped, not its stale state.
      statuses.push(
        row.state === 'Stopped' && entry.status.state !== 'probing'
          ? { ...entry.status, state: 'stopped' }
          : entry.status,
      );
      // Lazily probe each enabled, running distro once per app run.
      if (row.state !== 'Stopped' && !entry.probed && !entry.probing) {
        void this.probe(entry);
      }
    }
    return statuses;
  }

  errors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, parts] of this.errorParts) {
      const joined = Object.values(parts).filter(Boolean).join(' \u00b7 ');
      if (joined) out[id] = joined;
    }
    return out;
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
      let helperPresent = false;
      try {
        // home / user / login shell in one sh call.
        const out = await this.execWsl(
          [
            '-d',
            distro,
            '-e',
            '/bin/sh',
            '-c',
            probeLine(helperBundle()?.hash ?? null),
          ],
          'probe',
          id,
        );
        const parsed = parseProbeOutput(out);
        helperPresent = parseHelperPresent(out);
        entry.host = { ...entry.host, home: overrides.home ?? parsed.home ?? null };
        entry.status = {
          ...entry.status,
          home: entry.host.home,
          shell: overrides.shell ?? parsed.shell ?? '/bin/bash',
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
        // Without a timestamp shellEnv() (via the execOn below) would wait on
        // this very probe.
        entry.envAt = Date.now();
        entry.status = { ...entry.status, shellEnv: null };
      } else {
        await this.captureEnv(entry, shell);
      }
      // CLI resolution under the captured PATH; settings overrides win.
      const resolve = async (bin: string): Promise<string | null> => {
        try {
          const out = await this.execWsl(['-d', distro, '-e', shell, '-ilc', `command -v ${bin}`], 'probe', id);
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
          const out = await this.execOn(
            entry.host,
            { file: claudePath, args: ['--version'], cwd: home },
            PROBE_TIMEOUT_MS,
            { explicit: true },
          );
          version = out.trim().split(/\s+/)[0] ?? null;
        } catch {
          version = null;
        }
      }
      const sdkTarget = sdkTargetCliVersion();
      if (claudePath && version && sdkTarget && version !== sdkTarget) {
        this.setPart(id, 'cli', `claude ${version} (SDK targets ${sdkTarget})`);
      } else if (!claudePath) {
        this.setPart(id, 'cli', 'Claude Code not found — set the path in Settings');
      } else {
        this.setPart(id, 'cli', null);
      }
      // Hook listener reachability: loopback first, then the WSL vEthernet
      // address for NAT-mode distros.
      const hooks = await this.probeHooks(entry);
      const helper = await this.prepareHelper(entry, helperPresent);
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
        ...(helper ? { helper } : {}),
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
      this.publish();
    });
    await entry.probing;
  }

  /**
   * Initial helper status from the env capture's node version plus, when the
   * bundle is absent from the distro, a stdin deploy (one wsl.exe run, no UNC).
   * Only reached from a probe the P0 gates allow (never boots a stopped
   * distro); unknown node (capture disabled/failed) stays eligible. Null = no
   * bundle ships.
   */
  private async prepareHelper(
    entry: WslEntry,
    present: boolean,
  ): Promise<NonNullable<HostStatus['helper']> | null> {
    const bundle = helperBundle();
    if (!bundle) return null;
    const { node, shellEnv } = entry.status;
    let derived = deriveHelperState({ envOk: shellEnv?.ok === true, node, present });
    const home = entry.host.home;
    if (derived === 'absent' && home && !this.enumStopped(entry.host.id)) {
      const t0 = Date.now();
      let ok = false;
      let bytes = 0;
      try {
        const data = await readFile(bundle.file);
        bytes = data.length;
        const spec = helperDeploySpec(entry.host, home, bundle.hash);
        await this.runWsl(spec.args, { kind: 'exec', host: entry.host.id, timeout: 30_000, input: data });
        ok = true;
      } catch {
        ok = false;
      }
      log('host', 'host-helper-deploy', { detail: { host: entry.host.id, ok, bytes, ms: Date.now() - t0 } });
      if (ok) derived = 'starting';
    }
    return { state: derived, watchMode: null };
  }

  /** §1.4 capture: `<shell> -ilc 'printf "\0__DW_ENV__\0"; env -0'`. */
  private async captureEnv(entry: WslEntry, shell: string): Promise<void> {
    const t0 = Date.now();
    const id = entry.host.id;
    try {
      // The node probe rides this same interactive-login spawn (nvm and
      // ~/.local/bin are only on a login PATH); node null = unknown when
      // capture is disabled or fails.
      const cmd =
        `printf "\\0${ENV_MARKER}\\0"; env -0; printf "\\0${NODE_MARKER}\\0"; ` +
        'command -v node >/dev/null && node -p process.versions.node || echo NONODE';
      // exit code ignored: an rc file may exit non-zero after printing.
      const { stdout } = await this.runWsl(
        ['-d', entry.host.distro, '-e', shell, '-ilc', cmd],
        { kind: 'env', host: id, requireSuccess: false },
      );
      const env = parseShellEnv(stdout, ENV_MARKER);
      if (env === null) {
        entry.env = null;
        entry.envAt = Date.now();
        entry.status = { ...entry.status, node: null, shellEnv: { ok: false, count: 0, ms: Date.now() - t0 } };
        this.setPart(id, 'env', 'shell environment unavailable — using the plain WSL environment');
        log('host', 'host-env', {
          detail: { host: id, ok: false, ms: Date.now() - t0, count: 0, reason: 'no-marker' },
        });
        return;
      }
      entry.env = env;
      entry.envAt = Date.now();
      entry.status = {
        ...entry.status,
        node: parseNodeVersion(stdout, NODE_MARKER),
        shellEnv: { ok: true, count: Object.keys(env).length, ms: Date.now() - t0 },
      };
      this.setPart(id, 'env', null);
      log('host', 'host-env', {
        detail: { host: id, ok: true, ms: Date.now() - t0, count: Object.keys(env).length },
      });
    } catch (error) {
      entry.env = null;
      entry.envAt = Date.now();
      entry.status = { ...entry.status, node: null, shellEnv: { ok: false, count: 0, ms: Date.now() - t0 } };
      this.setPart(id, 'env', 'shell environment unavailable — using the plain WSL environment');
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

  private async probeHooks(entry: WslEntry): Promise<'ok' | 'unreachable' | 'untested'> {
    const port = this.hookPort?.();
    if (!port) return 'untested';
    const curl = (addr: string) =>
      this.execWsl(
        [
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
          `http://${addr}:${port}${HOOK_HEALTH_PATH}`,
        ],
        'probe',
        entry.host.id,
      ).then((code) => ['200', '401', '404'].includes(code.trim()));
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
  /** Called at the start of an explicit refresh (hosts:refresh) — never on enumeration. */
  onExplicitRefresh: ((id?: HostId) => void) | null = null;

  /** The vEthernet address a NAT-mode host reaches the hook listener on. */
  hookAddrFor(id: string): string | null {
    return this.entries.get(id as HostId)?.hookAddr ?? null;
  }

  private setPart(id: string, part: HostErrorPart, message: string | null): void {
    const parts = this.errorParts.get(id) ?? {};
    if (message) parts[part] = message;
    else delete parts[part];
    if (Object.values(parts).some(Boolean)) this.errorParts.set(id, parts);
    else this.errorParts.delete(id);
  }

  /** Record or clear a per-host status line (hooks install, store errors). */
  setError(id: string, part: 'hooksInstall' | 'store', message: string | null): void {
    this.setPart(id, part, message);
  }

  // --- env + spawn -------------------------------------------------------------

  /** The cached §1.4 environment; re-captures when stale (call before spawns).
   * `explicit` = a user action (chat prompt, agent start) that may boot a
   * Stopped distro; otherwise a Stopped distro gets its cached env only. */
  async shellEnv(
    host: ExecHost,
    opts?: { explicit?: boolean },
  ): Promise<Record<string, string> | null> {
    if (!isWslHost(host)) return null;
    const entry = this.entries.get(host.id);
    if (!entry) return null;
    const stopped = this.enumStopped(host.id);
    if (!opts?.explicit && stopped) return entry.env;
    try {
      if (Date.now() - entry.envAt < ENV_CACHE_MS) return entry.env;
      if (!entry.probed && !entry.probing) await this.probe(entry);
      else if (entry.probing) await entry.probing;
      // The escape hatch: plain WSL environment, never a re-capture.
      if (this.overrides(host.id).envCaptureDisabled === true) return null;
      if (Date.now() - entry.envAt < ENV_CACHE_MS) return entry.env;
      await this.captureEnv(entry, entry.status.shell ?? '/bin/bash');
      return entry.env;
    } finally {
      // An explicit start just booted a Stopped distro: re-read the table so
      // its row (and every fsReady gate) flips to Running now, not in 5 min.
      if (stopped) void this.enumerateAsync();
    }
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
  /** spawnSpec/ptySpec hardcode `wsl.exe` — swap in the test-seam prefix. */
  private applyWslCmd(spec: { file: string; args: string[] }): { file: string; args: string[] } {
    if (spec.file !== 'wsl.exe') return spec;
    const wsl = this.wslCmd();
    if (!wsl) return spec;
    const [file, ...prefix] = wsl;
    return { file: file!, args: [...prefix, ...spec.args] };
  }

  spawnOn(host: ExecHost, cmd: HostCommand, opts?: { signal?: AbortSignal }): ChildProcess {
    const spec = spawnSpec(host, cmd, this.cachedEnv(host));
    const applied = this.applyWslCmd(spec);
    const t0 = Date.now();
    if (isWslHost(host)) log('host', 'host-exec', { detail: { host: host.id, kind: 'spawn' } });
    const child = spawn(applied.file, applied.args, {
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

  /** execFile-style run returning stdout (probes, agents, gh). Refuses a
   * Stopped distro unless `explicit` (see shellEnv). */
  async execOn(
    host: ExecHost,
    cmd: HostCommand,
    timeout = PROBE_TIMEOUT_MS,
    opts?: { explicit?: boolean },
  ): Promise<string> {
    if (isWslHost(host) && !opts?.explicit && this.enumStopped(host.id)) {
      throw new Error('distro is stopped');
    }
    await this.shellEnv(host, opts);
    const spec = spawnSpec(host, cmd, this.cachedEnv(host));
    const applied = this.applyWslCmd(spec);
    if (isWslHost(host)) log('host', 'host-exec', { detail: { host: host.id, kind: 'exec' } });
    const { stdout } = await execFileAsync(applied.file, applied.args, {
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
    const spec = ptySpec(host, cmd, shell);
    const applied = this.applyWslCmd(spec);
    if (isWslHost(host)) log('host', 'host-exec', { detail: { host: host.id, kind: 'spawn' } });
    return { file: applied.file, args: applied.args, cwd: spec.cwd };
  }

  // --- paths -------------------------------------------------------------------

  /** Windows-side path → host id; honours the test UNC root seam. */
  pathHostId(p: string): HostId {
    const root = testMode ? process.env.AGENT_WORKSPACE_TEST_WSL_UNC_ROOT : undefined;
    if (root && p.startsWith(root)) {
      const first = this.list().find((h) => h.kind === 'wsl');
      if (first) return first.id;
    }
    return coreHostIdForPath(p);
  }

  /** Windows-side path → host path (UNC root seam post-processes here). */
  hostPath(host: ExecHost, winPath: string): string {
    const root = testMode ? process.env.AGENT_WORKSPACE_TEST_WSL_UNC_ROOT : undefined;
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
    const root = testMode ? process.env.AGENT_WORKSPACE_TEST_WSL_UNC_ROOT : undefined;
    if (root && isWslHost(host)) {
      return out.replace(`\\\\wsl.localhost\\${host.distro}`, root);
    }
    return out;
  }

  /** The local host's Claude home as captured at startup — never the value a
   * `withConfigDir` swap has temporarily placed in `process.env`. */
  localConfigDir(): string {
    return this.localConfigDirValue;
  }

  configDir(host: ExecHost): string {
    if (!isWslHost(host)) return this.localConfigDirValue;
    const home = this.entries.get(host.id)?.host.home ?? this.overrides(host.id).home ?? null;
    return this.windowsPath(host, `${home ?? ''}/.claude`);
  }

  /** Serialised `CLAUDE_CONFIG_DIR` swap around an SDK store call (§1.2). The
   * swap is only ever observable through `process.env` (the SDK reads it);
   * `configDir()` keeps answering from the captured local value. */
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
    this.publish();
  }

  /** hosts:refresh — re-enumerate and re-probe. */
  async refresh(id?: string): Promise<void> {
    // Explicit only — enumerations and probes never call this.
    this.onExplicitRefresh?.(id as HostId | undefined);
    this.distros = null;
    await this.enumerateAsync();
    const targets = id
      ? [...this.entries.values()].filter((e) => e.host.id === id)
      : this.enabledDistros().map((d) => this.entryFor(d.name, d.stopped));
    const booted = targets.some((entry) => this.enumStopped(entry.host.id));
    for (const entry of targets) {
      entry.probed = false;
      await this.probe(entry);
    }
    // The explicit probe started a Stopped distro — re-read its state so the
    // cached row stops gating it.
    if (booted) {
      this.distros = null;
      await this.enumerateAsync();
    }
    // An explicit refresh always republishes, even when nothing changed, so
    // consumers retry work that failed earlier (e.g. the hooks write).
    this.lastPublished = null;
    this.publish();
  }

  /** `gh` invocation for a host: wsl → wsl.exe-wrapped with the captured env;
   * anything else → null (caller falls back to local gh resolution). */
  ghSpec(id: HostId): { cmd: string; args: string[] } | null {
    const entry = this.entries.get(id);
    // fsReady: never spawn into a disabled or Stopped distro (that boots it).
    if (!entry || !entry.status.gh || !isWslHost(entry.host) || !this.fsReady(entry.host)) {
      return null;
    }
    const wsl = this.wslCmd();
    if (!wsl) return null;
    const [file, ...prefix] = wsl;
    // The caller runs the returned spec — one wsl.exe invocation per call.
    log('host', 'host-exec', { detail: { host: id, kind: 'exec' } });
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
