import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerById, type ProviderId } from '../../src/core/providers';
import {
  disposeAll,
  registerRuntime,
  resetRuntimesForTest,
  runtimeFor,
  runtimes,
  allPrsKnown,
  setRuntimeLogger,
  type ProviderRuntime,
} from '../../src/main/providers/runtime';

function fake(id: ProviderId, dispose: () => Promise<void> = async () => {}): ProviderRuntime {
  return { descriptor: providerById(id), start: () => {}, dispose };
}

describe('provider runtime registry', () => {
  beforeEach(() => {
    resetRuntimesForTest();
  });

  it('returns runtimes in registration order', () => {
    registerRuntime(fake('claude'));
    registerRuntime(fake('devin-cloud'));
    expect(runtimes().map((r) => r.descriptor.id)).toEqual(['claude', 'devin-cloud']);
  });

  it('throws on a duplicate id', () => {
    registerRuntime(fake('claude'));
    expect(() => registerRuntime(fake('claude'))).toThrow();
  });

  it('resolves by id or surface', () => {
    registerRuntime(fake('devin-cloud'));
    registerRuntime(fake('devin-local'));
    registerRuntime(fake('claude'));
    expect(runtimeFor('claude')?.descriptor.id).toBe('claude');
    expect(runtimeFor('devin-cloud')?.descriptor.id).toBe('devin-cloud');
    expect(runtimeFor('cloud')?.descriptor.id).toBe('devin-cloud');
    expect(runtimeFor('local')?.descriptor.id).toBe('devin-local');
    expect(runtimeFor('settings')).toBeUndefined();
  });

  it('disposeAll continues past failures and logs the provider id', async () => {
    const log = vi.fn();
    setRuntimeLogger(log);
    const order: string[] = [];
    registerRuntime(
      fake('devin-cloud', () => {
        order.push('devin-cloud');
        throw new Error('sync boom /secret/path');
      }),
    );
    registerRuntime(
      fake('devin-local', async () => {
        order.push('devin-local');
        throw new Error('async boom');
      }),
    );
    registerRuntime(
      fake('claude', async () => {
        order.push('claude');
      }),
    );
    await expect(disposeAll()).resolves.toBeUndefined();
    expect(order).toEqual(['devin-cloud', 'devin-local', 'claude']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, 'provider-dispose-error', { provider: 'devin-cloud' });
    expect(log).toHaveBeenNthCalledWith(2, 'provider-dispose-error', { provider: 'devin-local' });
  });

  it('disposes sequentially', async () => {
    const order: string[] = [];
    registerRuntime(
      fake('devin-cloud', async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
      }),
    );
    registerRuntime(
      fake('claude', async () => {
        order.push('b-start');
      }),
    );
    await disposeAll();
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('prefers an id match over a surface match', () => {
    const odd = fake('devin-local');
    odd.descriptor = { ...odd.descriptor, surface: 'claude' as never };
    registerRuntime(odd);
    registerRuntime(fake('claude'));
    expect(runtimeFor('claude')?.descriptor.id).toBe('claude');
  });
});

describe('allPrsKnown (PR record pruning gate)', () => {
  beforeEach(() => {
    resetRuntimesForTest();
  });

  it('is true when every runtime omits prsKnown or reports true', () => {
    registerRuntime(fake('claude'));
    registerRuntime({ ...fake('devin-cloud'), prsKnown: () => true });
    expect(allPrsKnown()).toBe(true);
  });

  it('is false while any runtime has not listed its PRs yet', () => {
    let devinListed = false;
    registerRuntime({ ...fake('devin-cloud'), prsKnown: () => devinListed });
    registerRuntime({ ...fake('openhands'), prsKnown: () => true });
    expect(allPrsKnown()).toBe(false);
    devinListed = true;
    expect(allPrsKnown()).toBe(true);
  });
});
