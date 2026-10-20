import { WebContentsView } from 'electron';
import { analyticsUrl, isAnalyticsUrl } from '../core/sessions';
import { log } from './log';
import { attachRouting } from './routing';
import { devinUsage } from './devinUsage';
import { state } from './state';

// The Analytics surface is a hosted view on the tenant partition, created on
// first use (it stays alive after leaving the surface — no teardown on switch).
// No preload: it shares `persist:devin` but never talks autofill IPC.
export function ensureAnalyticsView(): WebContentsView {
  if (state.analyticsView) return state.analyticsView;
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:devin',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  state.analyticsView = view;
  view.setBackgroundColor('#111827');
  attachRouting(view.webContents, 'analytics');
  const url = analyticsUrl(state.tenantUrl);
  view.webContents.loadURL(url).catch((error: unknown) => {
    log('analytics', 'load-error', { url, detail: { message: String(error) } });
  });
  log('analytics', 'analytics-view-created', { url });
  return view;
}

// Re-entering the surface reloads in place so the charts are never stale.
// First entry is covered by the creation load — no double load. Only the Devin
// tab shows the hosted page: on the Claude tab (shell DOM) nothing is created
// or reloaded — applyBounds creates the view lazily when the Devin tab is shown.
export function refreshAnalyticsView(): void {
  void devinUsage().refresh();
  const tab = state.settings?.current.analytics.tab ?? 'devin';
  if (tab !== 'devin') {
    log('analytics', 'analytics-refresh-skipped', { detail: { tab } });
    return;
  }
  if (!state.analyticsView) {
    ensureAnalyticsView();
    return;
  }
  const contents = state.analyticsView.webContents;
  const current = contents.getURL();
  if (isAnalyticsUrl(current, state.tenantUrl)) {
    contents.reload();
    log('analytics', 'analytics-refresh', { url: current, detail: { mode: 'reload' } });
  } else {
    const url = analyticsUrl(state.tenantUrl);
    contents.loadURL(url).catch((error: unknown) => {
      log('analytics', 'load-error', { url, detail: { message: String(error) } });
    });
    log('analytics', 'analytics-refresh', { url, detail: { mode: 'navigate' } });
  }
}
