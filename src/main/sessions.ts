import { parseSessionId } from '../core/sessions';
import { cloudSessions } from './cloudSessions';
import { log } from './log';
import { notifier } from './notifier';
import { state } from './state';
import { applyLayout } from './window';

// Single seam for "the session displayed in the active Cloud view changed" —
// used by attachSessionTracking (in-app navigation) and the view pool (show /
// rekey). Idempotent: no work when the id is unchanged.
export function applySessionChange(sessionId: string | null, url: string): void {
  if (sessionId === state.currentSessionId) return;
  state.currentSessionId = sessionId;
  // The layout pass swaps the GitHub tab scope, sizes/attaches the active
  // tab view and notifies the shell — it reads tabManager.activeView/publicState.
  applyLayout();
  log('devin', 'session-change', { url, detail: { sessionId } });
  // Service-user identity inference observes the sessions the user opens.
  notifier.onSessionChanged(sessionId);
  void cloudSessions().refresh('session-change');
}

export function attachSessionTracking(contents: Electron.WebContents): void {
  const update = (url: string) => {
    // Only the ACTIVE pooled view owns currentSessionId — background pool
    // loads must not steal it (the pool's rekey handles those).
    if (contents !== state.devinView?.webContents) return;
    applySessionChange(parseSessionId(url, state.tenantUrl), url);
  };
  contents.on('did-navigate', (_event, url) => update(url));
  contents.on('did-navigate-in-page', (_event, url) => update(url));
}
