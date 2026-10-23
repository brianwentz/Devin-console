// Registry of hosted-web view pools, one per cloud provider. Devin Cloud's
// pool registers itself on first use (src/main/cloudViews.ts cloudViews()).

import { providerBySurface } from '../../core/providers';
import type { WebContentsView } from 'electron';
import type { ViewPool } from './viewPool';

const registry: ViewPool[] = [];

// Registers a pool under its providerId. Re-registering the same instance is a
// no-op; a second, different pool for the same provider is a programming error.
export function registerPool(pool: ViewPool): void {
  const existing = registry.find((p) => p.providerId === pool.providerId);
  if (existing === pool) return;
  if (existing) throw new Error(`view pool already registered: ${pool.providerId}`);
  registry.push(pool);
}

export function pools(): readonly ViewPool[] {
  return registry;
}

// Every pooled view across all providers (attached or not).
export function allPoolViews(): WebContentsView[] {
  return registry.flatMap((p) => p.views());
}

export function poolFor(providerId: string): ViewPool | undefined {
  return registry.find((p) => p.providerId === providerId);
}

export function poolForSurface(surface: string): ViewPool | undefined {
  const provider = providerBySurface(surface);
  return provider ? poolFor(provider.id) : undefined;
}
