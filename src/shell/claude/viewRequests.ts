import { useSyncExternalStore } from 'react';

// Sidebar → ClaudeView requests ("open this session's terminal"). Each request
// bumps `seq` so a repeat for the same session re-triggers.
export interface TerminalRequest {
  seq: number;
  sessionId: string;
  agentId?: string;
}

let current: TerminalRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function requestTerminal(sessionId: string, agentId?: string): void {
  seq += 1;
  current = agentId ? { seq, sessionId, agentId } : { seq, sessionId };
  emit();
}

export function consumeTerminalRequest(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  emit();
}

export function useTerminalRequest(): TerminalRequest | null {
  return useSyncExternalStore(subscribe, () => current);
}

// Last Chat/Terminal tab per session (shell memory only, not persisted):
// switching sessions returns to the tab you were on. Default 'chat'.
export type ClaudeViewTab = 'chat' | 'terminal';
const lastView = new Map<string, ClaudeViewTab>();

export function getLastView(sessionId: string): ClaudeViewTab {
  return lastView.get(sessionId) ?? 'chat';
}

export function rememberView(sessionId: string, view: ClaudeViewTab): void {
  lastView.set(sessionId, view);
}
