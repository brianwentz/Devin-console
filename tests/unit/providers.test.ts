import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_ANALYTICS_TABS,
  PROVIDER_SOURCES,
  PROVIDER_SURFACES,
  PROVIDER_USAGE_METRICS,
  providerById,
  providerBySource,
  providerBySurface,
} from '../../src/core/providers';

describe('provider registry', () => {
  it('exposes literal tuples for enums', () => {
    expect([...PROVIDER_SURFACES]).toEqual(['cloud', 'local', 'claude']);
    expect([...PROVIDER_SOURCES]).toEqual(['devin', 'claude']);
    expect([...PROVIDER_ANALYTICS_TABS]).toEqual(['devin', 'claude']);
    expect([...PROVIDER_USAGE_METRICS]).toEqual(['devin-monthly', 'claude-session', 'claude-weekly']);
  });

  it('keeps rail order and matches the tuples', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['devin-cloud', 'devin-local', 'claude']);
    expect(PROVIDERS.map((p) => p.surface)).toEqual([...PROVIDER_SURFACES]);
    expect(PROVIDERS.map((p) => p.label)).toEqual(['Cloud', 'Local', 'Claude']);
  });

  it('describes devin-cloud', () => {
    expect(providerById('devin-cloud')).toMatchObject({
      scopePrefix: '',
      railId: 'cloudButton',
      dock: true,
      sessionsColumn: true,
      newSessionShortcut: true,
      sidebarShortcut: true,
      settingsTab: 'devin',
      viewName: 'cloud',
      scopeFallback: 'cloud',
      analyticsTab: 'devin',
      usageMetrics: ['devin-monthly'],
    });
  });

  it('describes devin-local', () => {
    expect(providerById('devin-local')).toMatchObject({
      scopePrefix: 'local:',
      source: null,
      analyticsTab: null,
      sessionsColumn: true,
      sidebarShortcut: false,
      settingsTab: 'devin',
      viewName: 'local',
      usageMetrics: [],
    });
  });

  it('describes claude', () => {
    expect(providerById('claude')).toMatchObject({
      scopePrefix: 'claude:',
      railId: 'claudeButton',
      sidebarShortcut: true,
      settingsTab: 'claude',
      viewName: 'claude',
      analyticsTab: 'claude',
      usageMetrics: ['claude-session', 'claude-weekly'],
    });
  });

  it('looks providers up', () => {
    expect(providerBySurface('settings')).toBeUndefined();
    expect(providerBySurface('local')?.id).toBe('devin-local');
    expect(providerBySource('devin')?.id).toBe('devin-cloud');
    expect(providerBySource('claude')?.id).toBe('claude');
    expect(providerBySource('nope')).toBeUndefined();
  });

  it('has unique ids and surfaces', () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    expect(new Set(PROVIDERS.map((p) => p.surface)).size).toBe(PROVIDERS.length);
  });
});
