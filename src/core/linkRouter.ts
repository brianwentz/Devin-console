// Pure link router (plan §4.1). No electron imports.

import { matchLinkRule, type CompiledRule } from './linkRules';
import { isAnalyticsUrl } from './sessions';

export type RouteKind = 'devin' | 'github' | 'provider' | 'rule' | 'external' | 'mailto' | 'deny';

export type RouteSource =
  | 'devin'
  | 'github'
  | 'local'
  | 'claude'
  | 'shell'
  | 'analytics'
  | 'provider';
export type RouteDisposition = 'new-window' | 'navigate' | 'background';

export type RouteDecision =
  | { kind: 'gh-tab'; background: boolean }
  | { kind: 'in-place' }
  | { kind: 'devin' }
  | { kind: 'provider'; providerId: string }
  | { kind: 'external' }
  | { kind: 'deny' };

// The Devin Cloud provider id; its decisions stay `{ kind: 'devin' }`.
export const DEVIN_PROVIDER_ID = 'devin-cloud';

export interface RouteProvider {
  providerId: string;
  origin: string;
  // Login-hop prefixes (origin, optionally + path) a same-tab navigation from
  // this provider's own view may follow in place instead of being split off
  // into a GitHub tab (e.g. an OAuth hop through github.com/login).
  authOrigins?: readonly string[];
}

export interface RouteContext {
  tenantUrl: string;
  // Hosted providers in registry order. Absent/empty = Devin via `tenantUrl` only.
  providers?: readonly RouteProvider[];
  githubOrigins?: readonly string[];
  rules?: readonly CompiledRule[];
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

export function isGitHubHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return hostMatches(host, 'github.com') || hostMatches(host, 'githubusercontent.com');
}

// True when `rawUrl` is on the same origin (scheme + host + port) as one of
// `authOrigins` and its path equals / lies under that entry's path (segment
// boundary: '/login' matches '/login' and '/login/x', never '/loginx'). Never
// host-wide: an entry with a path only covers that path.
export function matchesAuthOrigin(rawUrl: string, authOrigins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  for (const entry of authOrigins) {
    let auth: URL;
    try {
      auth = new URL(entry);
    } catch {
      continue;
    }
    if (url.origin.toLowerCase() !== auth.origin.toLowerCase()) continue;
    const prefix = auth.pathname.replace(/\/+$/, '');
    if (prefix === '' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function sameHostAndPort(a: URL, b: URL): boolean {
  return normalizeHost(a.hostname) === normalizeHost(b.hostname) && a.port === b.port;
}

// The non-Devin provider owning `rawUrl` (same hostname + port semantics as the
// tenant check), in registry order.
export function providerForUrl(rawUrl: string, context: RouteContext): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const p of context.providers ?? []) {
    if (p.providerId === DEVIN_PROVIDER_ID) continue;
    try {
      if (sameHostAndPort(new URL(p.origin), url)) return p.providerId;
    } catch {
      // Malformed provider origin never matches.
    }
  }
  return null;
}

// Host classification only: which surface "owns" the URL. Used by `route()` and
// kept as the legacy entry point for callers that only need the host class.
export function routeUrl(rawUrl: string, context: RouteContext): RouteKind {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return 'deny';
  }

  if (url.protocol === 'mailto:') return 'mailto';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'deny';

  const origin = url.origin.toLowerCase();

  if (
    isGitHubHost(url.hostname) ||
    context.githubOrigins?.some((allowed) => allowed.toLowerCase() === origin)
  ) {
    return 'github';
  }

  try {
    const tenant = new URL(context.tenantUrl);
    if (sameHostAndPort(tenant, url)) return 'devin';
  } catch {
    return 'deny';
  }

  if (providerForUrl(rawUrl, context)) return 'provider';

  if (matchLinkRule(url.href, context.rules ?? [])) return 'rule';

  return 'external';
}

// Full routing decision (plan §4.1):
// - new-window / background (popups, _blank, ctrl/middle-click) from any source:
//   GitHub host or a matched link rule -> gh-tab (background iff disposition is
//   'background'); tenant -> devin; other http(s) and mailto -> external;
//   other schemes -> deny.
// - navigate (top-frame, link-initiated) from 'devin' to a GitHub host or a
//   matched link rule -> gh-tab.
// - navigate inside a hosted view ('devin' or 'github') to anything else -> in-place, so
//   server redirects, form posts and IdP/SSO hops are never split across views.
// - navigate from 'shell' / 'local' behaves like new-window (those surfaces never navigate).
// Host classes rank github > tenant > rule > external: a rule can never steal a
// GitHub or tenant URL.
export function route(
  rawUrl: string,
  source: RouteSource,
  disposition: RouteDisposition,
  context: RouteContext,
  sourceProviderId?: string,
): RouteDecision {
  const kind = routeUrl(rawUrl, context);
  if (kind === 'deny') return { kind: 'deny' };
  if (kind === 'mailto') return { kind: 'external' };

  const providerId = kind === 'provider' ? providerForUrl(rawUrl, context) : null;

  const hosted =
    source === 'devin' || source === 'github' || source === 'analytics' || source === 'provider';
  if (disposition === 'navigate' && hosted) {
    // A provider view's own login hops (IdP / SSO pages) stay in the view.
    if (source === 'provider' && sourceProviderId) {
      const own = context.providers?.find((p) => p.providerId === sourceProviderId);
      if (own?.authOrigins && matchesAuthOrigin(rawUrl, own.authOrigins)) {
        return { kind: 'in-place' };
      }
    }
    if (
      (kind === 'github' || kind === 'rule') &&
      (source === 'devin' || source === 'analytics' || source === 'provider')
    ) {
      return { kind: 'gh-tab', background: false };
    }
    // A provider view navigating onto another provider's origin hands off.
    if (providerId && source === 'provider' && providerId !== sourceProviderId) {
      return { kind: 'provider', providerId };
    }
    // Analytics is a hosted surface: same-tab clicks into the rest of the
    // tenant (e.g. a session from a chart) open in the Cloud view instead.
    if (
      kind === 'devin' &&
      source === 'analytics' &&
      !isAnalyticsUrl(rawUrl, context.tenantUrl)
    )
      return { kind: 'devin' };
    return { kind: 'in-place' };
  }

  if (kind === 'github' || kind === 'rule') {
    return { kind: 'gh-tab', background: disposition === 'background' };
  }
  if (kind === 'devin') return { kind: 'devin' };
  if (providerId) return { kind: 'provider', providerId };
  return { kind: 'external' };
}
