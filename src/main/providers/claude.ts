import { providerById } from '../../core/providers';
import { claudeHost } from '../claude/host';
import { claudeSessions } from '../claude/sessions';
import { claudeUsage } from '../claude/usage';
import { log } from '../log';
import { openClaudeSessionPr } from '../notifier';
import type { ProviderRuntime } from './runtime';

export const claudeRuntime: ProviderRuntime = {
  descriptor: providerById('claude'),
  start() {
    claudeUsage().start();
  },
  async dispose() {
    // Claude teardown must never block or abort the quit sequence — a slow
    // consumer close or a failure here would skip the settings snapshot below.
    try {
      await Promise.race([
        claudeHost()?.dispose(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch (error) {
      log('shell', 'claude-dispose-error', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  },
  onFocus() {
    claudeSessions().onWindowFocus();
  },
  onSettingsChanged(previous, next) {
    claudeSessions().onSettingsChanged(previous, next);
  },
  onPrPanelOpen() {
    claudeSessions().refreshPrStates('panel');
  },
  openPullRequests() {
    return claudeSessions().claudeOpenPullRequests();
  },
  openNotification(entry) {
    if (!entry.sessionId) return false;
    openClaudeSessionPr(entry.sessionId, entry.prUrl);
    return true;
  },
  openSessionPr(sessionId, prUrl) {
    openClaudeSessionPr(sessionId, prUrl);
  },
  async newSession() {
    // A new Claude chat session (cwd picker / test env var).
    await claudeSessions().newSession(null);
  },
};
