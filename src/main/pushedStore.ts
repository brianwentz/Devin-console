import type { ZodType } from 'zod';
import { log } from './log';
import { state, type ViewName } from './state';

// In-memory state mutated only through `update()`; pushes are coalesced per
// tick so a burst of updates becomes one IPC message to the shell.
export type PushedStore<T> = {
  get(): T;
  replace(next: T): void;
  update(reducer: (state: T) => T): T;
  publicState(): T;
  publish(): void;
};

export function createPushedStore<T>(opts: {
  // The public schema — its output is a distinct "public" type (optional
  // fields become `| undefined` under exactOptionalPropertyTypes), so it's
  // not nominally assignable to `T`; the success branch casts.
  schema: ZodType;
  channel: string;
  initial: T;
  // What `publicState` returns when validation fails (may read current).
  empty: (current: T) => T;
  logTag: ViewName;
  logEvent: string;
}): PushedStore<T> {
  let current: T = opts.initial;
  let scheduled = false;

  function schedulePublish(): void {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      store.publish();
    });
  }

  const store: PushedStore<T> = {
    get: () => current,
    replace(next) {
      current = next;
      schedulePublish();
    },
    update(reducer) {
      const next = reducer(current);
      if (next !== current) {
        current = next;
        schedulePublish();
      }
      return current;
    },
    publicState() {
      // Validate the outgoing payload so the renderer never sees malformed state.
      try {
        const parsed = opts.schema.safeParse(current);
        if (parsed.success) return parsed.data as T;
        log(opts.logTag, opts.logEvent, {
          detail: { issues: parsed.error.issues.slice(0, 5) },
        });
      } catch (error) {
        log(opts.logTag, opts.logEvent, { detail: { thrown: String(error) } });
      }
      return opts.empty(current);
    },
    publish() {
      const view = state.shellView;
      // `webContents` is undefined once the owning window has been destroyed.
      if (!view?.webContents || view.webContents.isDestroyed()) return;
      view.webContents.send(opts.channel, store.publicState());
    },
  };
  return store;
}
