import { shell } from 'electron';
import {
  route,
  routeUrl,
  type RouteContext,
  type RouteDecision,
  type RouteDisposition,
  type RouteSource,
  DEVIN_PROVIDER_ID,
} from '../core/linkRouter';
import { compileLinkRules, matchLinkRule, type CompiledRule } from '../core/linkRules';
import type { LinkRule } from '../shared/ipc';
import { log } from './log';
import { allowExternalEnabled } from './settings';
import { fixtureOrigins, state, testMode, type ViewName } from './state';
import { openhandsBaseUrl } from './openhandsConfig';
import { GLOBAL } from '../core/tabModel';
import { keyForUrl } from '../core/viewPool';
import { openHandsAuthOrigins, parseExtraAuthOrigins } from '../core/openhands';
import { surfaceForProvider } from '../core/providers';
import { poolFor } from './cloudKit/pools';
import { cloudViews } from './cloudViews';
import { applyLayout, notifyShell, setPaneOpen } from './window';
import { handleShortcut } from './shortcuts';

// Compiled rules are memoized on array identity — SettingsStore replaces the
// routing object on every commit, so identity changes exactly when rules do.
let lastRules: readonly LinkRule[] | null = null;
let lastCompiled: readonly CompiledRule[] = [];

// OpenHands' own view may follow its login hops (see core/openhands.ts
// OPENHANDS_IDP_AUTH_ORIGINS) in place. The fixture's auth origin is added in
// test mode only.
function openhandsRouteProvider(): NonNullable<RouteContext['providers']>[number] {
  const base = openhandsBaseUrl();
  const extra = testMode
    ? parseExtraAuthOrigins(process.env.AGENT_WORKSPACE_TEST_OPENHANDS_AUTH_ORIGIN)
    : [];
  return { providerId: 'openhands', origin: base, authOrigins: openHandsAuthOrigins(base, extra) };
}

export function routeContext(): RouteContext {
  const rules = state.settings?.current.routing.rules ?? [];
  if (rules !== lastRules) {
    lastRules = rules;
    lastCompiled = compileLinkRules(rules);
  }
  return {
    tenantUrl: state.tenantUrl,
    providers: [
      { providerId: DEVIN_PROVIDER_ID, origin: state.tenantUrl },
      openhandsRouteProvider(),
    ],
    githubOrigins: fixtureOrigins,
    rules: lastCompiled,
  };
}

export function sourceOf(view: ViewName, providerId?: string): RouteSource {
  if (providerId && providerId !== DEVIN_PROVIDER_ID) return 'provider';
  if (view === 'devin') return 'devin';
  if (view === 'analytics') return 'analytics';
  if (view === 'shell') return 'shell';
  return 'github';
}

export function recordDecision(
  view: ViewName,
  event: string,
  url: string,
  decision: string,
  detail?: Record<string, unknown>,
): void {
  log(view, event, detail ? { url, decision, detail } : { url, decision });
}

export function openExternal(
  url: string,
  view: ViewName,
  event = 'external-open',
  decision = 'external',
): void {
  recordDecision(view, event, url, decision);
  if (!allowExternalEnabled()) return;
  void shell.openExternal(url).catch((error: unknown) => {
    log(view, 'external-error', { url, detail: { message: String(error) } });
  });
}

function openGitHubTab(url: string, background: boolean): string | undefined {
  setPaneOpen(true, 'github-tab');
  // P8: scope = the currently visible scope (the session open in Cloud). Local
  // chat links therefore land on the session the user was looking at.
  const scope = state.tabManager?.currentScope ?? state.currentSessionId ?? GLOBAL;
  const id = state.tabManager?.open(url, {
    background,
    ...(scope ? { originSessionId: scope } : {}),
  });
  applyLayout();
  return id;
}

// Navigate the Cloud view (also used by the scope menu — F7).
export function loadInDevinView(url: string): void {
  if (!state.cloudViewsRef) return;
  state.surface = 'cloud';
  cloudViews().show(keyForUrl(url, state.tenantUrl), url);
}

