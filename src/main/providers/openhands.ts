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
import {
  isConversationId,
  normalizeBaseUrl,
  notifyAllowed,
  openHandsEntry,
  type OhTransition,
} from '../../core/openhands';
import { providerScope } from '../../core/tabModel';
import type { OpenHandsContextMenuRequest } from '../../shared/ipc';
import { providerById } from '../../core/providers';
import type { CloudCache } from '../../core/cloudCache';
import { CloudSessionsController } from '../cloudKit/sessionsController';
import { log } from '../log';
import { notificationStore } from '../notifications';
import { OpenHandsContextMenu } from '../openhands/contextMenu';
import { createOpenHandsFetch } from '../openhands/fetch';
import {
  cacheMatchesTenant,
  createOpenHandsRuntimeCore,
  type OhSettingsLike,
} from '../openhands/runtimeCore';
import { buildOpenHandsShellState, createOpenHandsSource } from '../openhands/source';
import {
  openhandsForgetSession,
  openhandsOpenSession,
  openhandsShowHome,
  openhandsViews,
  resetOpenHandsViews,
} from '../openhands/views';
import { idleOpenHandsState, openhandsEffectiveBase, setOpenHandsSnapshotSource } from '../openhandsConfig';
import { state, testMode } from '../state';
import { applyLayout, notifyShell } from '../window';
import type { ProviderRuntime } from './runtime';

const PARTITION = 'persist:openhands';
// Last key the transport read — only used to scrub error text.
let knownKey: string | null = null;

const cachePath = (): string => join(app.getPath('userData'), 'openhands-cache.json');
const tenantKey = (base: string): string => normalizeBaseUrl(base, true) ?? base;
const effective = openhandsEffectiveBase;

async function readCacheFile(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(cachePath(), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Status transitions of a successful list -> notification entries, gated like
// the Claude chat path. Logs kinds/counts only (never titles).
function notifyTransitions(transitions: OhTransition[]): void {
  try {
    const settings = state.settings?.current.notifications;
    const counts: Record<string, number> = {};
    for (const t of transitions) {
      if (!notifyAllowed(settings?.collect, settings?.kinds, t.kind)) continue;
      notificationStore().add(openHandsEntry(t, t.row));
      counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    }
    for (const [kind, count] of Object.entries(counts)) log('shell', 'openhands-notify', { detail: { kind, count } });
  } catch (error) {
    log('shell', 'openhands-notify-error', { detail: { code: error instanceof Error ? error.name : 'unknown' } });
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
    onTransitions: notifyTransitions,
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

// Live controller state only (null before a gate opens).
function liveSnapshot() {
  const live = core.snapshot();
  return live ? buildOpenHandsShellState(live.state, live.connection) : null;
}

// ShellState slice: the live state, or an idle one carrying the error of a
// rename/delete that found no gate open.
function snapshot() {
  const live = liveSnapshot();
  const local = core.localError();
  if (live) return live.lastError || !local ? live : { ...live, lastError: local };
  return local ? idleOpenHandsState(local) : null;
}

const menu = new OpenHandsContextMenu({
  titleOf: (id) => liveSnapshot()?.sessions.find((s) => s.id === id)?.title,
  capabilities: () => liveSnapshot()?.capabilities ?? { rename: false, delete: false },
  baseUrl: () => effective(state.settings?.current.openhands.baseUrl),
  newSession: () => void openhandsRuntime.newSession?.(),
  refresh: () => void openhandsRefresh(),
  remove: (id) => openhandsDelete(id),
});

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
    // The pooled pages belong to the old origin: drop them (cache + source
    // are handled by the core above).
    if (effective(previous.openhands.baseUrl) !== effective(next.openhands.baseUrl)) {
      resetOpenHandsViews();
    }
    const was = previous.openhands;
    const now = next.openhands;
    if (was.maxLiveViews !== now.maxLiveViews || was.keepAliveHours !== now.keepAliveHours) {
      openhandsViews().applyLimits();
    }
  },
  onCredentialsChanged() {
    void (async () => {
      const key = (await state.secrets?.getOpenHandsApiKey()) ?? null;
      await core.onCredentialsChanged(key !== null);
    })();
  },
  onSurfaceEnter() {
    core.onSurfaceEnter();
    // The pool opens no view until the user is here (no request before that).
    if (!openhandsViews().activeView()) openhandsShowHome();
  },
  // Ctrl+N / the sidebar '+': the OpenHands home page (its composer).
  showHome: () => openhandsShowHome({ reload: true, focus: true }),
  openNotification(entry) {
    if (entry.source !== 'openhands' || !entry.sessionId) return false;
    // A conversation of another origin (base URL changed since): home instead.
    if (!openhandsOpenSession(entry.sessionId)) openhandsShowHome();
    notifyShell();
    return true;
  },
  async newSession() {
    menu.record('new-session');
    openhandsRuntime.showHome?.();
    notifyShell();
  },
};

// Sidebar actions (src/main/ipc.ts) and test hooks.
export function openhandsContextMenu(arg: OpenHandsContextMenuRequest) {
  return menu.show(arg);
}
export const openhandsMenuItems = () => menu.menuItems();
export const openhandsMenuClick = (id: string) => menu.clickItem(id);
export const openhandsMutations = () => menu.mutationLog();

const validId = (id: string): boolean =>
  isConversationId(effective(state.settings?.current.openhands.baseUrl), id);

export async function openhandsRename(id: string, title: string): Promise<void> {
  if (!validId(id)) return;
  menu.record('rename', { id });
  await core.mutate({ op: 'rename', id, title });
}
export async function openhandsDelete(id: string): Promise<void> {
  if (!validId(id)) return;
  // Only a server-accepted delete touches the pool; a failure changes nothing.
  if (await core.mutate({ op: 'delete', id })) {
    openhandsForgetSession(id);
    // The conversation is gone: so are its GitHub tabs.
    await state.tabManager?.closeScope(providerScope('openhands', id));
    applyLayout();
  }
}
// Sidebar refresh button.
export function openhandsUiRefresh(): Promise<void> {
  menu.record('refresh');
  return core.forceRefresh();
}

// Test hooks (src/main/testHooks.ts). Refresh opens the gate.
export const openhandsState = snapshot;
export function openhandsRefresh(): Promise<void> {
  return core.forceRefresh();
}
