import { providerById } from '../../core/providers';
import { openPullRequests } from '../../core/notifyModel';
import { devinUsage } from '../devinUsage';
import { notifier, openDevinNotification, openSessionPr } from '../notifier';
import { state } from '../state';
import { openNewSession } from '../shortcuts';
import type { ProviderRuntime } from './runtime';

// Top level only builds the object — singletons are resolved inside methods
// (this module sits in import cycles with notifier/window/shortcuts).
export const devinCloudRuntime: ProviderRuntime = {
  descriptor: providerById('devin-cloud'),
  start() {
    devinUsage().start();
  },
  // The notifier/cloudSessions stops run earlier in shutdown and
  // devinUsage().dispose() stays named there to keep today's order.
  async dispose() {},
  onFocus() {
    notifier.onWindowFocus();
  },
  onSettingsChanged(previous, next) {
    notifier.onSettingsChanged(previous, next);
  },
  openPullRequests() {
    return openPullRequests(state.apiSessions);
  },
  prsKnown() {
    return notifier.prsKnown();
  },
  openNotification(entry) {
    openDevinNotification(entry);
    return true;
  },
  openSessionPr(sessionId, prUrl) {
    openSessionPr(sessionId, prUrl);
  },
  newSession() {
    openNewSession();
    return Promise.resolve();
  },
};
