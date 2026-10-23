// OpenHands Cloud runtime: a REST-poll source (../openhands/source.ts) driven by
// the generic CloudSessionsController. The lifecycle (opt-in gate, poll timer,
// focus, base URL change) lives in ../openhands/runtimeCore.ts; this module
// wires it to Electron. Top level only builds the object — Electron singletons
// are resolved inside methods (this module sits in import cycles with
// window/shortcuts).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, net, session, webContents } from 'electron';
import { sanitizeMessage } from '../../core/devinApi';
import { effectiveBaseUrl, normalizeBaseUrl } from '../../core/openhands';
import { providerById } from '../../core/providers';
import type { CloudCache } from '../../core/cloudCache';
import { CloudSessionsController } from '../cloudKit/sessionsController';
import { log } from '../log';
import { createOpenHandsFetch } from '../openhands/fetch';
import {
  cacheMatchesTenant,
  createOpenHandsRuntimeCore,
  type OhSettingsLike,
} from '../openhands/runtimeCore';
import { buildOpenHandsShellState, createOpenHandsSource } from '../openhands/source';
import { setOpenHandsSnapshotSource } from '../openhandsConfig';
import { state, testMode } from '../state';
import { applyLayout, notifyShell } from '../window';
import type { ProviderRuntime } from './runtime';

const PARTITION = 'persist:openhands';
// Last key the transport read — only used to scrub error text.
let knownKey: string | null = null;

const cachePath = (): string => join(app.getPath('userData'), 'openhands-cache.json');
const tenantKey = (base: string): string => normalizeBaseUrl(base, true) ?? base;
const effective = (saved: string | undefined): string =>
  effectiveBaseUrl(
    saved ?? 'https://app.all-hands.dev',
    testMode ? process.env.AGENT_WORKSPACE_TEST_OPENHANDS_URL : undefined,
  );

async function readCacheFile(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(cachePath(), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function build(base: string) {
  const fetcher = createOpenHandsFetch({
    baseUrl: () => base,
    apiKey: async () => {
      knownKey = (await state.secrets?.getOpenHandsApiKey()) ?? null;
      return knownKey;
    },
    netFetch: ((url, init) => net.fetch(String(url), init as RequestInit)) as typeof fetch,
    sessionFetch: ((url, init) =>
      session.fromPartition(PARTITION).fetch(String(url), init as RequestInit)) as typeof fetch,
  });
  const source = createOpenHandsSource({
    fetch: fetcher,
    now: () => Date.now(),
    log: (event, detail) => log('shell', event, { detail }),
    baseUrl: () => base,
  });
  const controller = new CloudSessionsController(source, {
    tenantKey: () => tenantKey(base),
    readCache: readCacheFile,
    writeCache: async (data: CloudCache) => {
      const file = cachePath();
      await mkdir(join(file, '..'), { recursive: true });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(data), 'utf8');
      await rename(temporary, file);
    },
    log: (event, detail) => log('shell', event, { detail }),
    sanitize: (message) => sanitizeMessage(message, knownKey ?? ''),
    onChange: () => notifyShell(),
  });
  return { source, controller };
}

const core = createOpenHandsRuntimeCore({
  currentBase: () => effective(state.settings?.current.openhands.baseUrl),
  baseOf: (s: OhSettingsLike) => effective(s.openhands.baseUrl),
  pollSeconds: () => state.settings?.current.openhands.pollSeconds ?? 30,
  pollMs: (seconds) => {
    const override = testMode ? Number(process.env.AGENT_WORKSPACE_TEST_OPENHANDS_POLL_MS) : 0;
    return override > 0 ? override : seconds * 1000;
  },
  build,
  hasKey: async () => ((await state.secrets?.getOpenHandsApiKey()) ?? null) !== null,
  cacheMatches: async (base) => cacheMatchesTenant(await readCacheFile(), tenantKey(base)),
  dropCache: () => rm(cachePath(), { force: true }),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // A hosted WebContentsView leaves BaseWindow.isFocused() false.
  focused: () => webContents.getFocusedWebContents() !== null,
  onChange: () => notifyShell(),
  log: (event, detail) => log('shell', event, { detail }),
});

function snapshot() {
  const live = core.snapshot();
  return live ? buildOpenHandsShellState(live.state, live.connection) : null;
}

export const openhandsRuntime: ProviderRuntime & { showHome?: () => void } = {
  descriptor: providerById('openhands'),
  start() {
    setOpenHandsSnapshotSource(snapshot);
    void core.start();
  },
  dispose: () => core.dispose(),
  onFocus() {
    core.onFocus();
  },
  onSettingsChanged(previous, next) {
    void core.onSettingsChanged(previous, next);
  },
  onCredentialsChanged() {
    void (async () => {
      const key = (await state.secrets?.getOpenHandsApiKey()) ?? null;
      await core.onCredentialsChanged(key !== null);
    })();
  },
  onSurfaceEnter() {
    core.onSurfaceEnter();
  },
  async newSession() {
    state.surface = 'openhands';
    applyLayout();
    notifyShell();
    openhandsRuntime.showHome?.();
  },
};

// Test hooks (src/main/testHooks.ts). Refresh opens the gate.
export const openhandsState = snapshot;
export function openhandsRefresh(): Promise<void> {
  return core.forceRefresh();
}
