import type { ProviderDescriptor } from '../../core/providers';
import type { AppNotification } from '../../core/notificationModel';
import type { SessionPrLink } from '../../core/notifyModel';
import type { Settings } from '../../shared/ipc';
import type { UsageSource } from '../cloudKit/usage';

// Electron-free: the registry and disposeAll are unit-tested directly. Wrappers
// (devinCloud.ts, devinLocal.ts, claude.ts) delegate to the existing singletons.
export interface ProviderRuntime {
  descriptor: ProviderDescriptor;
  start(): void;
  dispose(): Promise<void>;
  onFocus?(): void;
  // (previous, next) like the existing services — not a bare patch.
  onSettingsChanged?(previous: Settings, next: Settings): void;
  onPrPanelOpen?(): void;
  openPullRequests?(): SessionPrLink[];
  /** true = handled */
  openNotification?(entry: AppNotification): boolean;
  /** PR-panel open for a row owned by this provider. */
  openSessionPr?(sessionId: string, prUrl: string): void;
  newSession?(): Promise<void>;
  /** Stored credentials changed (e.g. an API key was set or cleared). */
  onCredentialsChanged?(): void;
  /** The user entered this provider's surface (called from applyLayout). */
  onSurfaceEnter?(): void;
  /**
   * false while this provider has not listed its PRs yet this run, so a PR
   * of it missing from `openPullRequests()` proves nothing. Omitted = true.
   */
  prsKnown?(): boolean;
  /**
   * Usage readings (UsageAlertStore subscribes at creation) and summary items
   * (window.ts usageSummary, in runtime order). Omitted = no usage.
   */
  usage?: UsageSource;
}

const registry: ProviderRuntime[] = [];
let logger: (event: string, detail: Record<string, unknown>) => void = () => {};

export function setRuntimeLogger(fn: (event: string, detail: Record<string, unknown>) => void): void {
  logger = fn;
}

export function registerRuntime(runtime: ProviderRuntime): void {
  if (registry.some((r) => r.descriptor.id === runtime.descriptor.id)) {
    throw new Error(`duplicate provider runtime ${runtime.descriptor.id}`);
  }
  registry.push(runtime);
}

export function runtimes(): readonly ProviderRuntime[] {
  return registry;
}

export function runtimeFor(idOrSurface: string): ProviderRuntime | undefined {
  return (
    registry.find((r) => r.descriptor.id === idOrSurface) ??
    registry.find((r) => r.descriptor.surface === idOrSurface)
  );
}

// PR panel records may be pruned only when every provider's open-PR list is
// authoritative (src/main/prs.ts PrStore.reconcile).
export function allPrsKnown(): boolean {
  return registry.every((r) => r.prsKnown?.() ?? true);
}

export async function disposeAll(): Promise<void> {
  for (const runtime of registry) {
    try {
      await runtime.dispose();
    } catch {
      logger('provider-dispose-error', { provider: runtime.descriptor.id });
    }
  }
}

export function resetRuntimesForTest(): void {
  registry.length = 0;
  logger = () => {};
}
