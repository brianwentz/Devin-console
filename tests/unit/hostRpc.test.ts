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
