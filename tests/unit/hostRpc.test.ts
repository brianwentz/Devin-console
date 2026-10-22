import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS,
  FrameTooLarge,
  LineDecoder,
  STABLE_MS,
  encodeFrame,
  onExit,
  onReady,
  onStartFailed,
  onTick,
  resetBreaker,
  HELLO_DEADLINE_MS,
  SILENCE_KILL_MS,
  SILENCE_PING_MS,
  livenessAction,
  livenessTick,
  isCrashLoop,
  CRASH_LOOP_EXITS,
  CRASH_LOOP_WINDOW_MS,
  CLOCK_JUMP_TICKS,
  requestTimeoutMs,
} from '../../src/core/hostRpc';

describe('LineDecoder', () => {
  it('decodes split chunks', () => {
    const d = new LineDecoder();
    expect(d.push('{"id":1,"re')).toEqual([]);
    expect(d.push('sult":2}\n{"method":"x"')).toEqual([{ id: 1, result: 2 }]);
    expect(d.push(',"params":null}\n')).toEqual([{ method: 'x', params: null }]);
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores noise before hello', () => {
    const d = new LineDecoder();
    const out = d.push('Welcome to zsh\n\n[oh-my-zsh] update?\n{"method":"hello","params":{"protocol":1}}\n');
    expect(out).toEqual([{ method: 'hello', params: { protocol: 1 } }]);
    expect(new LineDecoder().push('42\ntrue\nnull\n"x"\n[]\n[{"a":1}]\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it('oversize frame → too-large, decoder resyncs', () => {
    const d = new LineDecoder(16);
    const out = [...d.push('{"x":"' + 'a'.repeat(40)), ...d.push('bbbb"}\n{"ok":1}\n')];
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(FrameTooLarge);
    expect(out[1]).toEqual({ ok: 1 });
  });

  it('flags a complete oversize line in one chunk and keeps going', () => {
    const d = new LineDecoder(16);
    const out = d.push('{"x":"' + 'a'.repeat(40) + '"}\n{"ok":1}\n');
    expect(out[0]).toBeInstanceOf(FrameTooLarge);
    expect(out[1]).toEqual({ ok: 1 });
  });

  it('handles CRLF line endings', () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\r\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('decodes a multi-byte character split across chunks', () => {
    const d = new LineDecoder();
    const bytes = Buffer.from('{"s":"é€😀"}\n', 'utf8');
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...d.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual([{ s: 'é€😀' }]);
  });
});

describe('encodeFrame', () => {
  it('encodeFrame round-trips', () => {
    const msgs = [
      { id: 1, method: 'a', params: { s: 'é\nline' } },
      { id: 2, result: [1, 2] },
      { id: 3, error: { code: 'E', message: 'm' } },
      { method: 'n', params: null },
    ];
    const d = new LineDecoder();
    const wire = msgs.map(encodeFrame).join('');
    for (const m of msgs) expect(encodeFrame(m).endsWith('\n')).toBe(true);
    expect(d.push(wire)).toEqual(msgs);
  });
});

describe('breaker', () => {
  it('breaker opens on 3rd failure with 60/120 s spacing (both BACKOFF_MS steps used)', () => {
    let s = resetBreaker();
    s = onStartFailed(s, 1000);
    expect(s).toMatchObject({ failures: 1, open: false, nextAttemptAt: 1000 + BACKOFF_MS[0] });
    s = onStartFailed(s, 70_000);
    expect(s).toMatchObject({ failures: 2, open: false, nextAttemptAt: 70_000 + BACKOFF_MS[1] });
    s = onStartFailed(s, 200_000);
    expect(s.failures).toBe(3);
    expect(s.open).toBe(true);
    expect(s.nextAttemptAt).toBeNull();
  });

  it('exit within 60 s of hello counts as a failed start', () => {
    let s = onReady(resetBreaker(), 1000);
    s = onExit(s, 1000 + STABLE_MS - 1);
    expect(s.failures).toBe(1);
    expect(s.readySince).toBeNull();
    expect(s.nextAttemptAt).toBe(1000 + STABLE_MS - 1 + BACKOFF_MS[0]);
  });

  it('open breaker stays open across onReady/onTick/onExit', () => {
    let open = resetBreaker();
    for (let i = 0; i < 3; i++) open = onStartFailed(open, i);
    expect(open.open).toBe(true);
    const ready = onReady(open, 0);
    expect(ready).toEqual(open);
    const stuck = { ...open, readySince: 0 };
    expect(onTick(stuck, STABLE_MS * 2)).toBe(stuck);
    expect(onExit(stuck, STABLE_MS * 2)).toBe(stuck);
    expect(onExit(stuck, 5)).toBe(stuck);
  });

  it('onReady clears nextAttemptAt', () => {
    const s = onStartFailed(resetBreaker(), 0);
    expect(s.nextAttemptAt).not.toBeNull();
    expect(onReady(s, 10).nextAttemptAt).toBeNull();
  });

  it('exit before ever being ready counts as a failed start', () => {
    expect(onExit(resetBreaker(), 5).failures).toBe(1);
  });

  it('reset only after 60 s ready', () => {
    let s = onStartFailed(resetBreaker(), 0);
    s = onReady(s, 100);
    expect(onTick(s, 100 + STABLE_MS - 1).failures).toBe(1);
    expect(onTick(s, 100 + STABLE_MS).failures).toBe(0);
    const stable = onExit(s, 100 + STABLE_MS + 5);
    expect(stable.failures).toBe(0);
    expect(stable.nextAttemptAt).toBeNull();
    expect(stable.open).toBe(false);
  });
});

describe('liveness and timeouts', () => {
  it('pings only after the silence window, once per quiet spell', () => {
    expect(livenessAction(14_999, 0, false, SILENCE_PING_MS, SILENCE_KILL_MS)).toBe('none');
    expect(livenessAction(15_000, 0, false, SILENCE_PING_MS, SILENCE_KILL_MS)).toBe('ping');
    expect(livenessAction(20_000, 0, true, SILENCE_PING_MS, SILENCE_KILL_MS)).toBe('none');
  });

  it('kills after 45 s with no frame at all, ping outstanding or not', () => {
    expect(livenessAction(44_999, 0, true, SILENCE_PING_MS, SILENCE_KILL_MS)).toBe('none');
    expect(livenessAction(45_000, 0, true, SILENCE_PING_MS, SILENCE_KILL_MS)).toBe('kill');
    expect(livenessAction(45_000, 0, false, SILENCE_PING_MS, SILENCE_KILL_MS)).toBe('kill');
  });

  it('constants match the protocol table', () => {
    expect(SILENCE_PING_MS).toBe(15_000);
    expect(SILENCE_KILL_MS).toBe(45_000);
    expect(HELLO_DEADLINE_MS).toBe(20_000);
  });

  it('request timeout is 10 s except store.list / usage.scan (60 s)', () => {
    expect(requestTimeoutMs('ping')).toBe(10_000);
    expect(requestTimeoutMs('env.get')).toBe(10_000);
    expect(requestTimeoutMs('store.messages')).toBe(10_000);
    expect(requestTimeoutMs('store.list')).toBe(60_000);
    expect(requestTimeoutMs('usage.scan')).toBe(60_000);
  });
});

describe('R26 clock jump (sleep/resume)', () => {
  const TICK = 1_000;
  it('a tick gap > 3 ticks is a clock jump: the silence clock restarts, no kill', () => {
    const r = livenessTick(
      { lastTickAt: 1_000, lastFrameAt: 0, pingOutstanding: true },
      1_000 + 600_000,
      SILENCE_PING_MS,
      SILENCE_KILL_MS,
      TICK,
    );
    expect(r.jumped).toBe(true);
    expect(r.action).toBe('none');
    expect(r.clock).toEqual({ lastTickAt: 601_000, lastFrameAt: 601_000, pingOutstanding: false });
  });

  it('after a jump the ping-then-kill ladder decides', () => {
    let c = livenessTick(
      { lastTickAt: 0, lastFrameAt: 0, pingOutstanding: false },
      600_000,
      SILENCE_PING_MS,
      SILENCE_KILL_MS,
      TICK,
    ).clock;
    let t = 600_000;
    const actions: string[] = [];
    while (t < 600_000 + SILENCE_KILL_MS) {
      t += TICK;
      const r = livenessTick(c, t, SILENCE_PING_MS, SILENCE_KILL_MS, TICK);
      expect(r.jumped).toBe(false);
      if (r.action !== 'none') actions.push(`${r.action}@${t - 600_000}`);
      c = { ...r.clock, pingOutstanding: r.action === 'ping' ? true : r.clock.pingOutstanding };
    }
    expect(actions).toEqual([`ping@${SILENCE_PING_MS}`, `kill@${SILENCE_KILL_MS}`]);
  });

  it('exactly 3 ticks of gap is not a jump; the first tick (no lastTickAt) never is', () => {
    expect(CLOCK_JUMP_TICKS).toBe(3);
    const atLimit = livenessTick(
      { lastTickAt: 0, lastFrameAt: 0, pingOutstanding: false },
      3 * TICK,
      SILENCE_PING_MS,
      SILENCE_KILL_MS,
      TICK,
    );
    expect(atLimit.jumped).toBe(false);
    const first = livenessTick(
      { lastTickAt: null, lastFrameAt: 0, pingOutstanding: false },
      SILENCE_KILL_MS,
      SILENCE_PING_MS,
      SILENCE_KILL_MS,
      TICK,
    );
    expect(first.jumped).toBe(false);
    expect(first.action).toBe('kill');
  });
});

describe('R26 stable crash loop', () => {
  const stableExit = (s: ReturnType<typeof resetBreaker>, at: number) => onExit(onReady(s, at - STABLE_MS - 1), at);

  it('3 stable exits within 10 min open the breaker as a crash loop', () => {
    expect(CRASH_LOOP_EXITS).toBe(3);
    expect(CRASH_LOOP_WINDOW_MS).toBe(600_000);
    let s = resetBreaker();
    s = stableExit(s, 100_000);
    expect(s.open).toBe(false);
    s = stableExit(s, 200_000);
    expect(s.open).toBe(false);
    expect(isCrashLoop(s)).toBe(false);
    s = stableExit(s, 300_000);
    expect(s.open).toBe(true);
    expect(isCrashLoop(s)).toBe(true);
  });

  it('stable exits spread beyond the window never open it', () => {
    let s = resetBreaker();
    for (let i = 1; i <= 10; i++) {
      s = stableExit(s, i * 300_001);
      expect(s.open).toBe(false);
    }
  });

  it('failed starts in between keep the stable-exit history; resetBreaker clears it', () => {
    let s = stableExit(resetBreaker(), 100_000);
    s = onStartFailed(s, 110_000);
    s = stableExit(s, 250_000);
    s = stableExit(s, 400_000);
    expect(isCrashLoop(s)).toBe(true);
    expect(isCrashLoop(resetBreaker())).toBe(false);
    expect(resetBreaker().stableExits).toEqual([]);
  });

  it('a failed-start-opened breaker is not a crash loop', () => {
    let s = resetBreaker();
    for (let i = 0; i < 3; i++) s = onStartFailed(s, i);
    expect(s.open).toBe(true);
    expect(isCrashLoop(s)).toBe(false);
  });
});