// Apply a LinkRouter decision. Returns the decision so callers can preventDefault etc.
// Decision labels in the log: github-tab | github-tab-background | rule-tab |
// rule-tab-background | allow-in-view | devin | external | mailto | deny (the
// e2e matrix asserts on these).
export function applyDecision(
  rawUrl: string,
  view: ViewName,
  event: string,
  disposition: RouteDisposition,
  sourceProviderId?: string,
): RouteDecision {
  const context = routeContext();
  let result: RouteDecision | undefined;
  const decision = route(
    rawUrl,
    sourceOf(view, sourceProviderId),
    disposition,
    context,
    sourceProviderId,
  );
  switch (decision.kind) {
    case 'gh-tab': {
      openGitHubTab(rawUrl, decision.background);
      // A gh-tab decision reached via a user link rule logs distinctly and
      // carries the matched rule id/kind — never the pattern text.
      const matched =
        routeUrl(rawUrl, context) === 'rule'
          ? matchLinkRule(rawUrl, context.rules ?? [])
          : null;
      recordDecision(
        view,
        event,
        rawUrl,
        matched
          ? decision.background
            ? 'rule-tab-background'
            : 'rule-tab'
          : decision.background
            ? 'github-tab-background'
            : 'github-tab',
        matched ? { ruleId: matched.id, ruleKind: matched.kind } : undefined,
      );
      break;
    }
    case 'in-place':
      recordDecision(view, event, rawUrl, 'allow-in-view');
      break;
    case 'devin':
      loadInDevinView(rawUrl);
      recordDecision(view, event, rawUrl, 'devin');
      applyLayout();
      break;
    case 'provider': {
      const pool = poolFor(decision.providerId);
      const surface = surfaceForProvider(decision.providerId);
      if (pool && surface) {
        state.surface = surface;
        pool.show(pool.keyForUrl(rawUrl), rawUrl);
        recordDecision(view, event, rawUrl, 'provider', { providerId: decision.providerId });
        applyLayout();
      } else {
        // No pool/surface for the id: nothing was applied, so report a deny.
        recordDecision(view, event, rawUrl, 'deny');
        result = { kind: 'deny' };
      }
      break;
    }
    case 'external':
      openExternal(rawUrl, view, event, routeUrl(rawUrl, routeContext()) === 'mailto' ? 'mailto' : 'external');
      break;
    case 'deny':
      recordDecision(view, event, rawUrl, 'deny');
      break;
  }
  return result ?? decision;
}

function popupDisposition(details: Electron.HandlerDetails): RouteDisposition {
  // Ctrl/middle-click report 'background-tab'; everything else is a foreground popup.
  return details.disposition === 'background-tab' ? 'background' : 'new-window';
}

// `providerId`: the hosted provider whose pool owns this view (absent for the
// Devin Cloud view, shell and GitHub tabs) — it makes the view's navigations
// 'provider'-sourced so the provider's auth origins apply.
export function attachRouting(
  webContents: Electron.WebContents,
  view: ViewName,
  providerId?: string,
): void {
  webContents.setWindowOpenHandler((details) => {
    applyDecision(details.url, view, 'window-open', popupDisposition(details), providerId);
    // Never create a BrowserWindow: every popup is routed by the LinkRouter.
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    const decision = route(url, sourceOf(view, providerId), 'navigate', routeContext(), providerId);
    if (decision.kind === 'in-place') {
      recordDecision(view, 'will-navigate', url, 'allow-in-view');
      return;
    }
    event.preventDefault();
    applyDecision(url, view, 'will-navigate', 'navigate', providerId);
  });

  webContents.on('will-frame-navigate', (event) => {
    const url = event.url;
    if (event.isMainFrame) return;
    // Sub-frames navigate in place (iframe content is part of the hosting page); only
    // non-web schemes are denied. `_top` links from iframes surface as main-frame
    // will-navigate and are routed there.
    const kind = routeUrl(url, routeContext());
    if (kind === 'deny') {
      event.preventDefault();
      recordDecision(view, 'will-frame-navigate', url, 'deny-subframe');
    } else {
      recordDecision(view, 'will-frame-navigate', url, 'allow-subframe');
    }
  });

  webContents.on('will-redirect', (_event, url, isInPlace, isMainFrame) => {
    log(view, 'will-redirect', {
      url,
      decision: 'allow',
      detail: { isInPlace, isMainFrame },
    });
  });

  webContents.on('did-navigate', (_event, url) => {
    log(view, 'did-navigate', { url, decision: 'allow' });
  });
  webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log(view, 'did-fail-load', {
        url: validatedURL,
        decision: 'failure',
        detail: { errorCode, errorDescription, isMainFrame },
      });
    },
  );
  webContents.on('focus', () => {
    if (view !== 'shell') state.lastFocused = webContents;
    notifyShell();
  });
  webContents.on('before-input-event', (event, input) =>
    handleShortcut(webContents, view, event, input),
  );
}

// Links clicked in shell-owned UI (Local chat, settings) and the `__agentworkspace.routeLink`
// test hook: treated as new-window requests from the shell.
export function handleLink(url: string, source: ViewName = 'shell'): void {
  applyDecision(url, source, 'link-open', 'new-window');
  applyLayout();
}
