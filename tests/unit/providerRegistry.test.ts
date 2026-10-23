import { describe, expect, it } from 'vitest';
import {
  NotificationSourceSchema,
  PROVIDERS,
  PROVIDER_ANALYTICS_TABS,
  PROVIDER_SOURCES,
  PROVIDER_SURFACES,
  PROVIDER_USAGE_METRICS,
  PROVIDER_VIEW_NAMES,
  UsageMetricSchema,
  providerById,
} from '../../src/core/providers';
import type { ProviderId } from '../../src/core/providers';
import { SETTINGS_TAB_ORDER } from '../../src/core/settingsDraft';
import { SessionPrSchema, SettingsPatchSchema, SurfaceSchema } from '../../src/shared/ipc';
import { PROVIDER_UI_KEYS } from '../../src/shell/providerKeys';

describe('provider registry guard', () => {
  it('SurfaceSchema is the provider surfaces plus settings and analytics', () => {
    expect([...SurfaceSchema.options]).toEqual([...PROVIDER_SURFACES, 'settings', 'analytics']);
  });

  it('notification source schema matches PROVIDER_SOURCES', () => {
    expect([...NotificationSourceSchema.options]).toEqual([...PROVIDER_SOURCES]);
  });

  it('SessionPrSchema source options match PROVIDER_SOURCES', () => {
    expect([...SessionPrSchema.shape.source.removeDefault().options]).toEqual([...PROVIDER_SOURCES]);
  });

  it('analytics tab setting options match PROVIDER_ANALYTICS_TABS', () => {
    const analytics = SettingsPatchSchema.shape.analytics.unwrap();
    expect([...analytics.shape.tab.unwrap().options]).toEqual([...PROVIDER_ANALYTICS_TABS]);
  });

  it('UsageMetricSchema matches PROVIDER_USAGE_METRICS', () => {
    expect([...UsageMetricSchema.options]).toEqual([...PROVIDER_USAGE_METRICS]);
  });

  it('every settingsTab is a known settings tab', () => {
    for (const p of PROVIDERS) expect(SETTINGS_TAB_ORDER).toContain(p.settingsTab);
  });

  it('descriptor fields stay inside the declared tuples', () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_SURFACES).toContain(p.surface);
      if (p.source !== null) expect(PROVIDER_SOURCES).toContain(p.source);
      if (p.analyticsTab !== null) expect(PROVIDER_ANALYTICS_TABS).toContain(p.analyticsTab);
      if (p.viewName !== null) expect(PROVIDER_VIEW_NAMES).toContain(p.viewName);
      for (const m of p.usageMetrics) expect(PROVIDER_USAGE_METRICS).toContain(m);
    }
  });

  it('providerById throws on an unknown id', () => {
    expect(() => providerById('nope' as ProviderId)).toThrow(/unknown provider/);
    for (const p of PROVIDERS) expect(providerById(p.id)).toBe(p);
  });

  it('every provider declares UI slots, and analytics tabs have a panel', () => {
    expect(Object.keys(PROVIDER_UI_KEYS).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
    for (const p of PROVIDERS) {
      const keys = PROVIDER_UI_KEYS[p.id];
      expect(keys.analyticsPanel).toBe(p.analyticsTab !== null);
    }
  });
});
