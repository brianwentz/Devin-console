import { useEffect, useState, type CSSProperties } from 'react';
import type { CredentialEntry } from '../../core/credentials';
import type { SettingsTabId } from '../../core/settingsDraft';
import type { Settings } from '../../shared/ipc';
import { ensureDraft, switchSettingsTab, useSettingsDraft } from '../settingsDraft';
import { ProviderSettingsTab } from '../providers';
import { useSettingsTab, useShellState } from '../store';
import { NotificationSettings } from './NotificationSettings';
import { PasswordsSection } from './PasswordsSection';
import { GeneralTab } from './settings/GeneralTab';
import { LinksTab } from './settings/LinksTab';
import { SettingsTabs } from './settings/SettingsTabs';
import { UpdatesTab } from './settings/UpdatesTab';

interface SettingsPanelProps {
  settings: Settings;
  credentials: CredentialEntry[];
  style: CSSProperties;
}

export function SettingsPanel({ settings, credentials, style }: SettingsPanelProps) {
  const tab = useSettingsTab();
  const draftState = useSettingsDraft();
  const shell = useShellState();
  const update = shell?.update ?? null;
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ensureDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (!draftState.savedAt) return;
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [draftState.savedAt]);

  const selectTab = (next: SettingsTabId) => {
    if (next === tab) return;
    void switchSettingsTab(next);
  };

  return (
    <main id="settingsPanel" className="shell-chrome p-9 bg-[#111925] overflow-auto" style={style}>
      <h1 className="text-2xl mb-6">Settings</h1>
      <SettingsTabs active={tab} onSelect={selectTab} />
      {draftState.message && (
        <p id="settingsError" className="mb-4 text-sm text-[#ff8a8a]">
          {draftState.message}
        </p>
      )}
      {saved && (
        <span id="settingsSaved" className="mb-4 text-sm text-[#8fd18f]">
          Saved
        </span>
      )}
      <section role="tabpanel" id={`settingsPanel-${tab}`}>
        {tab === 'general' && <GeneralTab />}
        <ProviderSettingsTab tab={tab} />
        {tab === 'links' && <LinksTab />}
        {tab === 'passwords' && (
          <PasswordsSection credentials={credentials} tenantUrl={settings.tenantUrl} />
        )}
        {tab === 'notifications' && <NotificationSettings />}
        {tab === 'updates' && <UpdatesTab update={update} />}
      </section>
    </main>
  );
}
