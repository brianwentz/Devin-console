import { describe, expect, it } from 'vitest';
import {
  route,
  routeUrl,
  type RouteDecision,
  type RouteDisposition,
  type RouteSource,
} from '../../src/core/linkRouter';
import { compileLinkRules } from '../../src/core/linkRules';
import type { LinkRule } from '../../src/shared/ipc';

const context = {
  tenantUrl: 'https://cloudbeds.devinenterprise.com',
  githubOrigins: ['http://127.0.0.1:43111', 'http://localhost:43112'],
};

describe('routeUrl (host class)', () => {
  it.each([
    'https://github.com/org/repo',
    'http://github.com/org/repo',
    'https://www.github.com/org/repo',
    'https://gist.github.com/user/id',
    'https://GitHub.com/Org/Repo',
    'https://github.com./org/repo',
    'https://githubusercontent.com/file',
    'https://raw.githubusercontent.com/org/repo/main/file',
    'http://raw.githubusercontent.com/org/repo/main/file',
    'https://objects.githubusercontent.com/item',
    'https://user-images.githubusercontent.com/1/x.png',
    'http://127.0.0.1:43111/page',
    'http://localhost:43112/page',
  ])('routes %s to GitHub', (url) => {
    expect(routeUrl(url, context)).toBe('github');
  });

  it.each([
    'https://evil-github.com/org/repo',
    'https://github.com.evil.com/org/repo',
    'https://githubusercontent.com.evil.com/file',
    'https://cloudbeds.devinenterprise.com.evil.com/session',
    'http://127.0.0.1:43113/page',
  ])('does not confuse %s with an allowed host', (url) => {
    expect(routeUrl(url, context)).toBe('external');
  });

  it('routes the configured tenant and other web origins', () => {
    expect(routeUrl('https://cloudbeds.devinenterprise.com/sessions/1', context)).toBe('devin');
    expect(routeUrl('https://CLOUDBEDS.devinenterprise.com./sessions/1', context)).toBe('devin');
    expect(routeUrl('https://example.org/path', context)).toBe('external');
  });

  it('routes mailto separately and denies non-web schemes and invalid URLs', () => {
    expect(routeUrl('mailto:support@example.org', context)).toBe('mailto');
    expect(routeUrl('javascript:alert(1)', context)).toBe('deny');
    expect(routeUrl('data:text/html,hello', context)).toBe('deny');
    expect(routeUrl('file:///etc/passwd', context)).toBe('deny');
    expect(routeUrl('not a url', context)).toBe('deny');
    expect(routeUrl('https://example.org/', { tenantUrl: 'not a url' })).toBe('deny');
  });
});

type HostClass = 'github' | 'tenant' | 'external' | 'mailto' | 'javascript' | 'data';

const hostSamples: Record<HostClass, string[]> = {
  github: [
    'https://github.com/org/repo/pull/1',
    'https://gist.github.com/user/id',
    'https://raw.githubusercontent.com/org/repo/main/file',
    'https://objects.githubusercontent.com/item',
    'https://GITHUB.COM/org/repo',
    'https://github.com./org/repo',
    'http://127.0.0.1:43111/page',
  ],
  tenant: ['https://cloudbeds.devinenterprise.com/sessions/abc'],
  external: ['https://example.org/path', 'https://okta.example.com/sso'],
  mailto: ['mailto:desk@example.org'],
  javascript: ['javascript:alert(1)'],
  data: ['data:text/html,denied'],
};

const sources: RouteSource[] = ['devin', 'github', 'local', 'claude', 'shell'];
const dispositions: RouteDisposition[] = ['new-window', 'navigate', 'background'];

function expected(
  hostClass: HostClass,
  source: RouteSource,
  disposition: RouteDisposition,
): RouteDecision {
  if (hostClass === 'javascript' || hostClass === 'data') return { kind: 'deny' };
  if (hostClass === 'mailto') return { kind: 'external' };
  const hosted = source === 'devin' || source === 'github';
  if (disposition === 'navigate' && hosted) {
    if (hostClass === 'github' && source === 'devin') return { kind: 'gh-tab', background: false };
    return { kind: 'in-place' };
  }
  if (hostClass === 'github') return { kind: 'gh-tab', background: disposition === 'background' };
  if (hostClass === 'tenant') return { kind: 'devin' };
  return { kind: 'external' };
}

