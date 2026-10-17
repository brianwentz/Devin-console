import { useSyncExternalStore } from 'react';
import type { ClaudeChatStatePublic } from '../../shared/ipc';

let current: ClaudeChatStatePublic | null = null;
const listeners = new Set<() => void>();
let subscribed = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!subscribed) {
    subscribed = true;
    window.devinworkspaces.onClaudeChatState((next) => {
      current = next;
      emit();
    });
    void window.devinworkspaces.getClaudeChatState().then((next) => {
      current = next;
      emit();
    });
  }
  return () => listeners.delete(callback);
}

export function useClaudeChatState(): ClaudeChatStatePublic | null {
  return useSyncExternalStore(subscribe, () => current);
}
