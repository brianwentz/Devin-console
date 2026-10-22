// SSH execution hosts (P3): `ssh:<alias>` for each enabled `settings.hosts.ssh`
// entry. Same helper + protocol as WSL, reached over `ssh.exe -T <alias>`
// instead of `wsl.exe -d D`: one probe run (home / shell / helper presence),
// one interactive-login run (env, node, CLIs), a stdin deploy when the bundle
// is absent, then a long-lived HostChannel whose launch adds
// `-R <hookPort>:127.0.0.1:<hookPort>` so the remote CLI's hooks reach the
// Windows listener. There is no enumeration: a configured, enabled host is
// eligible; a connection failure (ssh exit 255) is a failed start, so the
// channel's backoff/breaker bounds the retries — never a loop.
//
// Logging: the alias never reaches the log. Every ssh.exe invocation logs
// `host-ssh {aliasHash, op}` + `host-exec {host, kind}` with the id scrubbed to
// `ssh:#<aliasHash>` by log() (core/sshLog.ts), as is every other detail.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  deriveHelperState,
  HELPER_MISSING_EXIT,
  parseHelperPresent,
  parseProbeOutput,
  parseSshEnvProbe,
  sanitizeEnv,
  sshCommandSpec,
  sshEnvSpec,
  sshHelperDeploySpec,
  sshHelperSpec,
  sshHost,
  sshProbeSpec,
  sshPtySpec,
  sshReplayEnv,
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
import { state, testMode } from './state';
import { HOOK_PATH_PREFIX } from '../core/claudeHooks';

const execFileAsync = promisify(execFile);

type SshHost = Extract<ExecHost, { kind: 'ssh' }>;
type ErrorPart = 'env' | 'cli' | 'hooksInstall' | 'store';
/** `host-ssh` op enum. */
export type SshOp = 'probe' | 'env' | 'deploy' | 'helper' | 'hooks-off' | 'hooks' | 'exec' | 'spawn' | 'pty';

const PROBE_TIMEOUT_MS = 20_000;
/** ssh exits 255 when the connection itself failed (auth, DNS, refused, host key). */
export const SSH_CONNECTION_FAILED = 255;
const HOOK_HEALTH_PATH = `${HOOK_PATH_PREFIX}health`;

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
  bundle(): HelperBundleInfo | null;
  quitting(): boolean;
  overrides(id: HostId): NonNullable<Settings['hosts']['overrides'][string]>;
}

interface SshEntry {
  host: SshHost;
  hash: string;
  status: HostStatus;
  probed: boolean;
  probing: Promise<void> | null;
  /** The probe's interactive-login capture (fallback until env.get lands). */
  env: Record<string, string> | null;
  channel: HostChannel | null;
  channelEnv: Record<string, string> | null;
  channelEnvInFlight: Promise<Record<string, string> | null> | null;
  helperPreexisting: boolean;
  /** The channel was stopped because the host was disabled; re-enabling resets the breaker. */
  held: boolean;
}

interface SshRun {
  stdout: Buffer;
  code: number | null;
  timedOut: boolean;
}

const configured = (): Settings['hosts']['ssh'] => state.settings?.current.hosts.ssh ?? [];

