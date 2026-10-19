import { useSyncExternalStore } from 'react';
import type { LocalStatePublic } from '../../shared/ipc';
import { createPushedStateClient, usePushedState } from '../pushedState';

const client = createPushedStateClient<LocalStatePublic>({
  onState: (listener) => window.devinworkspaces.onLocalState(listener),
  getState: () => window.devinworkspaces.getLocalState(),
});

export function useLocalState(): LocalStatePublic | null {
  return usePushedState(client);
}

// Transient selection (shell memory only): the workspace whose header was
// clicked last — falls back to the selected session's workspace.
let selectedWorkspace: string | null = null;
const listeners = new Set<() => void>();
function notify(): void {
  listeners.forEach((l) => l());
}
export function selectWorkspace(path: string | null): void {
  if (selectedWorkspace === path) return;
  selectedWorkspace = path;
  notify();
}
export function useSelectedWorkspace(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selectedWorkspace,
  );
}

// Sidebar → LocalPanel requests ("open this session's terminal"). Each
// request bumps `seq` so a repeat for the same session re-triggers.
export interface LocalTerminalRequest {
  seq: number;
  sessionId: string;
}
let current: LocalTerminalRequest | null = null;
let seq = 0;
export function requestTerminal(sessionId: string): void {
  seq += 1;
  current = { seq, sessionId };
  notify();
}
export function consumeTerminalRequest(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  notify();
}
export function useTerminalRequest(): LocalTerminalRequest | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
