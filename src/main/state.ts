import type { BaseWindow, WebContentsView } from 'electron';
import {
  DEFAULT_PANE_FRACTION,
  DEFAULT_SESSIONS_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
} from '../core/layout';
import type { IdentitySource, Surface } from '../shared/ipc';
import type { CredentialStore } from './credentials';
import type { SettingsStore } from './settings';
import type { TabManager } from './tabs';
import type { CloudViewPool } from './cloudViews';
import type { DevinSession } from '../core/devinApi';
import type { SecretStore } from './secrets';

export type ViewName = 'shell' | 'devin' | 'cloud' | 'analytics' | 'local' | 'claude' | 'host' | `gh:${string}`;

export const testMode = process.env.DEVIN_WORKSPACES_TEST === '1';
export const fixtureOrigins = (testMode ? process.env.DEVIN_WORKSPACES_TEST_GITHUB_ORIGINS ?? '' : '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

export function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Single shared mutable state so the main-process split stays behavior-preserving.
export const state = {
  windowRef: null as BaseWindow | null,
  shellView: null as WebContentsView | null,
  // The active pooled Cloud view — `devinView` reads through to it so the many
  // existing readers keep working; only the pool assigns views.
  cloudViewsRef: null as CloudViewPool | null,
  get devinView(): WebContentsView | null {
    return state.cloudViewsRef?.activeView() ?? null;
  },
  analyticsView: null as WebContentsView | null,
  tabManager: null as TabManager | null,
  settings: null as SettingsStore | null,
  credentials: null as CredentialStore | null,
  tenantUrl: 'https://cloudbeds.devinenterprise.com',
  paneOpen: true,
  paneFraction: DEFAULT_PANE_FRACTION,
  paneCollapsed: false,
  // Cloud session sidebar column (shell-rendered, left of the devin view).
  sessionsOpen: true,
  sessionsWidth: DEFAULT_SESSIONS_WIDTH,
  sessionsCollapsed: false,
  surface: 'cloud' as Surface,
  currentSessionId: null as string | null,
  // Selected Devin Local session — lifted here so it survives surface switches.
  localSessionId: null as string | null,
  // Selected Claude Code session (the sidebar sets it via claude:open).
  claudeSessionId: null as string | null,
  dragStartFraction: DEFAULT_PANE_FRACTION,
  dragLastX: 0,
  dragTimer: null as NodeJS.Timeout | null,
  dragging: false,
  // F5 terminal dock
  terminalOpen: false,
  terminalHeight: DEFAULT_TERMINAL_HEIGHT,
  activeTerminalId: null as string | null,
  dragAxis: 'x' as 'x' | 'y' | 's',
  dragStartHeight: DEFAULT_TERMINAL_HEIGHT,
  dragStartSessionsWidth: DEFAULT_SESSIONS_WIDTH,
  shuttingDown: false,
  // True after cleanup finished and the normal quit lifecycle was invoked —
  // the second window 'close' (app.quit() → close-all) must pass through.
  shutdownComplete: false,
  shutdownPromise: null as Promise<void> | null,
  lastFocused: null as Electron.WebContents | null,
  // P5: secrets + poller state. The PAT itself lives only inside SecretStore.
  secrets: null as SecretStore | null,
  apiSessions: [] as DevinSession[],
  notifications: {
    lastPollAt: null as string | null,
    authError: false,
    lastError: null as string | null,
    noUserIdentity: false,
    identity: { source: null as IdentitySource | null, resolved: false },
  },
  // P6: notification panel z-order raise flag (set via notifications:panel IPC).
  notificationsPanelOpen: false,
  // Same raise flag for the PR panel (set via prs:panel IPC).
  prsPanelOpen: false,
  // Autofill account picker anchored to a hosted view's field. While set the
  // shell is raised (same mechanism as the notifications panel).
  autofillPicker: null as {
    sender: Electron.WebContents;
    accounts: { id: string; username: string }[];
    anchor: { x: number; y: number; width: number; height: number };
  } | null,
  // Submitted-login capture: holds the plaintext password until the user
  // resolves the prompt. In-memory only — never serialized or logged.
  autofillPending: null as {
    sender: Electron.WebContents;
    origin: string;
    username: string | null;
    password: string;
    kind: 'save' | 'update';
    createdAt: number;
    timers: NodeJS.Timeout[];
    unlisten: () => void;
  } | null,
  autofillPrompt: null as {
    sender: Electron.WebContents;
    kind: 'save' | 'update';
    origin: string;
    username: string;
    anchor: { x: number; y: number; width: number; height: number };
    dismissTimer: NodeJS.Timeout;
  } | null,
};
