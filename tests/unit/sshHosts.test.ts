import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SshHosts (R39 #2 #3 #5 #7 #8 #10) with ssh.exe, the event log, settings and
// the helper channel stubbed: no process is ever started.

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require('node:events') as typeof import('node:events');
  class FakeChild extends Emitter {
    stdout = new Emitter();
    stderr = Object.assign(new Emitter(), { resume: () => undefined });
    stdinEnded = false;
    stdin = {
      write: () => true,
      end: () => {
        this.stdinEnded = true;
      },
      on: () => undefined,
    };
    killed = false;
    kill(): boolean {
      this.killed = true;
      return true;
    }
  }
  class FakeChannel {
    state = 'ready';
    running = true;
    onState(): () => void {
      return () => undefined;
    }
    start(): void {}
    reset(): void {}
    stop(): void {
      this.running = false;
    }
    request(): Promise<unknown> {
      return Promise.resolve(null);
    }
  }
  return {
    FakeChild,
    FakeChannel,
    spawned: [] as { file: string; args: string[]; opts: { stdio?: unknown }; child: InstanceType<typeof FakeChild> }[],
    logged: [] as { event: string; detail: Record<string, unknown> }[],
    settings: { current: { hosts: { ssh: [] as { alias: string; enabled: boolean }[], overrides: {} } } },
  };
});
const { spawned, logged, settings, FakeChannel } = h;

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: { stdio?: unknown }) => {
    const child = new h.FakeChild();
    h.spawned.push({ file, args, opts, child });
    return child;
  },
  execFile: () => undefined,
}));
vi.mock('../../src/main/log', () => ({
  log: (_view: string, event: string, extra?: { detail?: Record<string, unknown> }) => {
    h.logged.push({ event, detail: extra?.detail ?? {} });
  },
  sshAliasHash: (alias: string) => `h-${alias}`,
}));
vi.mock('../../src/main/state', () => ({ state: { settings: h.settings }, testMode: true }));
vi.mock('../../src/main/sshResolve', () => ({ resolveWindowsSsh: () => Promise.resolve('C:/ssh.exe') }));
vi.mock('../../src/main/claude/sdk', () => ({ sdkTargetCliVersion: () => null }));
vi.mock('../../src/main/hostChannel', () => ({ HostChannel: h.FakeChannel }));

import { SshHostDisabledError, SshHosts } from '../../src/main/sshHosts';
import { sshProbeSpec } from '../../src/core/execHost';

function make() {
  const parts: { id: string; part: string; message: string | null }[] = [];
  const hosts = new SshHosts({
    publish: () => undefined,
    setPart: (id, part, message) => parts.push({ id, part, message }),
    hookPort: () => 4567,
    hookToken: () => 'tok',
    bundle: () => ({ file: 'x', hash: 'abcdef012345' }) as never,
    quitting: () => false,
    overrides: () => ({}),
  });
  return { hosts, parts, priv: hosts as unknown as Record<string, any> };
}

beforeEach(() => {
  vi.useFakeTimers();
  spawned.length = 0;
  logged.length = 0;
  settings.current.hosts.ssh = [{ alias: 'box', enabled: true }];
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** An entry whose channel is the FakeChannel in `state`, the forward started. */
async function withForward(state = 'ready') {
  const made = make();
  const entry = made.priv.entryFor('box');
  const channel = new FakeChannel();
  channel.state = state;
  entry.channel = channel;
  await made.priv.sshReady;
  made.priv.ensureForward(entry);
  const fwd = spawned.find((s) => s.args.includes('-R'))!;
  return { ...made, entry, channel, fwd };
}

describe('SshHosts.run (R39 #2)', () => {
  it("resolves on 'close' with the whole stdout — output after 'exit' is kept", async () => {
    const { priv } = make();
    const entry = priv.entryFor('box');
    const pending = priv.run(entry, sshProbeSpec('box', null, null), 'probe') as Promise<{ stdout: Buffer; code: number }>;
    await flush();
    const child = spawned[0]!.child;
    child.stdout.emit('data', Buffer.from('first-'));
    child.emit('exit', 0, null);
    child.stdout.emit('data', Buffer.from('tail'));
    child.emit('close', 0, null);
    const r = await pending;
    expect(r.stdout.toString()).toBe('first-tail');
    expect(r.code).toBe(0);
  });

  it("logs the HMAC challenge as host-exec kind 'challenge' (R39 #10)", async () => {
    const { priv } = make();
    const entry = priv.entryFor('box');
    const pending = priv.run(entry, sshProbeSpec('box', null, null), 'challenge');
    await flush();
    spawned[0]!.child.emit('close', 0, null);
    await pending;
    expect(logged.filter((l) => l.event === 'host-exec').map((l) => l.detail.kind)).toEqual(['challenge']);
  });
});

describe('SshHosts disabled host (R39 #5)', () => {
  it('refuses spawn / pty / env on a configured-but-disabled host without starting ssh', async () => {
    settings.current.hosts.ssh = [{ alias: 'box', enabled: false }];
    const { hosts } = make();
    expect(hosts.hostById('ssh:box')).not.toBeNull();
    expect(() => hosts.spawnSpec('ssh:box', { file: 'claude', args: [], cwd: '/h' })).toThrow(SshHostDisabledError);
    await expect(hosts.ptySpec('ssh:box', { file: 'claude', args: [], cwd: '/h' })).rejects.toThrow(SshHostDisabledError);
    expect(await hosts.shellEnv('ssh:box')).toBeNull();
    await flush();
    expect(spawned).toHaveLength(0);
    expect(new SshHostDisabledError().message).toMatch(/disabled/i);
  });
});

describe('SshHosts hook forward', () => {
  it('runs without -N, with stdin piped and kept open (R39 #3)', async () => {
    const { fwd } = await withForward();
    expect(fwd.args).not.toContain('-N');
    expect(fwd.args.slice(-2)).toEqual(['--', 'exec cat >/dev/null']);
    expect((fwd.opts.stdio as unknown[])[0]).toBe('pipe');
    expect(fwd.child.stdinEnded).toBe(false);
  });

  it("counts one failure when the child emits both 'error' and 'exit' (R39 #7)", async () => {
    const { entry, fwd } = await withForward();
    fwd.child.emit('error', new Error('spawn failed'));
    fwd.child.emit('exit', 255, null);
    expect(entry.forward.failures).toBe(1);
    expect(logged.filter((l) => l.event === 'host-ssh-forward' && l.detail.state === 'down')).toHaveLength(1);
  });

  it('does not reschedule while the channel is degraded, and stops on degraded (R39 #8)', async () => {
    const { entry, fwd, channel, priv } = await withForward('ready');
    channel.state = 'degraded';
    fwd.child.emit('exit', 255, null);
    expect(entry.forward?.timer ?? null).toBeNull();
    vi.advanceTimersByTime(400_000);
    expect(spawned.filter((s) => s.args.includes('-R'))).toHaveLength(1);

    // A live forward is stopped when the channel degrades.
    channel.state = 'ready';
    priv.stopForward(entry);
    priv.ensureForward(entry);
    const second = spawned.filter((s) => s.args.includes('-R'))[1]!;
    channel.state = 'degraded';
    priv.onChannelState(entry, channel, { state: 'degraded', watchMode: null });
    expect(entry.forward).toBeNull();
    expect(second.child.killed).toBe(true);
  });

  it('reschedules while the channel is ready', async () => {
    const { entry, fwd } = await withForward('ready');
    fwd.child.emit('exit', 255, null);
    expect(entry.forward.timer).not.toBeNull();
  });
});
