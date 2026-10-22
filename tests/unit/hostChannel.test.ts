import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostChannel, HostRpcError } from '../../src/main/hostChannel';
import { wslHost } from '../../src/core/execHost';

const HOST = wslHost('Fake', '/home/u');

class FakeChild extends EventEmitter {
  written: string[] = [];
  stdinEnded = false;
  killed = false;
  exited = false;
  stdout = new EventEmitter();
  stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  stdin = {
    write: (s: string) => {
      this.written.push(s);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
    on: () => undefined,
  };
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
  send(frame: unknown): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
  }
  raw(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }
  hello(hash = 'abcdef012345'): void {
    this.send({ method: 'hello', params: { protocol: 1, hash, node: '22.12.0', pid: 1, home: '/home/u', watchMode: 'watch' } });
  }
  requests(): Array<{ id: number; method: string }> {
    return this.written.map((l) => JSON.parse(l) as { id: number; method: string });
  }
}

type Logged = { event: string; detail: Record<string, unknown> };

function make(
  opts: {
    redeploy?: () => Promise<boolean>;
    maxFrameBytes?: number;
    canSpawn?: () => Promise<boolean>;
    expectedHash?: string;
    bundlePreexisting?: () => boolean;
  } = {},
) {
  const children: FakeChild[] = [];
  const logs: Logged[] = [];
  const states: string[] = [];
  const channel = new HostChannel(
    HOST,
    () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    {
      log: (event, detail) => logs.push({ event, detail }),
      tickMs: 100,
      stopGraceMs: 1_000,
      ...opts,
    },
  );
  channel.onState((s) => states.push(s.state));
  const last = () => children[children.length - 1]!;
  return { channel, children, logs, states, last };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HostChannel', () => {
  it('hello → ready; noise before hello is ignored', () => {
    const { channel, last, states, logs } = make();
    channel.start();
    expect(channel.state).toBe('starting');
    last().raw('Welcome to zsh\n{"not":"hello"}\n');
    expect(channel.state).toBe('starting');
    last().hello();
    expect(channel.state).toBe('ready');
    expect(channel.status).toEqual({ state: 'ready', watchMode: 'watch' });
    expect(states).toEqual(['starting', 'ready']);
    expect(logs.filter((l) => l.event === 'host-helper').map((l) => l.detail)).toEqual([
      { host: 'wsl:Fake', state: 'starting', reason: 'spawn' },
      { host: 'wsl:Fake', state: 'ready', reason: 'hello' },
    ]);
  });

  it('requests get monotonically increasing ids; results and errors resolve by id', async () => {
    const { channel, last, logs } = make();
    channel.start();
    last().hello();
    const a = channel.request<{ t: number }>('ping');
    const b = channel.request('store.list', { limit: 1 });
    const [ra, rb] = last().requests();
    expect(ra!.id).toBeLessThan(rb!.id);
    last().send({ id: rb!.id, error: { code: 'bad-params', message: 'x' } });
    last().send({ id: ra!.id, result: { t: 1 } });
    await expect(a).resolves.toEqual({ t: 1 });
    await expect(b).rejects.toMatchObject({ code: 'bad-params' });
    expect(logs.find((l) => l.event === 'host-rpc-error')?.detail).toEqual({
      host: 'wsl:Fake',
      method: 'store.list',
      code: 'bad-params',
    });
  });

  it('a request before ready is refused with a typed error', async () => {
    const { channel } = make();
    channel.start();
    await expect(channel.request('ping')).rejects.toBeInstanceOf(HostRpcError);
  });

  it('timeouts: 10 s default, 60 s for store.list, logged as host-rpc-timeout', async () => {
    const { channel, last, logs } = make();
    channel.start();
    const child = last();
    child.hello();
    const quick = channel.request('env.get');
    const slow = channel.request('store.list');
    quick.catch(() => undefined);
    slow.catch(() => undefined);
    // Keep the channel alive while waiting (answer every ping).
    for (let t = 0; t < 61_000; t += 1_000) {
      vi.advanceTimersByTime(1_000);
      for (const r of child.requests()) if (r.method === 'ping') child.send({ id: r.id, result: { t } });
      child.written = child.written.filter((l) => !l.includes('"ping"'));
      if (t === 10_000) await expect(quick).rejects.toMatchObject({ code: 'timeout' });
    }
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });
    expect(logs.filter((l) => l.event === 'host-rpc-timeout').map((l) => l.detail)).toEqual([
      { host: 'wsl:Fake', method: 'env.get', ms: 10_000 },
      { host: 'wsl:Fake', method: 'store.list', ms: 60_000 },
    ]);
    expect(child.killed).toBe(false);
  });

  it('pending requests are rejected when the helper exits', async () => {
    const { channel, last } = make();
    channel.start();
    last().hello();
    const p = channel.request('store.list');
    last().exit(1);
    await expect(p).rejects.toMatchObject({ code: 'exited' });
  });

  it('pings only after 15 s of silence and kills after 45 s with no frame', () => {
    const { channel, last, logs } = make();
    channel.start();
    const child = last();
    child.hello();
    vi.advanceTimersByTime(14_900);
    expect(child.requests().filter((r) => r.method === 'ping')).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(child.requests().filter((r) => r.method === 'ping')).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    expect(child.requests().filter((r) => r.method === 'ping')).toHaveLength(1);
    expect(child.killed).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(child.killed).toBe(true);
    expect(channel.state).toBe('reconnecting');
    expect(logs.some((l) => l.event === 'host-helper' && l.detail.reason === 'silence')).toBe(true);
  });

  it('any frame resets the silence clock (a busy helper answering pings is not killed)', () => {
    const { channel, last } = make();
    channel.start();
    const child = last();
    child.hello();
    void channel.request('store.list').catch(() => undefined);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(15_100);
      const ping = child.requests().filter((r) => r.method === 'ping').pop()!;
      child.send({ id: ping.id, result: {} });
    }
    expect(child.killed).toBe(false);
    expect(channel.state).toBe('ready');
  });

  it('no hello within 20 s → killed, failed start, backoff 60 s', () => {
    const { channel, children, last } = make();
    channel.start();
    vi.advanceTimersByTime(19_900);
    expect(last().killed).toBe(false);
    vi.advanceTimersByTime(200);
    expect(last().killed).toBe(true);
    expect(channel.info().failures).toBe(1);
    expect(channel.state).toBe('reconnecting');
    vi.advanceTimersByTime(59_000);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(children).toHaveLength(2);
  });

  it('exit within 60 s of hello counts as a failed start; three → degraded, no further spawns until reset', () => {
    const { channel, children, last } = make();
    channel.start();
    for (let i = 0; i < 3; i++) {
      last().hello();
      last().exit(1);
      vi.advanceTimersByTime(130_000);
    }
    expect(channel.state).toBe('degraded');
    expect(channel.info()).toMatchObject({ failures: 3, open: true });
    expect(children).toHaveLength(3);
    vi.advanceTimersByTime(3_600_000);
    channel.start();
    expect(children).toHaveLength(3);
    channel.reset();
    expect(children).toHaveLength(4);
    expect(channel.state).toBe('starting');
  });

  it('a spawn that throws counts as a failed start', () => {
    let calls = 0;
    const channel = new HostChannel(
      HOST,
      () => {
        calls++;
        throw new Error('ENOENT');
      },
      { log: () => undefined },
    );
    channel.start();
    expect(calls).toBe(1);
    expect(channel.info().failures).toBe(1);
    expect(channel.state).toBe('reconnecting');
  });

  it('exit after 60 s stable ready resets the failures and respawns at once', () => {
    const { channel, children, last } = make();
    channel.start();
    last().exit(1); // failure 1
    vi.advanceTimersByTime(60_000);
    const child = last();
    child.hello();
    for (let t = 0; t < 70_000; t += 10_000) {
      vi.advanceTimersByTime(10_000);
      child.send({ method: 'store.changed', params: {} });
    }
    expect(channel.info().failures).toBe(0);
    child.exit(1);
    expect(children).toHaveLength(3);
    expect(channel.state).toBe('starting');
  });

  it('exit 86 → redeploy + immediate respawn, not counted toward the breaker', async () => {
    const redeploy = vi.fn(async () => true);
    const { channel, children, last } = make({ redeploy });
    channel.start();
    last().exit(86);
    expect(redeploy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    expect(channel.info().failures).toBe(0);
    last().hello();
    expect(channel.state).toBe('ready');
  });

  it('a second consecutive 86 right after a redeploy is a failed start (no redeploy loop)', async () => {
    const redeploy = vi.fn(async () => true);
    const { channel, children, last } = make({ redeploy });
    channel.start();
    last().exit(86);
    await vi.advanceTimersByTimeAsync(0);
    last().exit(86);
    await vi.advanceTimersByTimeAsync(0);
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(2);
    expect(channel.info().failures).toBe(1);
    expect(channel.state).toBe('reconnecting');
  });

  it('a failed redeploy counts as a failed start', async () => {
    const { channel, children, last } = make({ redeploy: async () => false });
    channel.start();
    last().exit(86);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);
    expect(channel.info().failures).toBe(1);
  });

  it('stop(): stdin end, kill after the grace, no respawn; start() later spawns afresh', () => {
    const { channel, children, last } = make();
    channel.start();
    const child = last();
    child.hello();
    const pending = channel.request('store.list');
    pending.catch(() => undefined);
    channel.stop();
    expect(child.stdinEnded).toBe(true);
    expect(child.killed).toBe(false);
    expect(channel.state).toBe('reconnecting');
    vi.advanceTimersByTime(1_100);
    expect(child.killed).toBe(true);
    vi.advanceTimersByTime(600_000);
    expect(children).toHaveLength(1);
    expect(channel.info().failures).toBe(0);
    channel.start();
    expect(children).toHaveLength(2);
  });

  it('oversize frame → host-rpc-error too-large, channel survives', async () => {
    const { channel, last, logs } = make({ maxFrameBytes: 200 });
    channel.start();
    last().hello();
    last().raw(`{"id":1,"result":"${'x'.repeat(400)}"}\n`);
    expect(logs.find((l) => l.event === 'host-rpc-error')?.detail).toMatchObject({ host: 'wsl:Fake', code: 'too-large' });
    expect(channel.state).toBe('ready');
    const p = channel.request<{ ok: boolean }>('ping');
    const id = last().requests().pop()!.id;
    last().send({ id, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('notifications reach subscribers until unsubscribed', () => {
    const { channel, last } = make();
    channel.start();
    last().hello();
    const seen: unknown[] = [];
    const off = channel.onNotification('store.changed', (p) => seen.push(p));
    last().send({ method: 'store.changed', params: { files: ['a'] } });
    off();
    last().send({ method: 'store.changed', params: { files: ['b'] } });
    expect(seen).toEqual([{ files: ['a'] }]);
  });

  it('test backoff override replaces every BACKOFF_MS step', () => {
    const children: FakeChild[] = [];
    const channel = new HostChannel(
      HOST,
      () => {
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
      { log: () => undefined, backoffMs: 500 },
    );
    channel.start();
    children[0]!.exit(1);
    vi.advanceTimersByTime(499);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(children).toHaveLength(2);
  });
});

describe('HostChannel fix round 1', () => {
  it('canSpawn gates every spawn: a stable exit with the distro gone does not respawn', async () => {
    let allowed = true;
    const canSpawn = vi.fn(async () => allowed);
    const { channel, children, last, logs } = make({ canSpawn });
    channel.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);
    const child = last();
    child.hello();
    for (let t = 0; t < 70_000; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      child.send({ method: 'store.changed', params: {} });
    }
    // `wsl --terminate`: the helper dies, the stable-exit path wants an immediate respawn.
    allowed = false;
    child.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);
    expect(channel.info().running).toBe(false);
    expect(channel.state).toBe('reconnecting');
    expect(logs.some((l) => l.event === 'host-helper' && l.detail.reason === 'distro-unavailable')).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(children).toHaveLength(1);
    allowed = true;
    channel.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
  });

  it('canSpawn gates the backoff timer, the post-redeploy respawn and reset()', async () => {
    let allowed = true;
    const canSpawn = vi.fn(async () => allowed);
    const redeploy = vi.fn(async () => true);
    const { channel, children, last } = make({ canSpawn, redeploy });
    channel.start();
    await vi.advanceTimersByTimeAsync(0);
    last().exit(1); // failed start → 60 s backoff
    allowed = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(children).toHaveLength(1);
    allowed = true;
    channel.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    allowed = false;
    last().exit(86);
    await vi.advanceTimersByTimeAsync(0);
    // The redeploy is a `wsl.exe -d D` run too: gated like a spawn (M1).
    expect(redeploy).toHaveBeenCalledTimes(0);
    expect(children).toHaveLength(2);
    allowed = false;
    channel.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
  });

  it('every redeploy runs the spawn gate first; a refusal halts as distro-unavailable', async () => {
    let allowed = true;
    const canSpawn = vi.fn(async () => allowed);
    const redeploy = vi.fn(async () => true);
    const { channel, children, last, logs } = make({ canSpawn, redeploy, bundlePreexisting: () => true });
    channel.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);
    // `wsl --terminate` between spawn and hello: the pre-existing bundle's
    // early-exit redeploy must not boot the now-Stopped distro.
    allowed = false;
    const gatesBefore = canSpawn.mock.calls.length;
    last().exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(canSpawn.mock.calls.length).toBe(gatesBefore + 1);
    expect(redeploy).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    expect(channel.info()).toMatchObject({ running: false, failures: 0 });
    expect(channel.state).toBe('reconnecting');
    expect(logs.some((l) => l.event === 'host-helper' && l.detail.reason === 'distro-unavailable')).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(redeploy).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    // The distro is back: reset spawns; the gate allows the exit-86 redeploy.
    allowed = true;
    channel.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    last().exit(86);
    await vi.advanceTimersByTimeAsync(0);
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(3);
  });

  it('a stop() while the redeploy gate is in flight neither redeploys nor spawns', async () => {
    let release: (ok: boolean) => void = () => undefined;
    let calls = 0;
    const canSpawn = vi.fn(() => {
      calls++;
      return calls === 1 ? Promise.resolve(true) : new Promise<boolean>((r) => (release = r));
    });
    const redeploy = vi.fn(async () => true);
    const { channel, children, last } = make({ canSpawn, redeploy });
    channel.start();
    await vi.advanceTimersByTimeAsync(0);
    last().exit(86);
    await vi.advanceTimersByTimeAsync(0);
    channel.stop();
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(redeploy).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    expect(channel.info().running).toBe(false);
  });

  it('killStopped(): a child still alive after stop() is killed synchronously (quit)', () => {
    const { channel, last } = make();
    channel.start();
    const child = last();
    child.hello();
    channel.stop();
    expect(child.killed).toBe(false);
    channel.killStopped();
    expect(child.killed).toBe(true);
  });

  it('hello hash mismatch → kill + redeploy once; a second mismatch → degraded', async () => {
    const redeploy = vi.fn(async () => true);
    const { channel, children, last, logs } = make({ redeploy, expectedHash: 'abcdef012345' });
    channel.start();
    last().hello('000000000000');
    expect(last().killed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(2);
    expect(channel.info().failures).toBe(0);
    last().hello('000000000000');
    await vi.advanceTimersByTimeAsync(0);
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(channel.state).toBe('degraded');
    expect(logs.some((l) => l.event === 'host-helper' && l.detail.state === 'degraded' && l.detail.reason === 'hash-mismatch')).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(children).toHaveLength(2);
  });

  it('a matching hello hash goes ready', () => {
    const { channel, last } = make({ expectedHash: 'abcdef012345' });
    channel.start();
    last().hello('abcdef012345');
    expect(channel.state).toBe('ready');
  });
});

describe('HostChannel R26', () => {
  const stable = (child: FakeChild) => {
    child.hello();
    for (let t = 0; t < 70_000; t += 10_000) {
      vi.advanceTimersByTime(10_000);
      child.send({ method: 'store.changed', params: {} });
    }
  };

  it('sleep/resume: the first tick after a wall-clock jump does not kill; ping-then-kill decides', () => {
    const { channel, children, last, logs } = make();
    channel.start();
    const child = last();
    child.hello();
    vi.advanceTimersByTime(5_000);
    // Laptop sleeps 10 min: timers don't run, the wall clock jumps.
    vi.setSystemTime(Date.now() + 600_000);
    vi.advanceTimersByTime(100);
    expect(child.killed).toBe(false);
    expect(children).toHaveLength(1);
    expect(logs.some((l) => l.event === 'host-helper-wake')).toBe(true);
    // The helper answers its ping after the silence window → stays up.
    vi.advanceTimersByTime(15_000);
    const ping = child
      .requests()
      .filter((r) => r.method === 'ping')
      .pop();
    expect(ping).toBeDefined();
    child.send({ id: ping!.id, result: {} });
    vi.advanceTimersByTime(20_000);
    expect(child.killed).toBe(false);
    expect(channel.state).toBe('ready');
  });

  it('sleep/resume: a helper that stays silent after the wake is killed only after the full ladder', () => {
    const { channel, last } = make();
    channel.start();
    const child = last();
    child.hello();
    vi.setSystemTime(Date.now() + 600_000);
    vi.advanceTimersByTime(100);
    expect(child.killed).toBe(false);
    vi.advanceTimersByTime(44_000);
    expect(child.killed).toBe(false);
    vi.advanceTimersByTime(1_100);
    expect(child.killed).toBe(true);
  });

  it('three stable crashes within 10 min → degraded (crash-loop); reset() restarts', () => {
    const { channel, children, last, logs } = make();
    channel.start();
    for (let i = 0; i < 3; i++) {
      stable(last());
      last().exit(1);
    }
    expect(channel.state).toBe('degraded');
    expect(
      logs.some((l) => l.event === 'host-helper' && l.detail.state === 'degraded' && l.detail.reason === 'crash-loop'),
    ).toBe(true);
    expect(children).toHaveLength(3);
    vi.advanceTimersByTime(3_600_000);
    expect(children).toHaveLength(3);
    channel.reset();
    expect(children).toHaveLength(4);
    expect(channel.state).toBe('starting');
  });

  it('a pre-existing bundle that dies before hello is redeployed once per run', async () => {
    const redeploy = vi.fn(async () => true);
    const { channel, children, last } = make({ redeploy, bundlePreexisting: () => true });
    channel.start();
    last().exit(1); // truncated file: node fails to parse it
    expect(redeploy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    expect(channel.info().failures).toBe(0);
    last().hello();
    expect(channel.state).toBe('ready');
    // Never again this run: a later early death counts as a failure.
    last().exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(channel.info().failures).toBe(1);
  });

  it('no early redeploy for a fresh deploy or a hello timeout (a wedged VM)', () => {
    const redeploy = vi.fn(async () => true);
    const fresh = make({ redeploy, bundlePreexisting: () => false });
    fresh.channel.start();
    fresh.last().exit(1);
    expect(redeploy).not.toHaveBeenCalled();
    const hung = make({ redeploy, bundlePreexisting: () => true });
    hung.channel.start();
    vi.advanceTimersByTime(20_100);
    expect(hung.last().killed).toBe(true);
    expect(redeploy).not.toHaveBeenCalled();
    expect(hung.channel.info().failures).toBe(1);
  });
});
