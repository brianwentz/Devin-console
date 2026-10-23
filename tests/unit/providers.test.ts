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
  surfaceForProvider,
} from '../../src/core/providers';

describe('provider registry', () => {
  it('exposes literal tuples for enums', () => {
    expect([...PROVIDER_SURFACES]).toEqual(['cloud', 'local', 'claude', 'openhands']);
    expect([...PROVIDER_SOURCES]).toEqual(['devin', 'claude', 'openhands']);
    expect([...PROVIDER_ANALYTICS_TABS]).toEqual(['devin', 'claude', 'openhands']);
    expect([...PROVIDER_USAGE_METRICS]).toEqual(['devin-monthly', 'claude-session', 'claude-weekly', 'openhands-quota']);
  });

  it('keeps rail order and matches the tuples', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['devin-cloud', 'devin-local', 'claude', 'openhands']);
    expect(PROVIDERS.map((p) => p.surface)).toEqual([...PROVIDER_SURFACES]);
    expect(PROVIDERS.map((p) => p.label)).toEqual(['Cloud', 'Local', 'Claude', 'OpenHands']);
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

  it('describes openhands', () => {
    expect(providerById('openhands')).toEqual({
      id: 'openhands',
      kind: 'cloud',
      surface: 'openhands',
      label: 'OpenHands',
      railId: 'openhandsButton',
      viewName: 'openhands',
      scopePrefix: 'openhands:',
      scopeFallback: 'global',
      source: 'openhands',
      settingsTab: 'openhands',
      analyticsTab: 'openhands',
      usageMetrics: ['openhands-quota'],
      dock: true,
      sessionsColumn: true,
      newSessionShortcut: true,
      sidebarShortcut: true,
    });
    expect(providerBySource('openhands')?.id).toBe('openhands');
    expect(providerBySurface('openhands')?.id).toBe('openhands');
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

describe('surfaceForProvider', () => {
  it('maps a known provider id to its own surface', () => {
    expect(surfaceForProvider('devin-cloud')).toBe('cloud');
    expect(surfaceForProvider('claude')).toBe('claude');
  });
  it('returns undefined for an unknown id instead of throwing', () => {
    expect(surfaceForProvider('nope')).toBeUndefined();
  });
});
