import { settingsTabForNotification } from '../core/settingsDraft';
import type { AppNotification } from '../core/notificationModel';
import { switchSettingsTab } from './settingsDraft';

// Notifications that point at a Settings tab commit the current draft and
// switch tab first; main then only has to raise the Settings surface.
export function openNotificationEntry(entry: Pick<AppNotification, 'id' | 'kind'>): void {
  const tab = settingsTabForNotification(entry.kind);
  if (tab) void switchSettingsTab(tab);
  window.agentworkspace.notificationsOpen(entry.id);
}
