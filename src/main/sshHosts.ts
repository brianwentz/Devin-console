// SSH execution hosts (P3): `ssh:<alias>` for each enabled `settings.hosts.ssh`
// entry. Same helper + protocol as WSL, reached over `ssh.exe -T <alias>`
// instead of `wsl.exe -d D`: one probe run (home / shell / helper presence),
// one interactive-login run (env, node, CLIs), a stdin deploy when the bundle
// is absent, then a long-lived HostChannel. There is no enumeration: a
// configured, enabled host is eligible; a connection failure (ssh exit 255)
// is a failed start, so the channel's backoff/breaker bounds the retries.
//
// Fix round 1 (R35):
// - Hooks: the listener's reverse forward is its OWN connection
//   (`ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:<p>:127.0.0.1:<p>`), with
//   its own backoff, and is trusted only after a challenge: a remote `curl`
//   fetches `<prefix>health?nonce=<n>` and the answer must be
//   HMAC-SHA256(token, nonce). Unverified → no hook injection into ssh ptys, no
//   hooks block in the remote settings.json, HostStatus.hooks 'unreachable'.
// - Secrets never ride an argv: spawns get the app's extra env as the first
//   stdin line, ptys from a 0600 file the helper staged (`env.stage`).
// - Recovery: connection-class failures (exit 255 / timeout) re-probe / reset
//   on resume, unlock, focus (≤1/min) and every 5 minutes.
// - ssh.exe is spawned by absolute path (never a bare-name search).
//
// Logging: the alias never reaches the log. Every ssh.exe invocation logs
// `host-ssh {aliasHash, op}` + `host-exec {host, kind}` with the id scrubbed to
// `ssh:#<aliasHash>` by log() (core/sshLog.ts), as is every other detail.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  deriveHelperState,
  HELPER_DIR,
  HELPER_MISSING_EXIT,
  parseHelperPresent,
  parseProbeOutput,
  parseSshEnvProbe,
  sanitizeEnv,
  sshCommandSpec,
  sshEnvLine,
  sshEnvSpec,
  sshFailureClass,
  sshForwardSpec,
  sshHelperDeploySpec,
  sshHelperSpec,
  sshHost,
  sshProbeSpec,
  sshPtySpec,
  sshRecoveryDue,
  sshSpawnSpec,
  type ExecHost,
  type HostCommand,
  type HostId,
  type HostSpawnSpec,
} from '../core/execHost';
import type { HostStatus, Settings } from '../shared/ipc';
import { HostChannel, type HelperStatus } from './hostChannel';
import type { HelperBundleInfo } from './helperBundle';
import { log, sshAliasHash } from './log';
import { sdkTargetCliVersion } from './claude/sdk';
import { newChallengeNonce, verifyChallengeMac } from './claude/hookChallenge';
import { state, testMode } from './state';
import { HOOK_PATH_PREFIX } from '../core/claudeHooks';

const execFileAsync = promisify(execFile);

type SshHost = Extract<ExecHost, { kind: 'ssh' }>;
type ErrorPart = 'env' | 'cli' | 'hooksInstall' | 'store' | 'hooks';
/** `host-ssh` op enum. */
export type SshOp =
  | 'probe'
  | 'env'
  | 'deploy'
  | 'helper'
  | 'hooks-off'
  | 'forward'
  | 'challenge'
  | 'exec'
  | 'spawn'
  | 'pty';

const PROBE_TIMEOUT_MS = 20_000;
/** ssh exits 255 when the connection itself failed (auth, DNS, refused, host key, forward refused). */
export const SSH_CONNECTION_FAILED = 255;
const HOOK_HEALTH_PATH = `${HOOK_PATH_PREFIX}health`;
/** Hook-forward restart delays after consecutive failures. */
const FORWARD_BACKOFF_MS = [10_000, 60_000, 300_000];
const RECOVERY_INTERVAL_MS = 5 * 60_000;

export const FORWARD_FAILED_MESSAGE =
  'Hooks unavailable: the hook port could not be forwarded to this host (taken on the remote, or the connection failed)';
export const FORWARD_UNVERIFIED_MESSAGE =
  'Hooks unavailable: the forwarded hook port did not answer for this app (is curl installed on the host?)';

/** sha256-8 of the canonical alias — the only form of an alias in the log. */
export const aliasHash = sshAliasHash;

/** csh/tcsh can't run the helper launch line (`test … || exit 86`, `"$0"`). */
export function unsupportedSshShell(shell: string | null): boolean {
  const base = (shell ?? '').split('/').pop() ?? '';
  return base === 'csh' || base === 'tcsh';
}

