import { route } from '../../core/linkRouter';
import { log } from '../log';
import { routeContext } from '../routing';
import { state } from '../state';
import { applyLayout } from '../window';

// Local counterpart of the notifier's `pr-auto-open`: a GitHub PR URL that
// shows up in agent output opens a lazy background tab in the session's GitHub
// scope (`local:<sessionId>` or `claude:<sessionId>` — callers pass the scope).
export function autoOpenLocalPr(
  url: string,
  scope: string,
  source: 'local-chat' | 'local-terminal' | 'claude-chat' | 'claude-terminal' | 'claude-hook',
): boolean {
  if (!(state.settings?.current.prs.autoOpenTabs ?? true)) return false;
  if (route(url, 'local', 'new-window', routeContext()).kind !== 'gh-tab') return false;
  const tabManager = state.tabManager;
  if (!tabManager) return false;
  tabManager.open(url, {
    lazy: true,
    background: true,
    originSessionId: scope,
  });
  applyLayout();
  log('local', 'pr-auto-open', { url, detail: { scope, source } });
  return true;
}
