// Execution host registry (main): enumerates `wsl.exe` distros into ExecHost
// records, probes each enabled host once per app run (home/shell/env capture/
// CLIs/hook reachability), and hands out spawn/pty/exec specs shaped by
// core/execHost. Remote hosts' files are reached only over the helper channel.
// Never logs env values or resolved paths.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { app } from 'electron';
import {
  hostIdForPath as coreHostIdForPath,
  mergeShellEnv,
  isFsReady,
  isSshHost,
  isWslHost,
  canonicalSshAlias,
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
  helperSpec,
  HELPER_MISSING_EXIT,
  sanitizeEnv,
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
import { HostChannel, type HelperStatus } from './hostChannel';
import { EnumerationCache, enumOutcome, helperSpawnGate } from '../core/hostEnum';
import { hooksOffSpawnError } from '../core/hooksOffBackoff';
import { wtDistroList } from '../core/windowsTerminal';
import { SshHosts, aliasHash as aliasHashOf } from './sshHosts';

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
  /** The helper channel, created on the first eligible start; owns status.helper while running. */
  channel: HostChannel | null;
  /** `env.get` of the live channel — cached for the channel's lifetime. */
  channelEnv: Record<string, string> | null;
  channelEnvInFlight: Promise<Record<string, string> | null> | null;
  /** The channel was stopped because the distro left Running/enabled; the next eligible sync resets the breaker. */
  channelHeld: boolean;
  /** The probe found the bundle on disk and this run has not (re)deployed it —
   * it may be a truncated file from an earlier run's interrupted deploy. */
  helperPreexisting: boolean;
}

function testNumber(name: string): number | null {
  if (!testMode) return null;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
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
    gh: true,
  };
  localStatusCache = { at: Date.now(), status };
  return status;
};

/** Every `wsl.exe` invocation logs `host-exec {host, kind}` so a soak can count them. */
type WslExecKind = 'enum' | 'probe' | 'env' | 'exec' | 'spawn' | 'helper';

type HostErrorPart = 'env' | 'cli' | 'hooksInstall' | 'store';

interface WslRun {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  /** Killed by the timeout (code may still be set on Windows). */
  timedOut: boolean;
}

export class HostsRegistry {
  private wsl: { file: string; args: string[] } | null | undefined;
  /** Resolves once the async `wsl.exe` lookup settles; awaited where the
   * binary is needed, never on the publish path. */
  private ready: Promise<void>;
  private readonly distros = new EnumerationCache<ReturnType<typeof parseWslList>[number]>(
    () => this.listDistros(),
    Date.now,
    (ok) => this.onEnumerated(ok),
    testNumber('AGENT_WORKSPACE_TEST_ENUM_BACKOFF_MS') ?? undefined,
  );
  private started = false;
  private quitting = false;
  private lastPublished: HostStatus[] | null = null;
  private enumWaiters: Array<() => void> = [];
  private entries = new Map<HostId, WslEntry>();
  private errorParts = new Map<string, Partial<Record<HostErrorPart, string>>>();
  /** The local Claude home, captured once at construction (ux3 S7: app code
   * never reads `process.env.CLAUDE_CONFIG_DIR` live). */
  private readonly localConfigDirValue: string;
  /** `ssh:<alias>` hosts from settings.hosts.ssh (P3). */
  private readonly ssh: SshHosts;