export const UNSUPPORTED_SHELL_MESSAGE =
  'csh/tcsh login shells are not supported — set a POSIX shell (bash, zsh, sh) or fish under Overrides → Shell';

export interface SshContext {
  publish(): void;
  setPart(id: string, part: ErrorPart, message: string | null): void;
  hookPort(): number | null;
  hookToken(): string | null;
  bundle(): HelperBundleInfo | null;
  quitting(): boolean;
  overrides(id: HostId): NonNullable<Settings['hosts']['overrides'][string]>;
}

interface Forward {
  child: ChildProcess | null;
  port: number;
  verified: boolean;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bumped on every (re)start/stop so a stale verification never lands. */
  seq: number;
}

interface SshEntry {
  host: SshHost;
  hash: string;
  status: HostStatus;
  probed: boolean;
  probing: Promise<void> | null;
  /** Class of the last probe failure (recovery retries 'connection' only). */
  probeFailure: 'connection' | 'other' | null;
  /** Class of the last helper child exit before hello / while not ready. */
  helperFailure: 'connection' | 'other' | null;
  /** The probe's interactive-login capture (status counts only). */
  env: Record<string, string> | null;
  channel: HostChannel | null;
  channelEnv: Record<string, string> | null;
  channelEnvInFlight: Promise<Record<string, string> | null> | null;
  helperPreexisting: boolean;
  /** The channel was stopped because the host was disabled; re-enabling resets the breaker. */
  held: boolean;
  forward: Forward | null;
}

interface SshRun {
  stdout: Buffer;
  code: number | null;
  timedOut: boolean;
}

const configured = (): Settings['hosts']['ssh'] => state.settings?.current.hosts.ssh ?? [];

/** Windows: the first absolute `where.exe ssh.exe` line, else %SystemRoot%\System32\OpenSSH\ssh.exe — never a bare name (cwd search hijack). */
async function resolveWindowsSsh(): Promise<string | null> {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  try {
    const { stdout } = await execFileAsync(join(systemRoot, 'System32', 'where.exe'), ['ssh.exe'], { windowsHide: true });
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^[A-Za-z]:\\/.test(l));
    if (first) return first;
  } catch {
    // fall through to the inbox client
  }
  const inbox = join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
  return existsSync(inbox) ? inbox : null;
}

