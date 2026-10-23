// OpenHands Cloud's hosted view pool: the provider config for the generic
// cloud-kit pool (src/main/cloudKit/viewPool.ts) plus the helpers the sidebar,
// Ctrl+N and the link router use. Views are keyed by the conversation they
// display ('home' for any other page on the origin) and live in the
// persist:openhands partition — never persist:cloud.
//
// The pool is registered at boot but creates no view (so makes no request)
// until the user enters the surface or opens a conversation — the opt-in gate
// in runtimeCore.ts covers the REST side the same way.

import { conversationUrl, isConversationId, openhandsOwnsUrl, openhandsViewKey } from '../../core/openhands';
import { HOME_KEY } from '../../core/viewPool';
import { createViewPool, type ViewPool, type ViewPoolConfig } from '../cloudKit/viewPool';
import { poolFor, registerPool } from '../cloudKit/pools';
import { log } from '../log';
import { openhandsBaseUrl } from '../openhandsConfig';
import { attachRouting } from '../routing';
import { state } from '../state';
import { applyLayout, focusContents, notifyShell } from '../window';

export const OPENHANDS_PROVIDER_ID = 'openhands';
export const OPENHANDS_PARTITION = 'persist:openhands';

// Built lazily: state.settings / the base URL are read inside the closures.
export function openhandsViewPoolConfig(): ViewPoolConfig {
  return {
    providerId: OPENHANDS_PROVIDER_ID,
    partition: OPENHANDS_PARTITION,
    homeUrl: () => openhandsBaseUrl(),
    keyForUrl: (url) => openhandsViewKey(url, openhandsBaseUrl()),
    ownsUrl: (url) => openhandsOwnsUrl(url, openhandsBaseUrl()),
    limits: () => {
      const { maxLiveViews, keepAliveHours } = state.settings!.current.openhands;
      return { maxLiveViews, keepAliveHours };
    },
    viewName: 'openhands',
    hooks: {
      attach: (contents) => attachRouting(contents, 'openhands', OPENHANDS_PROVIDER_ID),
      // The active view's conversation drives the GitHub tab scope
      // (`openhands:<id>`); home / other pages fall back to GLOBAL.
      onActiveSession: (sessionId) => {
        if (state.openhandsSessionId === sessionId) return;
        state.openhandsSessionId = sessionId;
        applyLayout();
      },
    },
  };
}

// Creates and registers the pool on first use (boot calls this eagerly so
// `pools()` already lists it when permissions/autofill/cookie audit look).
export function openhandsViews(): ViewPool {
  let pool = poolFor(OPENHANDS_PROVIDER_ID);
  if (!pool) {
    pool = createViewPool(openhandsViewPoolConfig());
    registerPool(pool);
  }
  return pool;
}

// 'New session' / the login row: the OpenHands home page (its composer lives
// there). `reload` restarts the page (Ctrl+N), otherwise a loaded home stays.
export function openhandsShowHome(opts: { reload?: boolean; focus?: boolean } = {}): void {
  state.surface = 'openhands';
  openhandsViews().show(HOME_KEY, openhandsBaseUrl(), opts.reload ? { reload: true } : {});
  applyLayout();
  if (opts.focus) focusContents(openhandsViews().activeView()?.webContents, 'new-session');
}

// Sidebar row click. The URL is rebuilt from the id (never taken from the
// renderer) and must round-trip through the id parser, so a tampered payload
// cannot steer the view anywhere but a conversation page on the base origin.
export function openhandsOpenSession(id: string): boolean {
  const base = openhandsBaseUrl();
  if (!isConversationId(base, id)) {
    log('shell', 'openhands-open', { detail: { found: false } });
    return false;
  }
  state.surface = 'openhands';
  openhandsViews().show(id, conversationUrl(base, id));
  state.openhandsSessionId = id;
  applyLayout();
  log('shell', 'openhands-open', { detail: { sessionId: id } });
  return true;
}

// A conversation was deleted on the server: drop its pooled view and any
// claim that it is the open conversation. When it was the active view the
// home page takes over first (no reload � it shows whatever it had).
export function openhandsForgetSession(id: string): void {
  const pool = poolFor(OPENHANDS_PROVIDER_ID);
  if (pool?.activeKey() === id) pool.show(HOME_KEY, openhandsBaseUrl());
  if (state.openhandsSessionId === id) state.openhandsSessionId = null;
  pool?.remove(id);
  applyLayout();
  notifyShell();
}

// Base URL changed: the pooled pages belong to the old origin. Nothing was
// opened yet (no views) -> nothing to reset, and no request is made. On the
// OpenHands surface home reloads on the new origin; elsewhere every view is
// dropped (no off-surface request) and re-entering the surface opens home.
export function resetOpenHandsViews(): void {
  const pool = poolFor(OPENHANDS_PROVIDER_ID);
  if (!pool || pool.views().length === 0) return;
  state.openhandsSessionId = null;
  if (state.surface === 'openhands') {
    pool.reset(openhandsBaseUrl());
  } else {
    pool.dispose();
    applyLayout();
  }
  // dispose() stopped the idle sweep; show() would not restart it.
  pool.applyLimits();
  log('shell', 'openhands-views-reset', { detail: {} });
}

export function openhandsViewsInfo() {
  return poolFor(OPENHANDS_PROVIDER_ID)?.debugInfo() ?? [];
}
