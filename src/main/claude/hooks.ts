// Claude hooks wiring — the loopback listener, the per-session activity
// map it feeds, notifications derived from hook events and chat events, and
// the global settings.json install for external terminals.
import { join } from 'node:path';
import {
  applyHookEvent,
  expireActivity,
  type ActivityState,
  type ClaudeHookEvent,
} from '../../core/claudeActivity';
import { buildHooksBlock, hooksApplyKey, settingsFlagJson } from '../../core/claudeHooks';
import { notificationsForHookEvent } from '../../core/claudeNotify';
import type { NotificationKind } from '../../core/notificationModel';
import { claudeScope } from '../../core/tabModel';
import type { ClaudeState } from '../../shared/ipc';
import { isWslHost, type ExecHost, type HostId } from '../../core/execHost';
import { log } from '../log';
import { fixtureOrigins, state } from '../state';
import { notificationStore } from '../notifications';
import { autoOpenLocalPr } from '../local/prAutoOpen';
import { ClaudeHookServer } from './hookServer';
import { claudeUsage } from './usage';
import { applyGlobalHooks } from './hooksInstall';
import { hosts } from '../hosts';
import { terminalHost } from '../local/terminalHost';
import { hooksOffDue, hooksOffFailed, type HooksOffBackoff } from '../../core/hooksOffBackoff';
import type { ClaudeSessions } from './sessions';

export class ClaudeHooks {
  private hookServer: ClaudeHookServer | null = null;
  hooks: ClaudeState['hooks'] = {
    port: null,
    enabled: false,
    installed: false,
    error: null,
  };
  activity: ActivityState = {};
  // Dedupe window for permission notifications (recentPermission in
  // notificationsForHookEvent).
  private readonly recentPermission = new Map<string, number>();
  private activityTimer: NodeJS.Timeout | null = null;
  private applying = false;
  private applyDirty = false;
  // Per host: the key of the last successful settings.json write.
  private readonly lastApplied = new Map<HostId, string>();
  // Per host: failed `--apply-hooks-off` runs (60 s doubling to 1 h) and the
  // error they reported — status changes inside the window spawn nothing.
  private readonly offBackoff = new Map<HostId, HooksOffBackoff & { error: string | null }>();
  private skipLogged = false;

  constructor(
    private readonly owner: ClaudeSessions,
    private readonly configDir: string,
  ) {}

  start(userData: string): void {
    this.hookServer = new ClaudeHookServer({
      userData,
      onEvent: (e) => this.onEvent(e),
    });
    void this.hookServer.start().then((result) => {
      if ('error' in result) {
        this.hooks = { ...this.hooks, error: result.error };
      } else {
        this.hooks = { ...this.hooks, port: result.port, error: null };
        this.applyHooks();
      }
      this.owner.emit();
    });
    this.activityTimer = setInterval(() => this.expireActivity(), 10 * 60_000);
    this.activityTimer.unref?.();
  }

  stop(): void {
    this.hookServer?.dispose();
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
  }

  private expireActivity(): void {
    const next = expireActivity(this.activity, Date.now());
    if (next !== this.activity) {
      this.activity = next;
      this.owner.emit();
    }
  }