export class SshHosts {
  private entries = new Map<HostId, SshEntry>();
  private sshCmd: string[] | null | undefined;
  private readonly sshReady: Promise<void>;
  private lastRecoveryAt: number | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: SshContext) {
    this.sshReady = this.resolveSsh();
  }

  private async resolveSsh(): Promise<void> {
    const override = testMode ? process.env.AGENT_WORKSPACE_TEST_SSH_CMD?.trim() : '';
    if (override) {
      this.sshCmd = override.split(/\s+/).filter(Boolean);
      return;
    }
    if (process.platform !== 'win32') {
      this.sshCmd = ['/usr/bin/ssh'];
      return;
    }
    const found = await resolveWindowsSsh();
    this.sshCmd = found ? [found] : null;
  }

  /** core spec (`ssh.exe …`) → the resolved command (test seam prefix included). */
  private apply(spec: HostSpawnSpec): { file: string; args: string[] } {
    if (!this.sshCmd) throw new Error('OpenSSH client (ssh.exe) not found');
    return { file: this.sshCmd[0]!, args: [...this.sshCmd.slice(1), ...spec.args] };
  }

  private note(entry: SshEntry, op: SshOp, kind: string): void {
    log('host', 'host-ssh', { detail: { aliasHash: entry.hash, op } });
    log('host', 'host-exec', { detail: { host: entry.host.id, kind } });
  }

  private run(
    entry: SshEntry,
    spec: HostSpawnSpec,
    op: SshOp,
    opts: { timeout?: number; input?: Buffer } = {},
  ): Promise<SshRun> {
    return this.sshReady.then(
      () =>
        new Promise<SshRun>((resolveRun, reject) => {
          let cmd: { file: string; args: string[] };
          try {
            cmd = this.apply(spec);
          } catch (error) {
            reject(error);
            return;
          }
          this.note(entry, op, op === 'deploy' || op === 'hooks-off' ? 'exec' : op === 'env' ? 'env' : 'probe');
          const child = spawn(cmd.file, cmd.args, {
            stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          if (opts.input) {
            child.stdin!.on('error', () => undefined);
            child.stdin!.end(opts.input);
          }
          const out: Buffer[] = [];
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeout ?? PROBE_TIMEOUT_MS);
          timer.unref?.();
          child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
          // stderr can carry banners/host names — drained, never kept.
          child.stderr!.resume();
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            resolveRun({ stdout: Buffer.concat(out), code, timedOut });
          });
        }),
    );
  }

  // --- membership -----------------------------------------------------------

  private entryFor(alias: string): SshEntry {
    const host = sshHost(alias) as SshHost;
    let entry = this.entries.get(host.id);
    if (!entry) {
      entry = {
        host,
        hash: aliasHash(host.alias),
        status: {
          id: host.id,
          kind: 'ssh',
          label: host.alias,
          state: 'probing',
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
        probeFailure: null,
        helperFailure: null,
        env: null,
        channel: null,
        channelEnv: null,
        channelEnvInFlight: null,
        helperPreexisting: false,
        held: false,
        forward: null,
      };
      this.entries.set(host.id, entry);
    }
    return entry;
  }

  private isEnabled(id: HostId): boolean {
    return configured().some((h) => `ssh:${h.alias}` === id && h.enabled);
  }

  private isConfigured(id: HostId): boolean {
    return configured().some((h) => `ssh:${h.alias}` === id);
  }

  /** Enabled ssh hosts in settings order. */
  list(): ExecHost[] {
    return configured()
      .filter((h) => h.enabled)
      .map((h) => this.entryFor(h.alias).host);
  }

  /** Every ssh host seen this run (hooks opt-out cleans disabled ones too). */
  all(): ExecHost[] {
    return [...this.entries.values()].map((e) => e.host);
  }

  hostById(id: string): ExecHost | null {
    if (!id.startsWith('ssh:')) return null;
    const known = this.entries.get(id as HostId);
    if (known) return known.host;
    const alias = id.slice(4);
    return this.isConfigured(id as HostId) ? this.entryFor(alias).host : null;
  }

  /** Status rows for every configured host; lazily probes enabled ones once
   * per run and keeps channels matched to settings. Never spawns otherwise. */
  statuses(): HostStatus[] {
    const rows: HostStatus[] = [];
    for (const { alias, enabled } of configured()) {
      const entry = this.entryFor(alias);
      if (!enabled) {
        rows.push({ ...entry.status, state: 'disabled' });
        continue;
      }
      rows.push(entry.status);
      if (!entry.probed && !entry.probing) void this.probe(entry);
    }
    this.syncChannels();
    this.ensureRecoveryTimer();
    return rows;
  }

  // --- probe --------------------------------------------------------------------

  private async probe(entry: SshEntry): Promise<void> {
    if (entry.probing) return entry.probing;
    entry.status = { ...entry.status, state: 'probing' };
    const t0 = Date.now();
    const id = entry.host.id;
    entry.probing = (async () => {
      const overrides = this.ctx.overrides(id);
      const bundle = this.ctx.bundle();
      let present = false;
      try {
        let r: SshRun;
        try {
          r = await this.run(entry, sshProbeSpec(entry.host.alias, bundle?.hash ?? null, overrides.home ?? null), 'probe');
        } catch (error) {
          entry.probeFailure = 'other';
          throw error;
        }
        entry.probeFailure = r.code === 0 && !r.timedOut ? null : sshFailureClass(r);
        if (r.timedOut) throw new Error('ssh probe timed out');
        if (r.code === SSH_CONNECTION_FAILED) {
          throw new Error('ssh connection failed (exit 255) — check the alias, key/agent auth and the host key (BatchMode)');
        }
        if (r.code !== 0) throw new Error(`ssh probe exited ${r.code ?? 'unknown'}`);
        const out = r.stdout.toString('utf8');
        const parsed = parseProbeOutput(out);
        present = parseHelperPresent(out);
        if (!present) entry.helperPreexisting = false;
        else if (!entry.channel) entry.helperPreexisting = true;
        const home = overrides.home ?? parsed.home ?? null;
        entry.host = { ...entry.host, home: home && home.startsWith('/') ? home : null };
        entry.status = {
          ...entry.status,
          home: entry.host.home,
          shell: overrides.shell ?? parsed.shell ?? '/bin/sh',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.status = { ...entry.status, state: 'error', error: message.slice(0, 200), probedAt: new Date().toISOString() };
        entry.probed = true;
        log('host', 'host-probe', { detail: { host: id, ok: false, ms: Date.now() - t0, failure: entry.probeFailure } });
        return;
      }
      const shell = entry.status.shell ?? '/bin/sh';
      if (unsupportedSshShell(shell)) {
        entry.probeFailure = 'other';
        entry.status = {
          ...entry.status,
          state: 'error',
          error: UNSUPPORTED_SHELL_MESSAGE,
          probedAt: new Date().toISOString(),
        };
        entry.probed = true;
        log('host', 'host-probe', { detail: { host: id, ok: false, ms: Date.now() - t0, reason: 'shell' } });
        return;
      }
      let claudePath: string | null = overrides.claudePath ?? null;
      let devinPath: string | null = overrides.devinPath ?? null;
      let gh = false;
      let version: string | null = null;
      if (overrides.envCaptureDisabled === true) {
        entry.env = null;
        entry.status = { ...entry.status, shellEnv: null, node: null };
      } else {
        const tEnv = Date.now();
        try {
          const r = await this.run(entry, sshEnvSpec(entry.host.alias, shell), 'env');
          const probe = parseSshEnvProbe(r.stdout);
          entry.env = probe.env;
          entry.status = {
            ...entry.status,
            node: probe.node,
            shellEnv: { ok: probe.env !== null, count: Object.keys(probe.env ?? {}).length, ms: Date.now() - tEnv },
          };
          claudePath ??= probe.claude;
          devinPath ??= probe.devin;
          gh = probe.gh;
          version = probe.version;
          this.ctx.setPart(id, 'env', probe.env ? null : 'shell environment unavailable over ssh');
          log('host', 'host-env', {
            detail: { host: id, ok: probe.env !== null, ms: Date.now() - tEnv, count: Object.keys(probe.env ?? {}).length },
          });
        } catch {
          entry.env = null;
          entry.status = { ...entry.status, node: null, shellEnv: { ok: false, count: 0, ms: Date.now() - tEnv } };
          this.ctx.setPart(id, 'env', 'shell environment unavailable over ssh');
          log('host', 'host-env', { detail: { host: id, ok: false, ms: Date.now() - tEnv, count: 0 } });
        }
      }
      const sdkTarget = sdkTargetCliVersion();
      if (!claudePath) this.ctx.setPart(id, 'cli', 'Claude Code not found — set the path in Settings');
      else if (version && sdkTarget && version !== sdkTarget) {
        this.ctx.setPart(id, 'cli', `claude ${version} (SDK targets ${sdkTarget})`);
      } else this.ctx.setPart(id, 'cli', null);
      const helper = entry.channel?.running ? null : await this.prepareHelper(entry, present);
      entry.status = {
        ...entry.status,
        state: 'ready',
        error: null,
        probedAt: new Date().toISOString(),
        claude: { path: claudePath, version },
        devin: { path: devinPath },
        gh,
        ...(helper ? { helper } : {}),
      };
      entry.probed = true;
      log('host', 'host-probe', {
        detail: { host: id, ok: true, ms: Date.now() - t0, claude: claudePath !== null, devin: devinPath !== null },
      });
    })().finally(() => {
      entry.probing = null;
      this.ctx.publish();
      this.syncChannel(entry);
    });
    await entry.probing;
  }

  private async prepareHelper(entry: SshEntry, present: boolean): Promise<HelperStatus | null> {
    if (!this.ctx.bundle()) return null;
    const { node, shellEnv } = entry.status;
    let derived = deriveHelperState({ envOk: shellEnv?.ok === true, node, present });
    if (derived === 'absent' && (await this.deploy(entry))) derived = 'starting';
    return { state: derived, watchMode: null };
  }

  private async deploy(entry: SshEntry): Promise<boolean> {
    const bundle = this.ctx.bundle();
    const home = entry.host.home;
    if (!bundle || !home || this.ctx.quitting()) return false;
    const t0 = Date.now();
    let ok = false;
    let bytes = 0;
    try {
      const data = await readFile(bundle.file);
      bytes = data.length;
      const r = await this.run(entry, sshHelperDeploySpec(entry.host.alias, home, bundle.hash, data.length), 'deploy', {
        timeout: 60_000,
        input: data,
      });
      ok = r.code === 0 && !r.timedOut;
      if (ok) entry.helperPreexisting = false;
    } catch {
      ok = false;
    }
    log('host', 'host-helper-deploy', { detail: { host: entry.host.id, ok, bytes, ms: Date.now() - t0 } });
    return ok;
  }

  // --- channel ------------------------------------------------------------------

  channel(id: HostId): HostChannel | null {
    return this.entries.get(id)?.channel ?? null;
  }

  private syncChannels(): void {
    for (const entry of this.entries.values()) this.syncChannel(entry);
  }

  /** Start for a configured, enabled, probed host with a home and node; a
   * removed/disabled host's channel (and hook forward) stops (no respawn). */
  private syncChannel(entry: SshEntry, opts: { reset?: boolean } = {}): void {
    const bundle = this.ctx.bundle();
    if (!bundle || this.ctx.quitting()) return;
    const helperState = entry.status.helper?.state;
    const nodeBlocked = helperState === 'node-missing' || helperState === 'unsupported-node';
    if (!this.isEnabled(entry.host.id) || nodeBlocked) {
      if (entry.channel) {
        if (entry.channel.running) entry.channel.stop(nodeBlocked ? 'stopped' : 'distro-unavailable');
        entry.held = true;
      }
      this.stopForward(entry);
      return;
    }
    if (!entry.probed || entry.status.state !== 'ready' || !entry.host.home) {
      if (!entry.channel?.running) return;
    }
    entry.channel ??= this.createChannel(entry, bundle.hash);
    if (opts.reset || entry.held) {
      entry.held = false;
      entry.channel.reset();
    } else entry.channel.start();
  }

  private createChannel(entry: SshEntry, hash: string): HostChannel {
    const silence = testNumber('AGENT_WORKSPACE_TEST_HELPER_SILENCE_MS');
    const backoffMs = testNumber('AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS');
    const channel = new HostChannel(entry.host, () => this.spawnHelper(entry, hash), {
      ...(silence !== null ? { silenceMs: silence, killMs: silence * 3 } : {}),
      backoffMs,
      redeploy: () => this.deploy(entry),
      // No enumeration for ssh: configured + enabled is the whole gate. A dead
      // network surfaces as a failed start (exit 255) → backoff → breaker;
      // recover() resets a connection-class breaker later.
      canSpawn: () => Promise.resolve(!this.ctx.quitting() && this.isEnabled(entry.host.id)),
      bundlePreexisting: () => entry.helperPreexisting,
      expectedHash: hash,
      log: (event, detail) => log('host', event, { detail }),
    });
    channel.onState((status) => this.onChannelState(entry, channel, status));
    return channel;
  }

  private spawnHelper(entry: SshEntry, hash: string): ChildProcess {
    const home = entry.host.home;
    if (!home) throw new Error('helper launch unavailable');
    const { file, args } = this.apply(sshHelperSpec(entry.host.alias, home, entry.status.shell ?? '/bin/sh', hash));
    this.note(entry, 'helper', 'helper');
    const child = spawn(file, args, { cwd: homedir(), windowsHide: true, stdio: 'pipe' });
    // Classify why a helper that never got ready went away (recovery input):
    // 255 = connection; a kill (hello timeout / silence) = timeout-class too.
    child.once('exit', (code) => {
      if (entry.channel?.state === 'ready') return;
      entry.helperFailure = sshFailureClass({ code, timedOut: code === null });
    });
    return child;
  }

  private onChannelState(entry: SshEntry, channel: HostChannel, status: HelperStatus): void {
    if (entry.channel !== channel || this.ctx.quitting()) return;
    entry.status = { ...entry.status, helper: status };
    if (status.state === 'ready') {
      entry.helperFailure = null;
      void this.fetchChannelEnv(entry);
      this.ensureForward(entry);
    } else entry.channelEnv = null;
    this.ctx.publish();
  }

  private fetchChannelEnv(entry: SshEntry): Promise<Record<string, string> | null> {
    const channel = entry.channel;
    if (!channel || channel.state !== 'ready') return Promise.resolve(null);
    if (this.ctx.overrides(entry.host.id).envCaptureDisabled === true) return Promise.resolve(null);
    if (entry.channelEnv) return Promise.resolve(entry.channelEnv);
    entry.channelEnvInFlight ??= (async () => {
      const t0 = Date.now();
      try {
        const res = await channel.request<{ env?: unknown; watchMode?: unknown }>('env.get');
        if (entry.channel !== channel || channel.state !== 'ready') return null;
        const env = sanitizeEnv(res?.env);
        entry.channelEnv = env;
        entry.status = { ...entry.status, shellEnv: { ok: true, count: Object.keys(env).length, ms: Date.now() - t0 } };
        this.ctx.setPart(entry.host.id, 'env', null);
        if (res?.watchMode === 'watch' || res?.watchMode === 'poll') channel.noteWatchMode(res.watchMode);
        log('host', 'host-env', {
          detail: { host: entry.host.id, ok: true, ms: Date.now() - t0, count: Object.keys(env).length, source: 'channel' },
        });
        this.ctx.publish();
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

  // --- hook forward (fix round 1 #1) ----------------------------------------------

  /** Hook URLs / pty injection for this host are allowed only while true. */
  forwardVerified(id: HostId): boolean {
    const entry = this.entries.get(id);
    return Boolean(entry?.forward?.verified && entry.forward.child && this.isEnabled(id));
  }

  private setHooks(entry: SshEntry, hooks: HostStatus['hooks'], message: string | null): void {
    this.ctx.setPart(entry.host.id, 'hooks', message);
    if (entry.status.hooks === hooks) {
      this.ctx.publish();
      return;
    }
    entry.status = { ...entry.status, hooks };
    this.ctx.publish();
  }

  private ensureForward(entry: SshEntry): void {
    const port = this.ctx.hookPort();
    if (!port || this.ctx.quitting() || !this.isEnabled(entry.host.id)) return;
    const fwd = entry.forward;
    if (fwd && fwd.port === port && (fwd.child || fwd.timer)) return;
    if (fwd) this.stopForward(entry);
    entry.forward = { child: null, port, verified: false, failures: fwd?.port === port ? fwd.failures : 0, timer: null, seq: 0 };
    this.startForward(entry);
  }

  private startForward(entry: SshEntry): void {
    const fwd = entry.forward;
    if (!fwd || this.ctx.quitting() || !this.isEnabled(entry.host.id)) return;
    fwd.timer = null;
    const seq = ++fwd.seq;
    let cmd: { file: string; args: string[] };
    try {
      cmd = this.apply(sshForwardSpec(entry.host.alias, fwd.port));
    } catch {
      this.setHooks(entry, 'unreachable', FORWARD_FAILED_MESSAGE);
      return;
    }
    this.note(entry, 'forward', 'forward');
    const child = spawn(cmd.file, cmd.args, { cwd: homedir(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr!.resume();
    fwd.child = child;
    fwd.verified = false;
    const ended = (code: number | null): void => {
      if (fwd.seq !== seq || entry.forward !== fwd) return;
      fwd.child = null;
      fwd.verified = false;
      fwd.failures++;
      log('host', 'host-ssh-forward', { detail: { host: entry.host.id, state: 'down', code, failures: fwd.failures } });
      this.setHooks(entry, 'unreachable', FORWARD_FAILED_MESSAGE);
      this.scheduleForward(entry);
    };
    child.once('error', () => ended(null));
    child.once('exit', (code) => ended(code));
    log('host', 'host-ssh-forward', { detail: { host: entry.host.id, state: 'starting' } });
    void this.verifyForward(entry, fwd, seq);
  }

  private scheduleForward(entry: SshEntry): void {
    const fwd = entry.forward;
    if (!fwd || fwd.timer || this.ctx.quitting() || !this.isEnabled(entry.host.id)) return;
    const override = testNumber('AGENT_WORKSPACE_TEST_SSH_FORWARD_BACKOFF_MS');
    const delay = override ?? FORWARD_BACKOFF_MS[Math.min(fwd.failures, FORWARD_BACKOFF_MS.length) - 1] ?? FORWARD_BACKOFF_MS[0]!;
    fwd.timer = setTimeout(() => this.startForward(entry), delay);
    fwd.timer.unref?.();
  }

  /** The challenge: a remote curl through the forward must return HMAC(token, nonce). A few tries while the forward comes up. */
  private async verifyForward(entry: SshEntry, fwd: Forward, seq: number): Promise<void> {
    const token = this.ctx.hookToken();
    const stale = (): boolean => fwd.seq !== seq || entry.forward !== fwd || !fwd.child;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, attempt === 0 ? 500 : 1_500));
      if (stale()) return;
      if (!token) break;
      const nonce = newChallengeNonce();
      try {
        const r = await this.run(
          entry,
          sshCommandSpec(entry.host.alias, ['curl', '-s', '-m', '2', `http://127.0.0.1:${fwd.port}${HOOK_HEALTH_PATH}?nonce=${nonce}`]),
          'challenge',
        );
        if (stale()) return;
        if (verifyChallengeMac(token, nonce, r.stdout.toString('utf8'))) {
          fwd.verified = true;
          fwd.failures = 0;
          log('host', 'host-ssh-forward', { detail: { host: entry.host.id, state: 'verified', attempts: attempt + 1 } });
          this.setHooks(entry, 'ok', null);
          return;
        }
      } catch {
        // retried below
      }
    }
    if (stale()) return;
    log('host', 'host-ssh-forward', { detail: { host: entry.host.id, state: 'unverified' } });
    this.setHooks(entry, 'unreachable', FORWARD_UNVERIFIED_MESSAGE);
  }

  private stopForward(entry: SshEntry): void {
    const fwd = entry.forward;
    if (!fwd) return;
    fwd.seq++;
    if (fwd.timer) clearTimeout(fwd.timer);
    fwd.timer = null;
    const child = fwd.child;
    fwd.child = null;
    fwd.verified = false;
    entry.forward = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    if (entry.status.hooks !== 'untested') {
      entry.status = { ...entry.status, hooks: 'untested' };
      this.ctx.setPart(entry.host.id, 'hooks', null);
    }
  }

  // --- recovery (fix round 1 #3) ---------------------------------------------------

  private ensureRecoveryTimer(): void {
    if (this.recoveryTimer || configured().length === 0) return;
    const ms = testNumber('AGENT_WORKSPACE_TEST_SSH_RECOVERY_MS') ?? RECOVERY_INTERVAL_MS;
    this.recoveryTimer = setInterval(() => this.recover('timer', { force: true }), ms);
    this.recoveryTimer.unref?.();
  }

  /** Hosts that failed for a connection reason (exit 255 / timeout) get a
   * fresh probe or a closed breaker; shell/node/helper failures stay until
   * Re-check. Resume/unlock/focus are throttled to once a minute. */
  recover(trigger: 'resume' | 'unlock' | 'focus' | 'timer', opts: { force?: boolean } = {}): number {
    if (this.ctx.quitting()) return 0;
    const now = Date.now();
    if (!opts.force && !sshRecoveryDue(this.lastRecoveryAt, now)) return 0;
    this.lastRecoveryAt = now;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!this.isEnabled(entry.host.id) || entry.probing) continue;
      if (entry.status.state === 'error' && entry.probeFailure === 'connection') {
        entry.probed = false;
        void this.probe(entry);
        count++;
      } else if (entry.channel?.state === 'degraded' && entry.helperFailure === 'connection') {
        this.syncChannel(entry, { reset: true });
        count++;
      } else if (entry.forward && !entry.forward.child && entry.forward.timer && entry.channel?.state === 'ready') {
        clearTimeout(entry.forward.timer);
        this.startForward(entry);
        count++;
      }
    }
    if (count > 0) log('host', 'host-ssh-recover', { detail: { trigger, count } });
    return count;
  }

  fsReady(id: HostId): boolean {
    return this.isEnabled(id) && this.entries.get(id)?.channel?.state === 'ready';
  }

  fsSafe(id: HostId): boolean {
    return this.entries.get(id)?.channel?.state === 'ready';
  }

  /** Hooks opt-out with the channel down: one `--apply-hooks-off` run of the
   * deployed helper over ssh; exit 86 → deploy once and retry. */
  async hooksOffOnce(id: HostId): Promise<{ ok: boolean; error: string | null }> {
    const entry = this.entries.get(id);
    const bundle = this.ctx.bundle();
    const home = entry?.host.home;
    if (!entry || !bundle || !home || this.ctx.quitting()) return { ok: false, error: 'helper unavailable' };
    const helperState = entry.status.helper?.state;
    if (helperState === 'node-missing' || helperState === 'unsupported-node') return { ok: false, error: 'node unavailable' };
    const spec = sshHelperSpec(entry.host.alias, home, entry.status.shell ?? '/bin/sh', bundle.hash, '--apply-hooks-off');
    try {
      let r = await this.run(entry, spec, 'hooks-off', { timeout: 30_000 });
      if (r.code === HELPER_MISSING_EXIT && (await this.deploy(entry))) r = await this.run(entry, spec, 'hooks-off', { timeout: 30_000 });
      const ok = r.code === 0;
      log('host', 'host-hooks-off', { detail: { host: id, ok, code: r.code } });
      return { ok, error: ok ? null : `hooks removal failed (exit ${r.code ?? 'unknown'})` };
    } catch {
      log('host', 'host-hooks-off', { detail: { host: id, ok: false, code: null } });
      return { ok: false, error: 'ssh unavailable' };
    }
  }

  // --- env + spawn ----------------------------------------------------------------

  async shellEnv(id: HostId): Promise<Record<string, string> | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (!entry.probed) await (entry.probing ?? this.probe(entry));
    if (entry.channel?.state === 'ready' && this.ctx.overrides(id).envCaptureDisabled !== true) {
      return (await this.fetchChannelEnv(entry)) ?? entry.env;
    }
    return entry.env;
  }

  private entryOrThrow(id: HostId): SshEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('unknown ssh host');
    return entry;
  }

  /** Piped child over `ssh -T`; the caller writes `stdinPrefix` (the app's
   * extra env as one base64 line) before anything else. No env in argv. */
  spawnSpec(id: HostId, cmd: HostCommand): { file: string; args: string[]; stdinPrefix: string } {
    const entry = this.entryOrThrow(id);
    const spec = this.apply(sshSpawnSpec(entry.host.alias, cmd.cwd, entry.status.shell ?? '/bin/sh', cmd.file, cmd.args));
    this.note(entry, 'spawn', 'spawn');
    return { ...spec, stdinPrefix: sshEnvLine(cmd.env ?? {}) };
  }

  /** node-pty spec over `ssh -t`. A non-empty env (the hook token) is staged
   * through the helper (`env.stage`, 0600 file) — only its path is in argv;
   * without a ready channel such a pty is refused rather than leaking it. */
  async ptySpec(id: HostId, cmd: HostCommand): Promise<{ file: string; args: string[] }> {
    const entry = this.entryOrThrow(id);
    let envFile: string | null = null;
    const env = cmd.env ?? {};
    if (Object.keys(env).length > 0) {
      const channel = entry.channel;
      const home = entry.host.home;
      if (!channel || channel.state !== 'ready' || !home) {
        throw new Error('The host helper is not ready — cannot pass the terminal environment securely');
      }
      const res = await channel.request<{ name?: unknown; path?: unknown } | null>('env.stage', { vars: env });
      const name = typeof res?.name === 'string' && /^[0-9a-f]{32}$/.test(res.name) ? res.name : null;
      if (!name) throw new Error('env.stage failed');
      // A helper on a non-POSIX node (the e2e fake) reports a native path: rebuild it under the probed home.
      envFile =
        typeof res?.path === 'string' && res.path.startsWith('/')
          ? res.path
          : `${home.replace(/\/+$/, '')}/${HELPER_DIR}/run/${name}`;
    }
    const spec = this.apply(sshPtySpec(entry.host.alias, cmd.cwd, envFile, cmd.file, cmd.args, entry.status.shell ?? null));
    this.note(entry, 'pty', 'spawn');
    return spec;
  }

  async recheckEnv(id: HostId): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.channel?.state === 'ready') {
      entry.channelEnv = null;
      await this.fetchChannelEnv(entry);
      return;
    }
    entry.probed = false;
    await this.probe(entry);
  }

  async refresh(id?: HostId): Promise<void> {
    const targets = [...this.entries.values()].filter(
      (e) => (id === undefined || e.host.id === id) && this.isEnabled(e.host.id),
    );
    for (const entry of targets) {
      entry.probed = false;
      await this.probe(entry);
      this.syncChannel(entry, { reset: true });
      if (entry.forward && !entry.forward.child) {
        entry.forward.failures = 0;
        this.stopForward(entry);
        if (entry.channel?.state === 'ready') this.ensureForward(entry);
      }
    }
  }

  /** Settings membership changed (add/remove/enable): stop what left, start what came. */
  sync(): void {
    for (const [id, entry] of this.entries) {
      if (!this.isConfigured(id)) {
        if (entry.channel?.running) entry.channel.stop('stopped');
        this.stopForward(entry);
        this.entries.delete(id);
        for (const part of ['env', 'cli', 'store', 'hooksInstall', 'hooks'] as const) this.ctx.setPart(id, part, null);
      }
    }
    this.syncChannels();
  }

  /** Quit: EOF every helper and drop the forwards; the caller waits, then killStopped(). */
  stopChannels(): HostChannel[] {
    for (const entry of this.entries.values()) this.stopForward(entry);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    const live = [...this.entries.values()].filter((e) => e.channel?.running).map((e) => e.channel!);
    for (const channel of live) channel.stop();
    return [...this.entries.values()].flatMap((e) => (e.channel ? [e.channel] : []));
  }

  status(id: HostId): HostStatus | null {
    return this.entries.get(id)?.status ?? null;
  }

  envKeys(id: HostId): string[] {
    const entry = this.entries.get(id);
    return Object.keys(entry?.channelEnv ?? entry?.env ?? {}).sort();
  }
}

function testNumber(name: string): number | null {
  if (!testMode) return null;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
