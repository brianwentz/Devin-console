import { describe, expect, it, vi } from 'vitest';
import { createListenerSet } from '../../src/core/listenerSet';

describe('listener set', () => {
  it('fires every listener', () => {
    const set = createListenerSet();
    const a = vi.fn();
    const b = vi.fn();
    set.add(a);
    set.add(b);
    set.emit();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops only that listener', () => {
    const set = createListenerSet();
    const a = vi.fn();
    const b = vi.fn();
    const offA = set.add(a);
    set.add(b);
    offA();
    set.emit();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(set.size()).toBe(1);
  });

  it('a throwing listener does not block the others and is reported', () => {
    const onError = vi.fn();
    const set = createListenerSet(onError);
    const after = vi.fn();
    set.add(() => {
      throw new Error('x');
    });
    set.add(after);
    set.emit();
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a listener may unsubscribe itself while emitting', () => {
    const set = createListenerSet();
    const later = vi.fn();
    const off = set.add(() => off());
    set.add(later);
    set.emit();
    set.emit();
    expect(later).toHaveBeenCalledTimes(2);
    expect(set.size()).toBe(1);
  });
});
