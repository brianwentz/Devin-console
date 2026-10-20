import { useSyncExternalStore } from 'react';
import type { SettingsTabId } from '../core/settingsDraft';
import type { ShellState } from '../shared/ipc';
import type { AgentWorkspaceApi } from './preload';

declare global {
  interface Window {
    agentworkspace: AgentWorkspaceApi;
  }
}

let current: ShellState | null = null;
const listeners = new Set<() => void>();
let subscribed = false;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!subscribed) {
    subscribed = true;
    window.agentworkspace.onState((next) => {
      current = next;
      listeners.forEach((listener) => listener());
    });
    void window.agentworkspace.getState().then((next) => {
      current = next;
      listeners.forEach((listener) => listener());
    });
  }
  return () => listeners.delete(callback);
}

export function useShellState(): ShellState | null {
  return useSyncExternalStore(subscribe, () => current);
}

export function getShellState(): ShellState | null {
  return current;
}

// Shell-only (never persisted): the active Settings tab survives surface
// switches but resets to 'general' on restart.
let settingsTab: SettingsTabId = 'general';

export function setSettingsTab(next: SettingsTabId): void {
  if (settingsTab === next) return;
  settingsTab = next;
  listeners.forEach((listener) => listener());
}

export function useSettingsTab(): SettingsTabId {
  return useSyncExternalStore(subscribe, () => settingsTab);
}
