import { useSyncExternalStore } from 'react';

// Client for a main-process pushed store: one subscription + one initial fetch
// lazily on first use; every listener unsubscribes on unmount.
export type PushedStateClient<T> = {
  subscribe(callback: () => void): () => void;
  get(): T | null;
};

export function createPushedStateClient<T>(api: {
  onState(listener: (next: T) => void): void;
  getState(): Promise<T>;
}): PushedStateClient<T> {
  let current: T | null = null;
  const listeners = new Set<() => void>();
  let subscribed = false;

  function emit(): void {
    listeners.forEach((listener) => listener());
  }

  return {
    get: () => current,
    subscribe(callback) {
      listeners.add(callback);
      if (!subscribed) {
        subscribed = true;
        api.onState((next) => {
          current = next;
          emit();
        });
        void api.getState().then((next) => {
          current = next;
          emit();
        });
      }
      return () => listeners.delete(callback);
    },
  };
}

export function usePushedState<T>(client: PushedStateClient<T>): T | null {
  return useSyncExternalStore(client.subscribe, client.get);
}
