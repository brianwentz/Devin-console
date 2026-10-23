import { describe, expect, it, vi } from 'vitest';
import type { OhRow } from '../../src/core/openhands';
import { createTransitionNotifier } from '../../src/main/openhands/notify';

const row = (id: string, title = 'Secret title'): OhRow => ({
  id,
  title,
  updatedAt: 1,
  status: 'finished',
  section: 'o/r',
  repo: 'o/r',
  gitProvider: 'github',
  prUrls: [],
  cost: null,
});
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

function make(settings: Parameters<typeof createTransitionNotifier>[0]['settings']) {
  const add = vi.fn();
  const log = vi.fn();
  const notify = createTransitionNotifier({ settings, add, log, now: () => 7 });
  return { notify, add, log };
}

describe('transition notifier gate', () => {
  it('adds entries for enabled kinds and logs counts per kind only', () => {
    const { notify, add, log } = make(() => ({ collect: true, kinds: { waiting: true, finished: false, blocked: true } }));
    notify([
      { id: A, kind: 'waiting', row: row(A) },
      { id: B, kind: 'finished', row: row(B) },
    ]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ kind: 'waiting', source: 'openhands', sessionId: A, createdAt: 7 });
    expect(log.mock.calls).toEqual([['openhands-notify', { kind: 'waiting', count: 1 }]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Secret title');
  });
  it('adds nothing when notifications.collect is false', () => {
    const { notify, add, log } = make(() => ({ collect: false, kinds: { waiting: true, finished: true, blocked: true } }));
    notify([{ id: A, kind: 'waiting', row: row(A) }]);
    expect(add).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it('adds nothing for a kind that is switched off', () => {
    const { notify, add } = make(() => ({ collect: true, kinds: { blocked: false } }));
    notify([{ id: A, kind: 'blocked', row: row(A) }]);
    expect(add).not.toHaveBeenCalled();
  });
  it('logs openhands-notify-error with the error name when the store throws', () => {
    const add = vi.fn(() => {
      throw new TypeError('x');
    });
    const log = vi.fn();
    createTransitionNotifier({ settings: () => ({ collect: true }), add, log })([
      { id: A, kind: 'waiting', row: row(A) },
    ]);
    expect(log).toHaveBeenCalledWith('openhands-notify-error', { code: 'TypeError' });
  });
});
