// In-flight guard for reloads that wait on a diagnostic snapshot: while one is
// pending for a target, further requests are dropped; only the first drop is
// reported so a held-down F5 cannot flood the log.

export type ReloadGuardDecision = 'run' | 'coalesce' | 'drop';

export interface ReloadGuard<K extends object> {
  // 'run' = start (the key is now pending), 'coalesce' = first drop, 'drop' = later drops.
  request(key: K): ReloadGuardDecision;
  // The pending reload ran; the next request for `key` runs again.
  done(key: K): void;
}

export function createReloadGuard<K extends object>(): ReloadGuard<K> {
  // Value = whether a drop was already reported for the pending reload.
  const pending = new WeakMap<K, boolean>();
  return {
    request(key) {
      const reported = pending.get(key);
      if (reported === undefined) {
        pending.set(key, false);
        return 'run';
      }
      if (reported) return 'drop';
      pending.set(key, true);
      return 'coalesce';
    },
    done(key) {
      pending.delete(key);
    },
  };
}