  // Global opt-in: (re)write our hook block into <configDir>/settings.json so
  // external terminals report activity too; off removes exactly our entries.
  // Fire-and-forget and coalesced: one run in flight plus one dirty follow-up,
  // so a burst of host-status changes never stacks helper round-trips.
  applyHooks(): void {
    const enabled = state.settings?.current.claude.hooksEnabled ?? false;
    this.hooks = { ...this.hooks, enabled };
    if (!this.hookServer?.info()) {
      if (enabled) {
        this.hooks = { ...this.hooks, installed: false, error: 'hook listener unavailable' };
      }
      return;
    }
    if (this.applying) {
      this.applyDirty = true;
      return;
    }
    this.applying = true;
    void (async () => {
      try {
        do {
          this.applyDirty = false;
          await this.applyOnce();
        } while (this.applyDirty);
      } finally {
        this.applying = false;
      }
    })().catch((error: unknown) => {
      this.hooks = {
        ...this.hooks,
        installed: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.owner.emit();
    });
  }

  /** The hooks setting changed: a failing one-shot may run again at once. */
  resetOffBackoff(): void {
    this.offBackoff.clear();
  }

  /** Drop the lastApplied gate (explicit hosts refresh) so the next apply re-writes. */
  forgetApplied(id?: HostId): void {
    if (id) this.lastApplied.delete(id);
    else this.lastApplied.clear();
  }

  private async applyOnce(): Promise<void> {
    const info = this.hookServer?.info();
    const enabled = state.settings?.current.claude.hooksEnabled ?? false;
    if (!info) return;
    // Soak/measurement runs redirect only userData; never touch the real settings.json files.
    if (process.env.AGENT_WORKSPACE_SKIP_HOOKS_INSTALL === '1') {
      if (!this.skipLogged) {
        this.skipLogged = true;
        log('claude', 'claude-hooks-install-skipped');
      }
      this.hooks = { ...this.hooks, enabled, installed: false, error: null };
      this.owner.emit();
      return;
    }
    // The opt-in applies to every enabled host's settings.json — a wsl host's
    // file is written by its helper (hooks.apply, the same core/hooksApply.ts)
    // inside the distro, and the URLs point at that host's reachable address
    // (loopback in mirrored mode, the vEthernet IPv4 in NAT mode).
    let installed = false;
    let firstError: string | null = null;
    for (const host of hosts().allHosts()) {
      // Installs target enabled hosts only (their channel must be ready). The
      // opt-out also cleans a disabled-but-running one (our block carries the
      // token): over the channel when it is up, else one `--apply-hooks-off`
      // run of the deployed helper — never a Stopped distro, never UNC.
      if (enabled ? !hosts().fsReady(host) : !hosts().fsSafe(host)) continue;
      const channelReady = !isWslHost(host) || hosts().channel(host)?.state === 'ready';
      // An enabled host's channel is (re)starting: its ready transition
      // re-runs this apply — no one-shot spawn for it.
      const listed = hosts().list().some((h) => h.id === host.id);
      if (!channelReady && (enabled || listed)) continue;
      const addr = hosts().hookAddrFor(host.id) ?? undefined;
      const key = hooksApplyKey(
        host.id,
        enabled,
        buildHooksBlock({ port: info.port, auth: { kind: 'token', token: info.token }, ...(addr ? { addr } : {}) }),
      );
      let result: { installed: boolean; error: string | null };
      if (this.lastApplied.get(host.id) === key) {
        // Already written in this state; lastApplied is only recorded on success.
        result = { installed: enabled, error: null };
      } else {
        result = !isWslHost(host)
          ? await applyGlobalHooks(hosts().configDir(host), enabled, info.port, info.token, addr)
          : channelReady
            ? await this.applyOverChannel(host, enabled, info, addr)
            : await this.removeOnce(host);
        if (result.error === null) this.lastApplied.set(host.id, key);
        else this.lastApplied.delete(host.id);
      }
      if (host.id === 'local') {
        installed = result.installed;
        firstError = result.error;
      }
      hosts().setError(host.id, 'hooksInstall', result.error);
      if (result.error && !firstError) firstError = result.error;
    }
    this.hooks = { ...this.hooks, enabled, installed, error: firstError };
    this.owner.emit();
  }

  /** Opt-out with the channel down (a disabled, running distro). */
  private async removeOnce(host: ExecHost): Promise<{ installed: boolean; error: string | null }> {
    const backoff = this.offBackoff.get(host.id);
    if (!hooksOffDue(backoff, Date.now())) return { installed: false, error: backoff?.error ?? null };
    const r = await hosts().hooksOffOnce(host);
    if (r.ok) this.offBackoff.delete(host.id);
    else this.offBackoff.set(host.id, { ...hooksOffFailed(backoff, Date.now()), error: r.error });
    log('claude', 'claude-hooks-install', {
      detail: { enabled: false, changed: r.ok, ok: r.ok, host: host.id, via: 'one-shot' },
    });
    return { installed: false, error: r.error };
  }

  /** hooks.apply in the distro; an RPC failure is reported like a write error. */
  private async applyOverChannel(
    host: ExecHost,
    enabled: boolean,
    info: { port: number; token: string },
    addr: string | undefined,
  ): Promise<{ installed: boolean; error: string | null }> {
    let changed = false;
    let result: { installed: boolean; error: string | null };
    try {
      const channel = hosts().channel(host);
      if (!channel) throw new Error('helper channel is not ready');
      const r = await channel.request<{ installed?: unknown; changed?: unknown; error?: unknown } | null>(
        'hooks.apply',
        { enabled, port: info.port, token: info.token, ...(addr ? { addr } : {}) },
      );
      changed = r?.changed === true;
      result = {
        installed: r?.installed === true,
        error: typeof r?.error === 'string' ? r.error : null,
      };
    } catch (error) {
      result = { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
    log('claude', 'claude-hooks-install', {
      detail: { enabled, changed, ok: result.error === null, host: host.id },
    });
    return result;
  }

  /** Expose the listener on a non-loopback address (NAT-mode WSL reachability). */
  listenOn(addr: string): void {
    this.hookServer?.listenOn(addr);
  }

  /**
   * Defence in depth for the opt-out: with `claude.hooksEnabled` off only the
   * app's own claude ptys (their `--settings` block + token env) may report.
   * The listener cannot tell the two block kinds apart (same URL and token),
   * so the gate is by session: an open claude-kind pty for `session_id`.
   */
  private accepts(e: ClaudeHookEvent): boolean {
    if (state.settings?.current.claude.hooksEnabled ?? false) return true;
    return terminalHost
      .list()
      .some((t) => t.kind === 'claude' && t.sessionId === e.session_id && t.exitCode === null);
  }

  private onEvent(e: ClaudeHookEvent): void {
    if (!this.accepts(e)) {
      log('claude', 'claude-hook-ignored', { detail: { event: e.event, reason: 'hooks-off' } });
      return;
    }
    // A turn just ended — utilization moved (Q4: terminal sessions too).
    if (e.event === 'Stop') claudeUsage().poke('hook');
    const next = applyHookEvent(this.activity, e);
    if (next !== this.activity) {
      this.activity = next;
      this.owner.emit();
    }
    if (!(state.settings?.current.notifications.collect ?? true)) return;
    const kinds = state.settings?.current.notifications.kinds;
    const { notifications, prUrls } = notificationsForHookEvent(e, {
      titleFor: (id, cwd) => this.owner.titleFor(id, cwd),
      enabled: {
        waiting: kinds?.waiting ?? true,
        finished: kinds?.finished ?? false,
        prOpened: kinds?.prOpened ?? true,
      },
      now: Date.now(),
      recentPermission: this.recentPermission,
      githubOrigins: fixtureOrigins,
    });
    for (const n of notifications) notificationStore().add(n);
    for (const url of prUrls) {
      this.owner.recordPr(e.session_id, url, 'hook');
      autoOpenLocalPr(url, claudeScope(e.session_id), 'claude-hook');
    }
  }

  // Chat-derived notifications — the SDK host reports its own state changes;
  // hook events never overlap (chat sessions get no hooks injected).
  onChatEvent(
    sessionId: string,
    kind: 'waiting' | 'finished' | 'blocked',
    detail?: { tool?: string; error?: string },
  ): void {
    // A finished turn may have written subagent transcripts — drop the
    // cached list so the next expand re-lists.
    if (kind !== 'waiting') this.owner.invalidateSubagentList(sessionId);
    if (!(state.settings?.current.notifications.collect ?? true)) return;
    const kinds = state.settings?.current.notifications.kinds;
    const enabled: Record<'waiting' | 'finished' | 'blocked', boolean> = {
      waiting: kinds?.waiting ?? true,
      finished: kinds?.finished ?? false,
      blocked: kinds?.blocked ?? true,
    };
    if (!enabled[kind]) return;
    const sessionTitle = this.owner.titleFor(sessionId, undefined);
    notificationStore().add({
      kind: kind as NotificationKind,
      sessionId,
      source: 'claude',
      ownerUserId: null,
      sessionTitle,
      title:
        kind === 'waiting'
          ? 'Waiting for permission'
          : kind === 'finished'
            ? 'Finished a turn'
            : 'Session error',
      body:
        kind === 'waiting'
          ? `${detail?.tool ?? 'A tool'} in ${sessionTitle}`
          : kind === 'finished'
            ? sessionTitle
            : (detail?.error ?? 'error').slice(0, 200),
      createdAt: Date.now(),
    });
  }

  // Pty spawn injection for claude-kind terminals: `--settings` hook block +
  // the bearer token env var. Mode `attach` gets none (the background agent
  // already runs) and a failed listener means no injection at all.
  injection(
    mode: 'resume' | 'new' | 'attach',
    addr?: string,
  ): { extraArgs: string[]; extraEnv: Record<string, string> } | null {
    if (mode === 'attach') return null;
    const info = this.hookServer?.info();
    if (!info) return null;
    const envVar = 'AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN';
    return {
      extraArgs: [
        '--settings',
        settingsFlagJson(info.port, envVar, addr),
        '--permission-mode',
        state.settings?.current.claude.defaultPermissionMode ?? 'default',
      ],
      extraEnv: { [envVar]: info.token },
    };
  }

  info(): { port: number; token: string } | null {
    return this.hookServer?.info() ?? null;
  }

  settingsPath(): string {
    return join(this.configDir, 'settings.json');
  }
}
