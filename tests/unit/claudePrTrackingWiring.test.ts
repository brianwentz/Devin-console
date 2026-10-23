import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    addChangeListener: vi.fn((_fn: () => void) => unsubscribe),
    prTitles: { ghResolver: null as unknown, ensure: vi.fn(), getInfo: vi.fn() },
  };
});

vi.mock('../../src/main/prTitles', () => ({
  prTitles: Object.assign(h.prTitles, { addChangeListener: h.addChangeListener }),
}));
vi.mock('../../src/main/log', () => ({ log: () => {} }));
vi.mock('../../src/main/state', () => ({ state: {} }));
vi.mock('../../src/main/notifications', () => ({ notificationStore: () => ({ add: () => {} }) }));
vi.mock('../../src/main/prs', () => ({ allOpenPullRequests: () => [], prStore: () => ({ reconcile: () => {} }) }));
vi.mock('../../src/main/hosts', () => ({ hosts: () => ({}) }));

import { ClaudePrTracking } from '../../src/main/claude/prTracking';

afterEach(() => vi.clearAllMocks());

describe('ClaudePrTracking prTitles subscription', () => {
  it('start() subscribes through addChangeListener and stop() unsubscribes', () => {
    const tracking = new ClaudePrTracking({} as never);
    tracking.start();
    expect(h.addChangeListener).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).not.toHaveBeenCalled();
    tracking.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    tracking.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a second start() replaces the first subscription', () => {
    const tracking = new ClaudePrTracking({} as never);
    tracking.start();
    tracking.start();
    expect(h.addChangeListener).toHaveBeenCalledTimes(2);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    tracking.stop();
  });
});