export class SshHosts {
  private entries = new Map<HostId, SshEntry>();
  private sshCmd: string[] | null | undefined;
  private readonly sshReady: Promise<void>;

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
      this.sshCmd = ['ssh'];
      return;
    }
    try {
      const { stdout } = await execFileAsync('where.exe', ['ssh.exe'], { windowsHide: true });
      this.sshCmd = stdout.trim() ? ['ssh.exe'] : null;
    } catch {
      this.sshCmd = null;
    }
  }

  /** core spec (`ssh.exe …`) → the resolved command (test seam prefix included). */
  private apply(spec: HostSpawnSpec): { file: string; args: string[] } {
    const cmd = this.sshCmd ?? ['ssh.exe'];
    return { file: cmd[0]!, args: [...cmd.slice(1), ...spec.args] };
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
          if (!this.sshCmd) {
            reject(new Error('OpenSSH client (ssh.exe) not found'));
            return;
          }
          const { file, args } = this.apply(spec);
          this.note(entry, op, op === 'deploy' || op === 'hooks-off' ? 'exec' : op === 'env' ? 'env' : 'probe');
          const child = spawn(file, args, {
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
        env: null,
        channel: null,
        channelEnv: null,
        channelEnvInFlight: null,
        helperPreexisting: false,
        held: false,
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
        const r = await this.run(entry, sshProbeSpec(entry.host.alias, bundle?.hash ?? null, overrides.home ?? null), 'probe');
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
        log('host', 'host-probe', { detail: { host: id, ok: false, ms: Date.now() - t0 } });
        return;
      }
      const shell = entry.status.shell ?? '/bin/sh';
      if (unsupportedSshShell(shell)) {
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
   * removed/disabled host's channel stops (no respawn). */
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
      // network surfaces as a failed start (exit 255) → backoff → breaker.
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
    if (!home || !this.sshCmd) throw new Error('helper launch unavailable');
    const port = this.ctx.hookPort() ?? undefined;
    const { file, args } = this.apply(
      sshHelperSpec(entry.host.alias, home, entry.status.shell ?? '/bin/sh', hash, port),
    );
    this.note(entry, 'helper', 'helper');
    return spawn(file, args, { cwd: homedir(), windowsHide: true, stdio: 'pipe' });
  }

  private onChannelState(entry: SshEntry, channel: HostChannel, status: HelperStatus): void {
    if (entry.channel !== channel || this.ctx.quitting()) return;
    entry.status = { ...entry.status, helper: status };
    if (status.state === 'ready') {
      void this.fetchChannelEnv(entry);
      void this.probeHooks(entry);
    } else entry.channelEnv = null;
    this.ctx.publish();
  }

  /** Remote hook reachability through the channel's `-R` forward: one
   * `curl 127.0.0.1:<port>` run on the remote while the channel is up. */
  private async probeHooks(entry: SshEntry): Promise<void> {
    const port = this.ctx.hookPort();
    if (!port) return;
    let hooks: HostStatus['hooks'] = 'unreachable';
    try {
      const r = await this.run(
        entry,
        sshCommandSpec(entry.host.alias, [
          'curl', '-s', '-m', '2', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}${HOOK_HEALTH_PATH}`,
        ]),
        'hooks',
      );
      if (['200', '401', '404'].includes(r.stdout.toString('utf8').trim())) hooks = 'ok';
    } catch {
      hooks = 'unreachable';
    }
    if (entry.status.hooks === hooks) return;
    entry.status = { ...entry.status, hooks };
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

  fsReady(id: HostId): boolean {
    return this.isEnabled(id) && this.entries.get(id)?.channel?.state === 'ready';
  }

  fsSafe(id: HostId): boolean {
    return this.entries.get(id)?.channel?.state === 'ready';
  }

  /** Hooks opt-out with the channel down: one `--apply-hooks-off` run of the
   * deployed helper over ssh (no -R); exit 86 → deploy once and retry. */
  async hooksOffOnce(id: HostId): Promise<{ ok: boolean; error: string | null }> {
    const entry = this.entries.get(id);
    const bundle = this.ctx.bundle();
    const home = entry?.host.home;
    if (!entry || !bundle || !home || this.ctx.quitting()) return { ok: false, error: 'helper unavailable' };
    const helperState = entry.status.helper?.state;
    if (helperState === 'node-missing' || helperState === 'unsupported-node') return { ok: false, error: 'node unavailable' };
    const spec = sshHelperSpec(entry.host.alias, home, entry.status.shell ?? '/bin/sh', bundle.hash, undefined, '--apply-hooks-off');
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
    if (entry.channel?.state === 'ready') {
      if (this.ctx.overrides(id).envCaptureDisabled === true) return null;
      return (await this.fetchChannelEnv(entry)) ?? entry.env;
    }
    if (!entry.probed) await (entry.probing ?? this.probe(entry));
    return entry.env;
  }

  private replayEnv(entry: SshEntry, extra: Record<string, string>): Record<string, string> {
    return sshReplayEnv(entry.channelEnv ?? entry.env ?? {}, extra);
  }

  /** Piped child over `ssh -T`: `cd <cwd> && exec /usr/bin/env <login env> cmd…`. */
  spawnSpec(id: HostId, cmd: HostCommand): { file: string; args: string[] } {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('unknown ssh host');
    this.note(entry, 'spawn', 'spawn');
    return this.apply(sshSpawnSpec(entry.host.alias, cmd.cwd, this.replayEnv(entry, cmd.env ?? {}), cmd.file, cmd.args));
  }

  /** node-pty spec over `ssh -t` (interactive login shell provides the env). */
  ptySpec(id: HostId, cmd: HostCommand): { file: string; args: string[] } {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('unknown ssh host');
    this.note(entry, 'pty', 'spawn');
    return this.apply(sshPtySpec(entry.host.alias, cmd.cwd, cmd.env ?? {}, cmd.file, cmd.args, entry.status.shell ?? null));
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
    }
  }

  /** Settings membership changed (add/remove/enable): stop what left, start what came. */
  sync(): void {
    for (const [id, entry] of this.entries) {
      if (!this.isConfigured(id)) {
        if (entry.channel?.running) entry.channel.stop('stopped');
        this.entries.delete(id);
        this.ctx.setPart(id, 'env', null);
        this.ctx.setPart(id, 'cli', null);
        this.ctx.setPart(id, 'store', null);
        this.ctx.setPart(id, 'hooksInstall', null);
      }
    }
    this.syncChannels();
  }

  /** Quit: EOF every helper; the caller waits, then killStopped(). */
  stopChannels(): HostChannel[] {
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

  aliasHashFor(id: HostId): string | null {
    return this.entries.get(id)?.hash ?? null;
  }
}

function testNumber(name: string): number | null {
  if (!testMode) return null;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