  constructor() {
    this.localConfigDirValue = resolveLocalConfigDir(process.env, homedir(), join);
    this.ready = this.resolveWsl();
    this.ssh = new SshHosts({
      publish: () => this.publish(),
      setPart: (id, part, message) => this.setPart(id, part, message),
      hookPort: () => this.hookPort?.() ?? null,
      bundle: () => helperBundle(),
      quitting: () => this.quitting,
      overrides: (id) => this.overrides(id),
    });
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
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
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
          resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, timedOut });
        });
      });
    });
  }

  private async execWsl(args: string[], kind: WslExecKind, host: string): Promise<string> {
    const { stdout } = await this.runWsl(args, { kind, host });
    return stdout.toString('utf8');
  }

  // --- enumeration -----------------------------------------------------------

  private installedLazy: string[] | null = null;
  private installedLazyTask: Promise<void> | null = null;
  private installedLazyFailedAt: number | null = null;

  /** Installed distro names for the Windows Terminal profile match
   * (`wtDistroList`): the enumeration while WSL is enabled; with WSL disabled
   * (the enumeration is empty by design) one lazy async `wsl -l -q` per run
   * (a failed one is retried after 5 minutes).
   * null = not known yet. Never spawns synchronously. */
  installedDistroNames(): string[] | null {
    const pick = wtDistroList({
      wslEnabled: state.settings?.current.hosts.wslEnabled ?? true,
      enumCompleted: this.distros.completed,
      enumNames: this.distros.rows.map((row) => row.name),
      lazyNames: this.installedLazy,
      lazyFailedAtMs: this.installedLazyFailedAt,
    });
    if (pick.needLazyList) {
      this.installedLazyTask ??= this.runWsl(['-l', '-q'], { kind: 'enum', host: 'all', requireSuccess: false }).then(
        ({ stdout }) => {
          this.installedLazyTask = null;
          // UTF-16LE; strip the BOM/NULs and the "(Default)"-style notes.
          this.installedLazy = stdout
            .toString('utf16le')
            .split(/[\r\n]+/)
            .map((line) => line.replace(/[^\x20-\x7E]/g, '').trim())
            .filter((line) => line.length > 0 && !line.startsWith('('));
        },
        () => {
          // Unknown, not empty: [] would hide every WT WSL profile for the run.
          this.installedLazyTask = null;
          this.installedLazyFailedAt = Date.now();
        },
      );
    }
    return pick.distros;
  }

  /** Cached distro rows ([] until the first async `-l -v` lands). Read paths
   * (statuses/list/enabledDistros) never spawn: enumeration runs at start, on
   * a 5-minute interval, on window focus once the cache is stale, and on
   * refresh(). */
  enumerate(): ReturnType<typeof parseWslList> {
    return this.distros.rows;
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
    if (!this.distros.isFresh(ENUM_CACHE_MS)) void this.enumerateAsync();
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
    if (this.distros.completed) return Promise.resolve();
    void this.enumerateAsync();
    return new Promise((resolveWait) => this.enumWaiters.push(resolveWait));
  }

  private enumerateAsync(): Promise<void> {
    return this.distros.refresh();
  }

  /** One `wsl -l -v`. Rejects only on a timeout or spawn error (the cache
   * keeps the previous rows and backs off); a prompt non-zero exit — no
   * distros installed, or the inbox stub without the WSL feature — is an
   * empty, successful list (`enumOutcome`; output text is never parsed). No
   * wsl.exe at all, or WSL disabled, is empty too. */
  private async listDistros(): Promise<ReturnType<typeof parseWslList>> {
    const wslEnabled = state.settings?.current.hosts.wslEnabled ?? true;
    if (!wslEnabled) return [];
    await this.ready;
    if (!this.wslCmd()) return [];
    const timeout = testNumber('AGENT_WORKSPACE_TEST_ENUM_TIMEOUT_MS') ?? PROBE_TIMEOUT_MS;
    const { stdout, code, timedOut } = await this.runWsl(['-l', '-v'], {
      kind: 'enum',
      host: 'all',
      timeout,
      requireSuccess: false,
    });
    const outcome = enumOutcome(timedOut ? null : code);
    if (outcome === 'failed') throw new Error('wsl -l -v timed out');
    return outcome === 'ok' ? parseWslList(stdout.toString('utf16le')) : [];
  }

  private onEnumerated(ok: boolean): void {
    try {
      this.applyEnumeration(ok);
    } catch (error) {
      log('host', 'host-list-error', { detail: { kind: error instanceof Error ? error.name : typeof error } });
    } finally {
      const waiters = this.enumWaiters;
      this.enumWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  private applyEnumeration(ok: boolean): void {
    const rows = this.distros.rows;
    log('host', 'host-list', { detail: { count: rows.length, wsl: rows.length > 0, ok } });
    // A failed list says nothing about the distros: running channels keep
    // running (their own liveness handles a dead VM) and nothing resets.
    if (ok) for (const entry of this.entries.values()) this.syncChannel(entry);
    this.publish();
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
          gh: false,
        },
        probed: false,
        probing: null,
        envAt: 0,
        env: null,
        hookAddr: null,
        channel: null,
        channelEnv: null,
        channelEnvInFlight: null,
        channelHeld: false,
        helperPreexisting: false,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Enabled ExecHosts: local first, then each enabled wsl distro, then each enabled ssh host. */
  list(): ExecHost[] {
    const hosts: ExecHost[] = [LOCAL_HOST];
    for (const { name, stopped } of this.enabledDistros()) {
      hosts.push(this.entryFor(name, stopped).host);
    }
    hosts.push(...this.ssh.list());
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

  /** Gate for background work that spawns its own `wsl.exe` (the gh PR-state
   * fallback): re-enumerates first when the cached table is older than
   * ENUM_FRESH_MS (`wsl -l -v` never boots a distro; concurrent callers share
   * the in-flight run), then fsReady. Work over the helper channel uses
   * fsReady alone — it never re-lists. */
  async backgroundReady(host: ExecHost): Promise<boolean> {
    if (isSshHost(host)) return this.fsReady(host);
    if (!isWslHost(host)) return true;
    await this.enumerateIfStale();
    return this.fsReady(host);
  }

  /** Re-runs `wsl -l -v` only when the cached table is older than
   * ENUM_FRESH_MS (a failed list stays inside its backoff). */
  async enumerateIfStale(): Promise<void> {
    if (!this.distros.isFresh(enumFreshMs())) await this.enumerateAsync();
  }

  /** Enabled hosts plus every host we've seen this run — used by the hooks
   * opt-in so a disabled host still gets our block removed. */
  allHosts(): ExecHost[] {
    const seen = new Map<HostId, ExecHost>();
    for (const host of this.list()) seen.set(host.id, host);
    for (const entry of this.entries.values()) seen.set(entry.host.id, entry.host);
    for (const host of this.ssh.all()) seen.set(host.id, host);
    return [LOCAL_HOST, ...[...seen.values()].filter((h) => h.id !== 'local')];
  }

  /** True when main-process work may reach the host: local always; a wsl
   * host only while its helper channel is `ready` (without a shipped bundle,
   * once its probe is `ready` — UNC on a hung distro blocks). */
  fsReady(host: ExecHost): boolean {
    if (isSshHost(host)) return this.ssh.fsReady(host.id);
    if (!isWslHost(host)) return true;
    // A stale `ready` entry outlives disabling or stopping the distro.
    if (this.enumStopped(host.id)) return false;
    if (!this.enabledDistros().some((d) => `wsl:${d.name}` === host.id)) return false;
    const entry = this.entries.get(host.id);
    if (helperAvailable()) return entry?.channel?.state === 'ready';
    return isFsReady(host, entry?.status.state);
  }

  /** fsReady without the enabled check: the hooks opt-out still removes our
   * block (it embeds the bearer token) from a disabled but running distro. */
  fsSafe(host: ExecHost): boolean {
    if (isSshHost(host)) return this.ssh.fsSafe(host.id);
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
    if (id.startsWith('ssh:')) return this.ssh.hostById(id);
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
    statuses.push(...this.ssh.statuses());
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
            probeLine(helperBundle()?.hash ?? null, overrides.home ?? null),
          ],
          'probe',
          id,
        );
        const parsed = parseProbeOutput(out);
        helperPresent = parseHelperPresent(out);
        // Only the first look counts: once a channel exists, any later deploy
        // was ours (size-gated), so a re-probe never re-flags the file.
        if (!helperPresent) entry.helperPreexisting = false;
        else if (!entry.channel) entry.helperPreexisting = true;
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
      // §1.4 shell environment capture (escape hatch: envCaptureDisabled). A
      // ready channel already holds the login env — re-read it, no -ilc spawn.
      if (overrides.envCaptureDisabled === true) {
        entry.env = null;
        entry.channelEnv = null;
        // Without a timestamp shellEnv() (via the execOn below) would wait on
        // this very probe.
        entry.envAt = Date.now();
        entry.status = { ...entry.status, shellEnv: null };
      } else if (entry.channel?.state === 'ready') {
        entry.channelEnv = null;
        await this.fetchChannelEnv(entry);
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
      // A running channel owns status.helper — a re-probe must not clobber it.
      const helper = entry.channel?.running ? null : await this.prepareHelper(entry, helperPresent);
      entry.status = {
        ...entry.status,
        state: 'ready',
        error: null,
        probedAt: new Date().toISOString(),
        claude: { path: claudePath, version },
        devin: { path: devinPath },
        hooks,
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
      this.syncChannel(entry);
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
    if (derived === 'absent' && (await this.deployHelper(entry))) derived = 'starting';
    return { state: derived, watchMode: null };
  }

  /** Stdin deploy of the bundle to `<home>/.agent-workspace/` (one wsl.exe
   * run, no UNC); also the channel's redeploy, which HostChannel runs only
   * after the fresh spawn gate (canSpawnHelper). Never on a Stopped distro. */
  private async deployHelper(entry: WslEntry): Promise<boolean> {
    const bundle = helperBundle();
    const home = entry.host.home;
    if (!bundle || !home || this.enumStopped(entry.host.id)) return false;
    const t0 = Date.now();
    let ok = false;
    let bytes = 0;
    try {
      const data = await readFile(bundle.file);
      bytes = data.length;
      const spec = helperDeploySpec(entry.host, home, bundle.hash, data.length);
      await this.runWsl(spec.args, { kind: 'exec', host: entry.host.id, timeout: 30_000, input: data });
      ok = true;
      entry.helperPreexisting = false;
    } catch {
      ok = false;
    }
    log('host', 'host-helper-deploy', { detail: { host: entry.host.id, ok, bytes, ms: Date.now() - t0 } });
    return ok;
  }

  // --- helper channel ------------------------------------------------------------

  /** The host's helper channel (null for local, before the first eligible start, or without a bundle). */
  channel(host: ExecHost): HostChannel | null {
    if (isSshHost(host)) return this.ssh.channel(host.id);
    if (!isWslHost(host)) return null;
    return this.entries.get(host.id)?.channel ?? null;
  }

  /**
   * Starts/stops the channel to match the distro: start only for an enabled
   * distro the enumeration reports Running, probed `ready` with a home, the
   * bundle shipped and node not missing/too old. Leaving Running/enabled →
   * stop() with no respawn; coming back → reset() (breaker closed). `reset`
   * forces the breaker closed (hosts:refresh).
   */
  private syncChannel(entry: WslEntry, opts: { reset?: boolean } = {}): void {
    const bundle = helperBundle();
    if (!bundle || this.quitting) return;
    const helperState = entry.status.helper?.state;
    const nodeBlocked = helperState === 'node-missing' || helperState === 'unsupported-node';
    if (!this.distroLive(entry) || nodeBlocked) {
      if (entry.channel) {
        if (entry.channel.running) entry.channel.stop(nodeBlocked ? 'stopped' : 'distro-unavailable');
        // Any channel — degraded included — resets when the distro is back.
        entry.channelHeld = true;
      }
      return;
    }
    if (!entry.probed || entry.status.state !== 'ready' || !entry.host.home) {
      // First start waits for the probe; a running channel rides out a re-probe.
      if (!entry.channel?.running) return;
    }
    entry.channel ??= this.createChannel(entry, bundle.hash);
    if (opts.reset || entry.channelHeld) {
      entry.channelHeld = false;
      entry.channel.reset();
    } else {
      entry.channel.start();
    }
  }

  /** Listed, enabled and Running in the cached enumeration. */
  private distroLive(entry: WslEntry): boolean {
    const id = entry.host.id;
    const running = this.enumerate().some((row) => `wsl:${row.name}` === id && row.state === 'Running');
    return running && this.enabledDistros().some((d) => `wsl:${d.name}` === id);
  }

  /** The channel's pre-spawn gate: a fresh `wsl -l -v` (never boots a distro)
   * — a helper killed by `wsl --terminate`/`--shutdown` must not respawn into
   * (and thereby boot) the stopped distro. A non-Running row holds the
   * channel until an enumeration reports it Running again (breaker reset); a
   * failed list refuses without holding (`helperSpawnGate`). */
  private async canSpawnHelper(entry: WslEntry): Promise<boolean> {
    if (this.quitting) return false;
    // Never an in-flight list that started before this request (it may
    // predate a `wsl --terminate`); a failed list refuses too.
    await this.distros.refreshFresh();
    if (this.quitting) return false;
    const gate = helperSpawnGate(this.distros.failed, this.distroLive(entry));
    if (gate.hold) entry.channelHeld = true;
    return gate.ok;
  }

  private createChannel(entry: WslEntry, hash: string): HostChannel {
    const silenceMs = testNumber('AGENT_WORKSPACE_TEST_HELPER_SILENCE_MS');
    const backoffMs = testNumber('AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS');
    const channel = new HostChannel(entry.host, () => this.spawnHelper(entry, hash), {
      ...(silenceMs !== null ? { silenceMs, killMs: silenceMs * 3 } : {}),
      backoffMs,
      redeploy: () => this.deployHelper(entry),
      canSpawn: () => this.canSpawnHelper(entry),
      bundlePreexisting: () => entry.helperPreexisting,
      expectedHash: hash,
      log: (event, detail) => log('host', event, { detail }),
    });
    channel.onState((status) => this.onChannelState(entry, channel, status));
    return channel;
  }

  private spawnHelper(entry: WslEntry, hash: string): ChildProcess {
    const home = entry.host.home;
    if (!home || !this.wslCmd()) throw new Error('helper launch unavailable');
    const spec = this.applyWslCmd(helperSpec(entry.host, home, entry.status.shell ?? '/bin/bash', hash));
    log('host', 'host-exec', { detail: { host: entry.host.id, kind: 'helper' } });
    // Windows process cwd: wsl.exe rejects a UNC cwd (--cd carries the linux one).
    return spawn(spec.file, spec.args, { cwd: homedir(), windowsHide: true, stdio: 'pipe' });
  }

  private onChannelState(entry: WslEntry, channel: HostChannel, status: HelperStatus): void {
    if (entry.channel !== channel || this.quitting) return;
    entry.status = { ...entry.status, helper: status };
    if (status.state === 'ready') void this.fetchChannelEnv(entry);
    else entry.channelEnv = null;
    this.publish();
  }

  /** `env.get` over a ready channel → the spawn env (WSL_ENV_DENYLIST applied); null on failure. */
  private fetchChannelEnv(entry: WslEntry): Promise<Record<string, string> | null> {
    const channel = entry.channel;
    if (!channel || channel.state !== 'ready') return Promise.resolve(null);
    // The escape hatch means the plain WSL environment — from env.get too.
    if (this.overrides(entry.host.id).envCaptureDisabled === true) return Promise.resolve(null);
    if (entry.channelEnv) return Promise.resolve(entry.channelEnv);
    entry.channelEnvInFlight ??= (async () => {
      const t0 = Date.now();
      try {
        const res = await channel.request<{ env?: unknown; watchMode?: unknown }>('env.get');
        if (entry.channel !== channel || channel.state !== 'ready') return null;
        const env = sanitizeEnv(res?.env);
        const count = Object.keys(env).length;
        entry.channelEnv = env;
        entry.status = { ...entry.status, shellEnv: { ok: true, count, ms: Date.now() - t0 } };
        this.setPart(entry.host.id, 'env', null);
        if (res?.watchMode === 'watch' || res?.watchMode === 'poll') channel.noteWatchMode(res.watchMode);
        log('host', 'host-env', { detail: { host: entry.host.id, ok: true, ms: Date.now() - t0, count, source: 'channel' } });
        this.publish();
        return env;
      } catch {
        log('host', 'host-env', { detail: { host: entry.host.id, ok: false, ms: Date.now() - t0, count: 0, source: 'channel' } });
        return null;
      } finally {
        entry.channelEnvInFlight = null;
      }
    })();
    return entry.channelEnvInFlight;
  }

  /** App quit: stdin EOF to every helper (each exits on it), kill after the grace. */
  async stopChannels(): Promise<void> {
    // Consumers are already disposed: the stop's state change must not
    // republish into them.
    this.quitting = true;
    const live = [...this.entries.values()].filter((e) => e.channel?.running);
    for (const entry of live) entry.channel!.stop();
    const sshChannels = this.ssh.stopChannels();
    // Give the EOFs a moment to land, then kill what is left: stop()'s grace
    // timer is unref'd and would not fire before the process exits.
    if (live.length || sshChannels.length) await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    // Every channel — one halted moments earlier still has its child in the grace.
    for (const entry of this.entries.values()) entry.channel?.killStopped();
    for (const channel of sshChannels) channel.killStopped();
  }

  /**
   * Hooks opt-out for a host whose channel is down — a distro disabled in the
   * app but still running (syncChannel stops its helper). One `wsl.exe` run of
   * the deployed bundle in `--apply-hooks-off` mode (same core/hooksApply.ts as
   * `hooks.apply`); re-reads the distro table first and never runs on a
   * Stopped distro. Exit 86 (bundle gone) → deploy once and retry.
   */
  async hooksOffOnce(host: ExecHost): Promise<{ ok: boolean; error: string | null }> {
    if (isSshHost(host)) return this.ssh.hooksOffOnce(host.id);
    if (!isWslHost(host) || this.quitting) return { ok: false, error: 'not a wsl host' };
    const entry = this.entries.get(host.id);
    const bundle = helperBundle();
    const home = entry?.host.home;
    if (!entry || !bundle || !home) return { ok: false, error: 'helper unavailable' };
    const helperState = entry.status.helper?.state;
    if (helperState === 'node-missing' || helperState === 'unsupported-node') {
      return { ok: false, error: 'node unavailable' };
    }
    await this.distros.refreshFresh();
    if (this.quitting || this.distros.failed || !this.fsSafe(host)) return { ok: false, error: 'distro unavailable' };
    const spec = helperSpec(entry.host, home, entry.status.shell ?? '/bin/bash', bundle.hash, '--apply-hooks-off');
    const run = () =>
      this.runWsl(spec.args, { kind: 'exec', host: host.id, timeout: 30_000, requireSuccess: false });
    try {
      let result = await run();
      if (result.code === HELPER_MISSING_EXIT && (await this.deployHelper(entry))) result = await run();
      const ok = result.code === 0;
      log('host', 'host-hooks-off', { detail: { host: host.id, ok, code: result.code } });
      return { ok, error: ok ? null : `hooks removal failed (exit ${result.code ?? 'unknown'})` };
    } catch (error) {
      log('host', 'host-hooks-off', { detail: { host: host.id, ok: false, code: null } });
      return { ok: false, error: hooksOffSpawnError(error) };
    }
  }

  /** Test hooks: kill the live helper / read the channel state. */
  killHelper(id: string): boolean {
    if (id.startsWith('ssh:')) return this.ssh.channel(id as HostId)?.kill() ?? false;
    return this.entries.get(id as HostId)?.channel?.kill() ?? false;
  }

  channelInfo(id: string): ReturnType<HostChannel['info']> | null {
    if (id.startsWith('ssh:')) return this.ssh.channel(id as HostId)?.info() ?? null;
    return this.entries.get(id as HostId)?.channel?.info() ?? null;
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

  /** The cached §1.4 environment (call before spawns).
   * `explicit` = a user action (chat prompt, agent start) that may boot a
   * Stopped distro; otherwise a Stopped distro gets its cached env only. */
  async shellEnv(
    host: ExecHost,
    opts?: { explicit?: boolean },
  ): Promise<Record<string, string> | null> {
    if (isSshHost(host)) return this.ssh.shellEnv(host.id);
    if (!isWslHost(host)) return null;
    const entry = this.entries.get(host.id);
    if (!entry) return null;
    const stopped = this.enumStopped(host.id);
    if (!opts?.explicit && stopped) return entry.env;
    // A ready channel's env.get is the login env for the channel's lifetime —
    // never a new -ilc capture spawn; the cached capture stays the fallback.
    if (!stopped && entry.channel?.state === 'ready') {
      if (this.overrides(host.id).envCaptureDisabled === true) return null;
      return (await this.fetchChannelEnv(entry)) ?? entry.env;
    }
    try {
      // Without a ready channel the probe's one -ilc capture is the env for
      // the run; it is never re-captured on a timer (`recheckEnv` is the
      // explicit user refresh). envAt > 0 also keeps the probe's own execOn
      // from waiting on itself.
      if (entry.envAt > 0) return entry.env;
      if (!entry.probed && !entry.probing) await this.probe(entry);
      else if (entry.probing) await entry.probing;
      // The escape hatch: plain WSL environment, never a capture.
      if (this.overrides(host.id).envCaptureDisabled === true) return null;
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
    const entry = this.entries.get(host.id);
    return entry?.channelEnv ?? entry?.env ?? null;
  }

  /** env refresh for `claude:recheckEnv` — re-reads env.get over a ready
   * channel, else forces a capture for the host. */
  async recheckEnv(id: string): Promise<void> {
    if (id.startsWith('ssh:')) return this.ssh.recheckEnv(id as HostId);
    const entry = this.entries.get(id as HostId);
    if (!entry) return;
    if (entry.channel?.state === 'ready') {
      entry.channelEnv = null;
      await this.fetchChannelEnv(entry);
      return;
    }
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
    // ssh: `cd <cwd> && exec /usr/bin/env <login env> …` over `ssh -T` (logs host-ssh + host-exec).
    const spec = isSshHost(host)
      ? { ...this.ssh.spawnSpec(host.id, cmd), cwd: null }
      : spawnSpec(host, cmd, this.cachedEnv(host));
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
    const spec = isSshHost(host)
      ? { ...this.ssh.spawnSpec(host.id, cmd), cwd: null }
      : spawnSpec(host, cmd, this.cachedEnv(host));
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
    if (isSshHost(host)) return { ...this.ssh.ptySpec(host.id, cmd), cwd: null };
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

  /** Existence check for a Windows-side path (picker start folder): local via
   * fs/promises, a WSL path as `fs.stat` over the host's helper channel —
   * never Windows-side fs on `\\wsl.localhost`. False while the channel is down. */
  async pathExists(winPath: string): Promise<boolean> {
    const id = this.pathHostId(winPath);
    if (id === 'local') {
      return access(winPath).then(
        () => true,
        () => false,
      );
    }
    const host = this.hostById(id);
    if (!host || host.kind === 'local' || !this.fsReady(host)) return false;
    const channel = this.channel(host);
    if (!channel) return false;
    try {
      const res = await channel.request<{ exists?: unknown } | null>('fs.stat', { path: this.hostPath(host, winPath) });
      return res?.exists === true;
    } catch {
      return false;
    }
  }

  /** The local host's Claude home, captured at construction. A remote host's
   * Claude home is only ever reached through its helper channel. */
  localConfigDir(): string {
    return this.localConfigDirValue;
  }

  // --- membership --------------------------------------------------------------

  /** hosts:setEnabled — the explicit wslDistros list is the source of truth. */
  setEnabled(id: string, enabled: boolean): void {
    if (id.startsWith('ssh:')) {
      const current = state.settings?.current.hosts.ssh ?? [];
      if (!current.some((h) => `ssh:${h.alias}` === id)) return;
      state.settings?.merge({
        hosts: { ssh: current.map((h) => (`ssh:${h.alias}` === id ? { ...h, enabled } : h)) },
      });
      this.ssh.sync();
      this.lastPublished = null;
      this.publish();
      return;
    }
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
    // A disabled distro's helper stops; a re-enabled one restarts (or its
    // lazy probe starts it).
    for (const entry of this.entries.values()) this.syncChannel(entry);
    this.publish();
  }

  /** hosts:refresh — re-enumerate and re-probe. */
  async refresh(id?: string): Promise<void> {
    // Explicit only — enumerations and probes never call this.
    this.onExplicitRefresh?.(id as HostId | undefined);
    if (id?.startsWith('ssh:')) {
      await this.ssh.refresh(id as HostId);
      this.lastPublished = null;
      this.publish();
      return;
    }
    if (id === undefined) await this.ssh.refresh();
    this.distros.invalidate();
    await this.distros.refreshFresh();
    const targets = id
      ? [...this.entries.values()].filter((e) => e.host.id === id)
      : this.enabledDistros().map((d) => this.entryFor(d.name, d.stopped));
    const booted = targets.some((entry) => this.enumStopped(entry.host.id));
    for (const entry of targets) {
      entry.probed = false;
      await this.probe(entry);
      // hosts:refresh closes the breaker (a degraded helper gets a fresh start).
      this.syncChannel(entry, { reset: true });
    }
    // The explicit probe started a Stopped distro — re-read its state so the
    // cached row stops gating it.
    if (booted) {
      this.distros.invalidate();
      await this.distros.refreshFresh();
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

  // --- ssh membership (P3) ------------------------------------------------------

  /** hosts:sshAdd — validates + canonicalises (lower-case) the alias; an
   * existing alias is re-enabled. The probe runs on the next status read. */
  addSshHost(input: string): { ok: true; id: HostId } | { ok: false; error: string } {
    const alias = canonicalSshAlias(input);
    if (!alias) {
      return {
        ok: false,
        error:
          'Invalid SSH alias — use a Host name from ~/.ssh/config (letters, digits, ".", "_", "-"; not starting with "-")',
      };
    }
    const current = state.settings?.current.hosts.ssh ?? [];
    const known = current.some((h) => h.alias === alias);
    if (!known && current.length >= 50) return { ok: false, error: 'Too many SSH hosts (50 max)' };
    const next = known
      ? current.map((h) => (h.alias === alias ? { ...h, enabled: true } : h))
      : [...current, { alias, enabled: true }];
    state.settings?.merge({ hosts: { ssh: next } });
    log('host', 'host-ssh', { detail: { aliasHash: aliasHashOf(alias), op: 'add' } });
    this.ssh.sync();
    this.lastPublished = null;
    this.publish();
    return { ok: true, id: `ssh:${alias}` };
  }

  /** hosts:sshRemove — drops the entry and stops its helper. */
  removeSshHost(id: string): void {
    const current = state.settings?.current.hosts.ssh ?? [];
    const next = current.filter((h) => `ssh:${h.alias}` !== id);
    if (next.length === current.length) return;
    state.settings?.merge({ hosts: { ssh: next } });
    log('host', 'host-ssh', { detail: { aliasHash: aliasHashOf(id.slice(4)), op: 'remove' } });
    this.ssh.sync();
    this.lastPublished = null;
    this.publish();
  }

  // --- test seams ---------------------------------------------------------------

  /** Test hooks: status rows and env key names (never values). */
  status(id: string): HostStatus | null {
    if (id.startsWith('ssh:')) return this.ssh.status(id as HostId);
    return this.entries.get(id as HostId)?.status ?? null;
  }

  shellEnvKeys(id: string): string[] {
    if (id.startsWith('ssh:')) return this.ssh.envKeys(id as HostId);
    const entry = this.entries.get(id as HostId);
    return Object.keys(entry?.channelEnv ?? entry?.env ?? {}).sort();
  }
}

let registry: HostsRegistry | null = null;

export function hosts(): HostsRegistry {
  registry ??= new HostsRegistry();
  return registry;
}
