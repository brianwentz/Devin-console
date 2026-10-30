import type { AppNotification } from '../../core/notificationModel';
import { findReviewTabId, parseReviewScope } from '../../core/reviewScope';
import { sessionUrl } from '../../core/sessions';
import { claudeSessions } from '../claude/sessions';
import { log } from '../log';
import { openhandsOpenSession } from '../openhands/views';
import { loadInDevinView } from '../routing';
import { state } from '../state';
import { activateWindow, applyLayout, setPaneOpen } from '../window';

// Opening a review notification returns to the session scope the reviewed tab
// belongs to (not the review session itself), then focuses or opens the PR tab
// — with the pane shown, or the activated tab would stay invisible.
export function openReviewNotification(entry: AppNotification): void {
  const scope = entry.scope ?? '';
  const target = parseReviewScope(scope);
  log('shell', 'review-open', { detail: { scope: target.kind } });
  switch (target.kind) {
    case 'cloud':
      if (target.id !== state.currentSessionId) {
        loadInDevinView(sessionUrl(state.tenantUrl, target.id));
      }
      state.surface = 'cloud';
      break;
    case 'local':
      state.surface = 'local';
      state.localSessionId = target.id;
      break;
    case 'claude':
      state.surface = 'claude';
      claudeSessions().open(target.id);
      break;
    case 'openhands':
      openhandsOpenSession(target.id);
      break;
    case 'global':
      break;
  }
  applyLayout();
  setPaneOpen(true, 'review-notification');
  const manager = state.tabManager;
  if (manager && entry.prUrl) {
    const tabId = findReviewTabId(manager.currentState.tabs, scope, entry.prUrl);
    if (tabId && manager.currentScope === scope) manager.activate(tabId);
    else manager.open(entry.prUrl, { originSessionId: scope });
  }
  activateWindow('review-notification');
}
