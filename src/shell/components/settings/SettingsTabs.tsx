import type { KeyboardEvent } from 'react';
import { SETTINGS_TAB_ORDER, type SettingsTabId } from '../../../core/settingsDraft';

const TAB_LABELS: Record<SettingsTabId, string> = {
  general: 'General',
  devin: 'Devin',
  claude: 'Claude Code',
  links: 'Link Handling',
  passwords: 'Passwords',
  notifications: 'Notifications',
  updates: 'Updates',
};

export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = SETTINGS_TAB_ORDER;

const TABS = SETTINGS_TAB_IDS.map((id) => ({ id, label: TAB_LABELS[id] }));

interface SettingsTabsProps {
  active: SettingsTabId;
  onSelect: (id: SettingsTabId) => void;
}

export function SettingsTabs({ active, onSelect }: SettingsTabsProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = SETTINGS_TAB_IDS.indexOf(active);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      SETTINGS_TAB_IDS[(index + delta + SETTINGS_TAB_IDS.length) % SETTINGS_TAB_IDS.length];
    if (next && next !== active) onSelect(next);
  };

  return (
    <div id="settingsTabs" role="tablist" className="mb-6 flex gap-6 border-b border-[#39475a]" onKeyDown={onKeyDown}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          id={`settingsTab-${tab.id}`}
          role="tab"
          data-settings-tab={tab.id}
          aria-selected={active === tab.id}
          type="button"
          className="-mb-px border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-[#7f8ca0] hover:text-[#e8edf5] aria-selected:border-[#83b6ff] aria-selected:text-[#e8edf5]"
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
