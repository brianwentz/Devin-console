import { useSyncExternalStore } from 'react';
import {
  draftFromSettings,
  firstErrorField,
  isDraftDirty,
  validateDraft,
  DRAFT_TAB,
  type DraftErrors,
  type DraftField,
  type SettingsDraft,
  type SettingsTabId,
} from '../core/settingsDraft';
import type { Settings } from '../shared/ipc';
import { getShellState, setSettingsTab } from './store';

export type CommitReason = 'tab' | 'surface' | 'quit';

interface DraftState {
  draft: SettingsDraft | null;
  errors: DraftErrors;
  message: string | null;
  saving: boolean;
  savedAt: number | null;
}

let current: DraftState = {
  draft: null,
  errors: {},
  message: null,
  saving: false,
  savedAt: null,
};
// Latest settings snapshot seen by ensureDraft — used by the quit flush, which
// runs without a mounted SettingsPanel.
let lastSettings: Settings | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function set(partial: Partial<DraftState>): void {
  current = { ...current, ...partial };
  notify();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useSettingsDraft(): DraftState {
  return useSyncExternalStore(subscribe, () => current);
}

export function ensureDraft(settings: Settings): void {
  lastSettings = settings;
  if (!current.draft) {
    set({ draft: draftFromSettings(settings), errors: {}, message: null });
    return;
  }
  if (!isDraftDirty(current.draft, settings)) {
    set({ draft: draftFromSettings(settings) });
  }
}

export function updateDraft(partial: Partial<SettingsDraft>): void {
  if (!current.draft) return;
  const errors = { ...current.errors };
  for (const field of Object.keys(partial) as DraftField[]) {
    delete errors[field];
  }
  set({ draft: { ...current.draft, ...partial }, errors, message: null });
}

export function lastDraftSettings(): Settings | null {
  return lastSettings;
}

const FIELD_INPUT: Record<DraftField, string> = {
  tenantUrl: 'tenantUrlInput',
  apiBase: 'apiBaseInput',
  allowExternal: 'allowExternalInput',
  keepAliveHours: 'keepAliveInput',
  maxLiveTabs: 'maxLiveTabsInput',
  usageDevinPollMinutes: 'usageDevinPollMinutes',
  sessionsOpen: 'sessionsColumnToggle',
  sessionsMaxLiveViews: 'sessionsMaxLiveViews',
  sessionsKeepAliveHours: 'sessionsKeepAliveHours',
  terminalShell: 'terminalShellInput',
  devinPath: 'devinPathInput',
  localDefaultWslDistro: 'localDefaultWslDistroSelect',
  localDefaultMode: 'localDefaultModeSelect',
  localPickerFolder: 'localPickerFolderInput',
  claudePath: 'claudePathInput',
  claudeAutoArchiveDays: 'claudeAutoArchiveInput',
  claudePermissionMode: 'claudePermissionModeDefault',
  claudeModel: 'claudeModelInput',
  claudeKeepAliveMinutes: 'claudeKeepAliveInput',
  claudeMaxLiveAgents: 'claudeMaxLiveAgentsInput',
  claudeDefaultWslDistro: 'claudeDefaultWslDistroSelect',
  claudePickerFolder: 'claudePickerFolderInput',
  reviewHost: 'reviewHostSelect',
  reviewAgent: 'reviewAgentSelect',
  reviewCommand: 'reviewCommandInput',
  reviewClaudeMode: 'reviewModeSelect',
  reviewDevinMode: 'reviewModeSelect',
  reviewCwd: 'reviewCwdInput',
  openhandsBaseUrl: 'openhandsBaseUrlInput',
  openhandsPollSeconds: 'openhandsPollSecondsInput',
  openhandsMaxLiveViews: 'openhandsMaxLiveViewsInput',
  openhandsKeepAliveHours: 'openhandsKeepAliveInput',
  userId: 'userIdInput',
  orgId: 'orgIdInput',
  linkRules: 'linkRuleAdd',
  favoritesChromeProfile: 'favoritesProfileSelect',
};

function focusErrorField(errors: DraftErrors): void {
  const field = firstErrorField(errors);
  if (!field) return;
  setSettingsTab(DRAFT_TAB[field]);
  requestAnimationFrame(() => {
    document.getElementById(FIELD_INPUT[field])?.focus();
  });
}

export async function commitDraft(reason: CommitReason, settings: Settings): Promise<boolean> {
  if (!current.draft || !isDraftDirty(current.draft, settings)) return true;
  const validated = validateDraft(current.draft);
  if (!validated.ok) {
    set({
      errors: validated.errors,
      message: "Changes weren't saved — fix the highlighted field",
    });
    focusErrorField(validated.errors);
    return false;
  }
  set({ saving: true });
  try {
    const reply = await window.agentworkspace.commitSettings(validated.patch);
    if (reply.ok) {
      lastSettings = reply.settings;
      set({
        draft: draftFromSettings(reply.settings),
        errors: {},
        message: null,
        saving: false,
        savedAt: Date.now(),
      });
      return true;
    }
    const errors = reply.errors as DraftErrors;
    set({
      errors,
      message: reply.message ?? "Changes weren't saved",
      saving: false,
    });
    focusErrorField(errors);
    return false;
  } catch {
    set({ saving: false, message: "Changes weren't saved" });
    return false;
  }
}

// Tab click (and the auth/identity notification deep link): commit any dirty
// draft first; a validation failure leaves the user on the erroring field.
export async function switchSettingsTab(next: SettingsTabId): Promise<boolean> {
  const settings = lastDraftSettings() ?? getShellState()?.settings;
  if (!settings) {
    setSettingsTab(next);
    return true;
  }
  const ok = await commitDraft('tab', settings);
  if (ok) setSettingsTab(next);
  return ok;
}

// Quit path: a validation failure must not veto shutdown — always reply.
export function handleSettingsFlush(): void {
  const settings = lastSettings;
  const pending = Boolean(
    current.draft && settings && isDraftDirty(current.draft, settings),
  );
  void (async () => {
    const ok = settings ? await commitDraft('quit', settings) : true;
    window.agentworkspace.settingsFlushDone({ pending, ok });
  })();
}
