import { describe, expect, it } from 'vitest';
import { createReloadGuard } from '../../src/core/reloadGuard';

describe('createReloadGuard', () => {
  it('runs the first request, reports the first drop once, then drops silently', () => {
    const guard = createReloadGuard<object>();
    const key = {};
    expect(guard.request(key)).toBe('run');
    expect(guard.request(key)).toBe('coalesce');
    expect(guard.request(key)).toBe('drop');
    expect(guard.request(key)).toBe('drop');
  });

  it('runs again after done, with a fresh coalesce report', () => {
    const guard = createReloadGuard<object>();
    const key = {};
    expect(guard.request(key)).toBe('run');
    expect(guard.request(key)).toBe('coalesce');
    guard.done(key);
    expect(guard.request(key)).toBe('run');
    expect(guard.request(key)).toBe('coalesce');
  });

  it('keeps targets independent', () => {
    const guard = createReloadGuard<object>();
    const a = {};
    const b = {};
    expect(guard.request(a)).toBe('run');
    expect(guard.request(b)).toBe('run');
    expect(guard.request(a)).toBe('coalesce');
    guard.done(a);
    expect(guard.request(b)).toBe('coalesce');
  });
});
