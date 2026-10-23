import { z } from 'zod';
import type { SettingsTabId } from './settingsDraft';

export type ProviderId = 'devin-cloud' | 'devin-local' | 'claude';

export const PROVIDER_SURFACES = ['cloud', 'local', 'claude'] as const;
export const PROVIDER_SOURCES = ['devin', 'claude'] as const;
export const PROVIDER_VIEW_NAMES = ['cloud', 'local', 'claude'] as const;
export const PROVIDER_ANALYTICS_TABS = ['devin', 'claude'] as const;
export const PROVIDER_USAGE_METRICS = ['devin-monthly', 'claude-session', 'claude-weekly'] as const;

export type ProviderSource = (typeof PROVIDER_SOURCES)[number];
export type ProviderViewName = (typeof PROVIDER_VIEW_NAMES)[number];
export const NotificationSourceSchema = z.enum(PROVIDER_SOURCES);
export const UsageMetricSchema = z.enum(PROVIDER_USAGE_METRICS);

export interface ProviderDescriptor {
  id: ProviderId;
  kind: 'cloud' | 'local';
  surface: (typeof PROVIDER_SURFACES)[number];
  label: string;
  railId: string;
  viewName: ProviderViewName | null;
  scopePrefix: string;
  scopeFallback: 'cloud' | 'global';
  source: (typeof PROVIDER_SOURCES)[number] | null;
  settingsTab: SettingsTabId;
  analyticsTab: (typeof PROVIDER_ANALYTICS_TABS)[number] | null;
  usageMetrics: readonly (typeof PROVIDER_USAGE_METRICS)[number][];
  dock: boolean;
  sessionsColumn: boolean;
  newSessionShortcut: boolean;
  sidebarShortcut: boolean;
}

/** Rail order: devin-cloud, devin-local, claude. */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'devin-cloud',
    kind: 'cloud',
    surface: 'cloud',
    label: 'Cloud',
    railId: 'cloudButton',
    viewName: 'cloud',
    scopePrefix: '',
    scopeFallback: 'cloud',
    source: 'devin',
    settingsTab: 'devin',
    analyticsTab: 'devin',
    usageMetrics: ['devin-monthly'],
    dock: true,
    sessionsColumn: true,
    newSessionShortcut: true,
    sidebarShortcut: true,
  },
  {
    id: 'devin-local',
    kind: 'local',
    surface: 'local',
    label: 'Local',
    railId: 'localButton',
    viewName: 'local',
    scopePrefix: 'local:',
    scopeFallback: 'cloud',
    source: null,
    settingsTab: 'devin',
    analyticsTab: null,
    usageMetrics: [],
    dock: true,
    sessionsColumn: true,
    newSessionShortcut: true,
    sidebarShortcut: false,
  },
  {
    id: 'claude',
    kind: 'local',
    surface: 'claude',
    label: 'Claude',
    railId: 'claudeButton',
    viewName: 'claude',
    scopePrefix: 'claude:',
    scopeFallback: 'cloud',
    source: 'claude',
    settingsTab: 'claude',
    analyticsTab: 'claude',
    usageMetrics: ['claude-session', 'claude-weekly'],
    dock: true,
    sessionsColumn: true,
    newSessionShortcut: true,
    sidebarShortcut: true,
  },
];

export function providerById(id: ProviderId): ProviderDescriptor {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
}

// Non-throwing surface lookup for a provider id that may come from outside the
// ProviderId union (e.g. a route decision).
export function surfaceForProvider(id: string): ProviderDescriptor['surface'] | undefined {
  return PROVIDERS.find((p) => p.id === id)?.surface;
}

export function providerBySurface(surface: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.surface === surface);
}

export function providerBySource(source: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.source === source);
}
