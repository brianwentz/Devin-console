// Multi-subscriber notification point (add returns the unsubscribe). One
// throwing listener never keeps the others from running.
export interface ListenerSet {
  add(listener: () => void): () => void;
  emit(): void;
  size(): number;
}

export function createListenerSet(onError?: (error: unknown) => void): ListenerSet {
  const listeners = new Set<() => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          onError?.(error);
        }
      }
    },
    size: () => listeners.size,
  };
}
