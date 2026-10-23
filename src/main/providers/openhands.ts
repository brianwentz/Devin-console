// OpenHands Cloud runtime: a REST-poll source (../openhands/source.ts) driven by
// the generic CloudSessionsController, polled on a focus-dependent cadence.
// Top level only builds the object — Electron singletons are resolved inside
// methods (this module sits in import cycles with window/shortcuts).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, net, session, webContents } from 'electron';
import { sanitizeMessage } from '../../core/devinApi';
import { effectiveBaseUrl, normalizeBaseUrl } from '../../core/openhands';
import { providerById } from '../../core/providers';
import type { CloudCache } from '../../core/cloudCache';
import type { Settings } from '../../shared/ipc';
import { CloudSessionsController } from '../cloudKit/sessionsController';
import { log } from '../log';
import { createOpenHandsFetch } from '../openhands/fetch';
import { buildOpenHandsShellState, createOpenHandsSource, type OpenHandsSource } from '../openhands/source';
import { setOpenHandsSnapshotSource } from '../openhandsConfig';
import { state, testMode } from '../state';
import { applyLayout, notifyShell } from '../window';
import type { ProviderRuntime } from './runtime';

const PARTITION = 'persist:openhands';
const BLURRED_FACTOR = 4;

interface Active {
  base: string;
  source: OpenHandsSource;
  controller: CloudSessionsController;
}

let active: Active | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
// Last key the transport read — only used to scrub error text.
let knownKey: string | null = null;

const cachePath = (): string => join(app.getPath('userData'), 'openhands-cache.json');

function currentBase(settings?: Settings): string {
  const saved = (settings ?? state.settings?.current)?.openhands.baseUrl;
  return effectiveBaseUrl(
    saved ?? 'https://app.all-hands.dev',
    testMode ? process.env.AGENT_WORKSPACE_TEST_OPENHANDS_URL : undefined,
  );
}

function pollMs(pollSeconds: number): number {
  const override = testMode ? Number(process.env.AGENT_WORKSPACE_TEST_OPENHANDS_POLL_MS) : 0;
  return override > 0 ? override : pollSeconds * 1000;
}

function build(base: string): Active {
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
    tenantKey: () => normalizeBaseUrl(base, true) ?? base,
    readCache: async () => {
      try {
        return JSON.parse(await readFile(cachePath(), 'utf8')) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
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
  return { base, source, controller };
}

function stopActive(): void {
  if (!active) return;
  try {
    active.controller.stop();
  } catch (error) {
    log('shell', 'openhands-stop-error', { detail: { code: error instanceof Error ? error.name : 'unknown' } });
  }
  active = null;
}

function refresh(reason: 'start' | 'poll' | 'focus' | 'full' | 'mutate' | 'settings' | 'test'): Promise<void> {
  return active?.controller.refresh(reason) ?? Promise.resolve();
}

function focused(): boolean {
  // A hosted WebContentsView leaves BaseWindow.isFocused() false.
  return webContents.getFocusedWebContents() !== null;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (disposed || !active) return;
  const seconds = state.settings?.current.openhands.pollSeconds ?? 30;
  const ms = pollMs(seconds) * (focused() ? 1 : BLURRED_FACTOR);
  timer = setTimeout(() => void tick(), ms);
  timer.unref?.();
}

async function tick(): Promise<void> {
  // A slow list must not queue a follow-up on top of itself.
  if (!disposed && active && !active.source.isListing()) await refresh('poll');
  schedule();
}

function startActive(): void {
  active = build(currentBase());
  void active.controller.start();
  schedule();
}

function snapshot() {
  if (!active) return null;
  return buildOpenHandsShellState(active.controller.snapshot(), active.source.connection());
}

export const openhandsRuntime: ProviderRuntime & { showHome?: () => void } = {
  descriptor: providerById('openhands'),
  start() {
    if (active || disposed) return;
    setOpenHandsSnapshotSource(snapshot);
    startActive();
  },
  async dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    stopActive();
  },
  onFocus() {
    if (!active) return;
    active.source.requestFull();
    void refresh('focus');
  },
  onSettingsChanged(_previous, next) {
    if (disposed || !active) return;
    if (currentBase(next) !== active.base) {
      // A different tenant: its rows, cursor and cache are not ours any more.
      stopActive();
      void rm(cachePath(), { force: true })
        .catch(() => undefined)
        .then(() => {
          if (disposed || active) return;
          startActive();
          notifyShell();
        });
      return;
    }
    schedule();
  },
  onCredentialsChanged() {
    if (!active) return;
    active.source.requestFull();
    void refresh('settings');
  },
  async newSession() {
    state.surface = 'openhands';
    applyLayout();
    notifyShell();
    openhandsRuntime.showHome?.();
  },
};

// Test hooks (src/main/testHooks.ts).
export const openhandsState = snapshot;
export function openhandsRefresh(): Promise<void> {
  active?.source.requestFull();
  return refresh('test');
}