describe('route (host class x source x disposition)', () => {
  const rows: Array<[HostClass, string, RouteSource, RouteDisposition]> = [];
  for (const [hostClass, urls] of Object.entries(hostSamples) as Array<[HostClass, string[]]>) {
    for (const url of urls) {
      for (const source of sources) {
        for (const disposition of dispositions) rows.push([hostClass, url, source, disposition]);
      }
    }
  }

  it.each(rows)('%s %s from %s via %s', (hostClass, url, source, disposition) => {
    expect(route(url, source, disposition, context)).toEqual(
      expected(hostClass, source, disposition),
    );
  });

  it('spells out the key rules', () => {
    // Every new-window GitHub link opens a tab, from any source.
    expect(route('https://github.com/o/r', 'devin', 'new-window', context)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
    expect(route('https://github.com/o/r', 'github', 'new-window', context)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
    // Ctrl/middle-click keeps the current tab focused.
    expect(route('https://github.com/o/r', 'github', 'background', context)).toEqual({
      kind: 'gh-tab',
      background: true,
    });
    // Link-initiated top-frame navigation from devinView to GitHub is intercepted.
    expect(route('https://github.com/o/r', 'devin', 'navigate', context)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
    // Inside a gh tab, every navigation stays put (SAML/SSO chains are never split).
    expect(route('https://github.com/o/r', 'github', 'navigate', context)).toEqual({
      kind: 'in-place',
    });
    expect(route('https://okta.example.com/saml', 'github', 'navigate', context)).toEqual({
      kind: 'in-place',
    });
    // Devin SSO hop (tenant -> IdP) stays in devinView.
    expect(route('https://okta.example.com/saml', 'devin', 'navigate', context)).toEqual({
      kind: 'in-place',
    });
    // Tenant popups go to the devin view; other popups go to the system browser.
    expect(route('https://cloudbeds.devinenterprise.com/x', 'github', 'new-window', context)).toEqual(
      { kind: 'devin' },
    );
    expect(route('https://example.org/', 'devin', 'new-window', context)).toEqual({
      kind: 'external',
    });
    expect(route('mailto:a@b.c', 'devin', 'navigate', context)).toEqual({ kind: 'external' });
    expect(route('javascript:alert(1)', 'devin', 'new-window', context)).toEqual({ kind: 'deny' });
    expect(route('not a url', 'shell', 'new-window', context)).toEqual({ kind: 'deny' });
  });
});

describe('route from the analytics surface', () => {
  it('routes same-tab tenant links (non-analytics) to the Cloud view', () => {
    expect(
      route('https://cloudbeds.devinenterprise.com/sessions/abc', 'analytics', 'navigate', context),
    ).toEqual({ kind: 'devin' });
  });

  it('keeps same-tab analytics routes in place', () => {
    expect(
      route('https://cloudbeds.devinenterprise.com/settings/my-analytics/usage', 'analytics', 'navigate', context),
    ).toEqual({ kind: 'in-place' });
    expect(
      route('https://cloudbeds.devinenterprise.com/settings/my-analytics', 'analytics', 'navigate', context),
    ).toEqual({ kind: 'in-place' });
  });

  it('opens same-tab GitHub links in a foreground tab', () => {
    expect(route('https://github.com/o/r', 'analytics', 'navigate', context)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
  });

  it('keeps same-tab external hops in place and opens popups externally', () => {
    expect(route('https://okta.example.com/sso', 'analytics', 'navigate', context)).toEqual({
      kind: 'in-place',
    });
    expect(route('https://example.org/x', 'analytics', 'new-window', context)).toEqual({
      kind: 'external',
    });
  });
});

describe('link rules', () => {
  const linkRule = (overrides: Partial<LinkRule> = {}): LinkRule => ({
    id: 'r1',
    kind: 'prefix',
    pattern: 'https://jira.example.com/browse/',
    enabled: true,
    ...overrides,
  });
  const ruleContext = {
    ...context,
    rules: compileLinkRules([
      linkRule({ id: 'jira', pattern: 'https://jira.example.com/browse/' }),
      linkRule({ id: 'everything', kind: 'regex', pattern: '^https://' }),
    ]),
  };

  it('routes a matched URL to rule', () => {
    expect(routeUrl('https://jira.example.com/browse/ISSUE-1', ruleContext)).toBe('rule');
    const onlyJira = {
      ...context,
      rules: compileLinkRules([linkRule({ id: 'jira' })]),
    };
    expect(routeUrl('https://unrelated.example.org/', onlyJira)).toBe('external');
  });

  it('tenant always beats a rule, github always beats a rule', () => {
    expect(
      routeUrl('https://cloudbeds.devinenterprise.com/sessions/1', ruleContext),
    ).toBe('devin');
    expect(routeUrl('https://github.com/org/repo', ruleContext)).toBe('github');
    expect(routeUrl('http://127.0.0.1:43111/page', ruleContext)).toBe('github');
  });

  it('treats rule matches like github for decisions', () => {
    const url = 'https://jira.example.com/browse/ISSUE-1';
    expect(route(url, 'devin', 'new-window', ruleContext)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
    expect(route(url, 'shell', 'new-window', ruleContext)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
    expect(route(url, 'github', 'background', ruleContext)).toEqual({
      kind: 'gh-tab',
      background: true,
    });
    expect(route(url, 'devin', 'navigate', ruleContext)).toEqual({
      kind: 'gh-tab',
      background: false,
    });
    // Navigations inside hosted views stay in place even when a rule matches.
    expect(route(url, 'github', 'navigate', ruleContext)).toEqual({ kind: 'in-place' });
  });
});

describe('provider-owned origins', () => {
  const providerContext = {
    ...context,
    providers: [
      { providerId: 'devin-cloud', origin: 'https://cloudbeds.devinenterprise.com' },
      { providerId: 'x', origin: 'https://x.test' },
    ],
  };

  it('behaves identically with only the Devin provider', () => {
    const devinOnly = {
      ...context,
      providers: [{ providerId: 'devin-cloud', origin: context.tenantUrl }],
    };
    for (const url of [
      'https://cloudbeds.devinenterprise.com/sessions/1',
      'https://github.com/o/r',
      'https://example.com/',
    ]) {
      expect(routeUrl(url, devinOnly)).toBe(routeUrl(url, context));
      expect(route(url, 'devin', 'new-window', devinOnly)).toEqual(
        route(url, 'devin', 'new-window', context),
      );
    }
  });

  it('routes a new-window link to a provider origin to that provider', () => {
    expect(route('https://x.test/conversations/1', 'devin', 'new-window', providerContext)).toEqual({
      kind: 'provider',
      providerId: 'x',
    });
  });

  it('keeps navigations inside a provider view in place', () => {
    expect(
      route('https://x.test/conversations/2', 'provider', 'navigate', providerContext, 'x'),
    ).toEqual({ kind: 'in-place' });
  });

  it('sends a Devin tenant new-window link from a provider view to Devin', () => {
    expect(
      route('https://cloudbeds.devinenterprise.com/sessions/1', 'provider', 'new-window', providerContext, 'x'),
    ).toEqual({ kind: 'devin' });
  });

  it('opens GitHub navigations from a provider view as a foreground gh-tab', () => {
    expect(route('https://github.com/o/r', 'provider', 'navigate', providerContext, 'x')).toEqual({
      kind: 'gh-tab',
      background: false,
    });
  });

  it('ranks github over provider over rule', () => {
    const rules = compileLinkRules([
      { id: 'r', kind: 'prefix', pattern: 'https://x.test/', enabled: true },
    ] as LinkRule[]);
    expect(routeUrl('https://x.test/a', { ...providerContext, rules })).toBe('provider');
    expect(
      routeUrl('https://x.test/a', {
        ...providerContext,
        githubOrigins: ['https://x.test'],
      }),
    ).toBe('github');
  });

  it('hands a navigation toward another provider origin to that provider', () => {
    const two = {
      ...providerContext,
      providers: [...providerContext.providers, { providerId: 'y', origin: 'https://y.test' }],
    };
    expect(route('https://y.test/a', 'provider', 'navigate', two, 'x')).toEqual({
      kind: 'provider',
      providerId: 'y',
    });
  });
});
