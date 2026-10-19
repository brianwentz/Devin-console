import { emptyLocalState, type LocalState } from '../../core/localModel';
import { IpcChannels, LocalStateSchema } from '../../shared/ipc';
import { createPushedStore } from '../pushedStore';

// In-memory LocalState; mutated only through `update()` with pure reducers from
// core/localModel. Pushes are coalesced per tick so a burst of session/update
// notifications becomes one `local:update` message.
const store = createPushedStore<LocalState>({
  schema: LocalStateSchema,
  channel: IpcChannels.localUpdate,
  initial: emptyLocalState(null),
  empty: (current) => emptyLocalState(current.cliPath),
  logTag: 'local',
  logEvent: 'state-invalid',
});

export function getLocalState(): LocalState {
  return store.get();
}

export function replaceLocalState(next: LocalState): void {
  store.replace(next);
}

export function update(reducer: (state: LocalState) => LocalState): LocalState {
  return store.update(reducer);
}

export function publicLocalState(): LocalState {
  return store.publicState();
}

export function publishLocalState(): void {
  store.publish();
}
