import { describe, expect, it } from 'vitest';
import { poolFor, poolForSurface, pools, registerPool } from '../../src/main/cloudKit/pools';
import type { ViewPool } from '../../src/main/cloudKit/viewPool';

// pools.ts only needs providerId; the electron-backed ViewPool is stubbed.
const fake = (providerId: string) => ({ providerId }) as unknown as ViewPool;

describe('view pool registry', () => {
  it('registers once per provider and looks pools up by id and surface', () => {
    const devin = fake('devin-cloud');
    registerPool(devin);
    registerPool(devin); // same instance: no-op
    expect(pools()).toEqual([devin]);
    expect(poolFor('devin-cloud')).toBe(devin);
    expect(poolFor('claude')).toBeUndefined();
    expect(poolForSurface('cloud')).toBe(devin);
    expect(poolForSurface('claude')).toBeUndefined();
    expect(poolForSurface('settings')).toBeUndefined();
    expect(() => registerPool(fake('devin-cloud'))).toThrow(/already registered/);
    expect(pools()).toHaveLength(1);
  });
});
