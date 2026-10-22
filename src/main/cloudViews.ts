// Devin Cloud's view pool: the provider config for the generic cloud-kit pool
// (src/main/cloudKit/viewPool.ts) plus the cloudViews() accessor every caller
// uses. Views are keyed by the session they display ('home' for the tenant
// root) and live in the persist:cloud partition.

import { devinOwnsUrl, devinViewKey } from '../core/cloudKit/devinViews';
import { cloudSessions } from './cloudSessions';
import { createViewPool, type ViewPool, type ViewPoolConfig } from './cloudKit/viewPool';
import { poolFor, registerPool } from './cloudKit/pools';
import { attachRouting } from './routing';
import { applySessionChange, attachSessionTracking } from './sessions';
import { state } from './state';

export { cloudKeepAliveMs, DEFAULT_MAX_LIVE_VIEWS } from './cloudKit/viewPool';
export type CloudViewPool = ViewPool;

export const DEVIN_CLOUD_PROVIDER_ID = 'devin-cloud';

// Built lazily: state.settings is read inside limits(), never at import.
export function devinViewPoolConfig(): ViewPoolConfig {
  return {
    providerId: DEVIN_CLOUD_PROVIDER_ID,
    partition: 'persist:cloud',
    homeUrl: () => state.tenantUrl,
    keyForUrl: (url) => devinViewKey(url, state.tenantUrl),
    ownsUrl: (url) => devinOwnsUrl(url, state.tenantUrl),
    limits: () => {
      const { maxLiveViews, keepAliveHours } = state.settings!.current.sessions;
      return { maxLiveViews, keepAliveHours };
    },
    viewName: 'devin',
    hooks: {
      attach(contents) {
        attachRouting(contents, 'devin');
        attachSessionTracking(contents);
      },
      onActiveSession: applySessionChange,
      onHomeToSession: (sessionId) => cloudSessions().noteHomeNavigation(sessionId),
    },
  };
}

export function cloudViews(): CloudViewPool {
  let pool = poolFor(DEVIN_CLOUD_PROVIDER_ID);
  if (!pool) {
    pool = createViewPool(devinViewPoolConfig());
    registerPool(pool);
    state.cloudViewsRef = pool;
  }
  return pool;
}
