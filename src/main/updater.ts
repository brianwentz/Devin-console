import { app, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shutdown } from './index';
import { log } from './log';
import { notificationStore } from './notifications';
import {
  RELEASE_REPO,
  releaseNotesCache,
} from './releases';
import { releasesPageUrl } from '../core/releaseNotes';
import { testMode } from './state';
import type { ReleaseNotesReply, UpdateState } from '../shared/ipc';
import { notifyShell } from './window';

const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 2 * 60 * 60 * 1000;
const SETTINGS_THROTTLE_MS = 60_000;
const RESUME_THROTTLE_MS = 15 * 60 * 1000;
const FOCUS_THROTTLE_MS = 60 * 60 * 1000;

let enabled = false;
let checking = false;
let lastCheckedAt: number | null = null;
let lastError: string | null = null;
let downloadedVersion: string | null = null;
let availableVersion: string | null = null;

export type UpdateCheckSource = 'startup' | 'timer' | 'settings' | 'manual' | 'resume' | 'focus';

const THROTTLE_MS: Partial<Record<UpdateCheckSource, number>> = {
  settings: SETTINGS_THROTTLE_MS,
  resume: RESUME_THROTTLE_MS,
  focus: FOCUS_THROTTLE_MS,
};

function recordError(error: unknown, options: { log?: boolean } = {}): void {
  const message = String((error as { message?: unknown })?.message ?? error);
  lastError = message.split('\n', 1)[0]!.slice(0, 200);
  if (options.log !== false) {
    log('shell', 'update-error', { detail: { message } });
  }
  notifyShell();
}

export function checkForUpdatesNow(source: UpdateCheckSource): void {
  if (!enabled && !testMode) {
    // Only shell-originated requests are worth a log line — focus/resume would
    // spam dev builds on every window focus.
    if (source === 'settings' || source === 'manual') {
      log('shell', 'update-check-skipped', { detail: { source, reason: 'disabled' } });
    }
    return;
  }
  if (checking) {
    log('shell', 'update-check-skipped', { detail: { source, reason: 'in-flight' } });
    return;
  }
  // The window 'focus' event fires at launch — that check is covered by the
  // 30 s startup timer, so focus checks only run once a baseline exists.
  if (source === 'focus' && lastCheckedAt === null) return;
  const throttleMs = THROTTLE_MS[source];
  if (lastCheckedAt !== null && throttleMs !== undefined) {
    const sinceMs = Date.now() - lastCheckedAt;
    if (sinceMs < throttleMs) {
      log('shell', 'update-check-skipped', {
        detail: { source, reason: 'throttled', sinceMs },
      });
      return;
    }
  }
  log('shell', 'update-check', { detail: { source } });
  checking = true;
  lastError = null;
  lastCheckedAt = Date.now();
  notifyShell();
  if (testMode) {
    // Simulated check — the e2e suite must never hit the network.
    setTimeout(() => {
      checking = false;
      notifyShell();
    }, 0).unref();
    return;
  }
  autoUpdater
    .checkForUpdates()
    .catch((error: unknown) => recordError(error, { log: false }))
    .finally(() => {
      checking = false;
      notifyShell();
    });
}

export function updateOnWindowFocus(): void {
  checkForUpdatesNow('focus');
}

export function updateOnResume(): void {
  checkForUpdatesNow('resume');
}

export function updateState(): UpdateState {
  return {
    version: app.getVersion(),
    available: availableVersion,
    downloaded: downloadedVersion,
    releasesUrl: releasesPageUrl(RELEASE_REPO.owner, RELEASE_REPO.repo),
    enabled: enabled || testMode,
    checking,
    lastCheckedAt: lastCheckedAt === null ? null : new Date(lastCheckedAt).toISOString(),
    error: lastError,
  };
}

export function updateAvailable(version: string): void {
  availableVersion = version;
  notifyShell();
}

export function availableUpdateVersion(): string | null {
  return availableVersion;
}

// Lazy release-notes lookup for the Updates tab — fetches on demand so a
// settings view that is never opened never touches the network.
export async function releaseNotesReply(): Promise<ReleaseNotesReply> {
  const version = availableVersion;
  const [current, available] = await Promise.all([
    releaseNotesCache.get(app.getVersion()),
    version ? releaseNotesCache.get(version) : Promise.resolve(null),
  ]);
  return { current, available };
}

export function hasDownloadedUpdate(): boolean {
  return downloadedVersion !== null;
}

// Called from shutdown() instead of app.exit(0) when an update is ready —
// app.exit skips the quit lifecycle so autoInstallOnAppQuit would never run.
export function quitAndInstall(): void {
  log('shell', 'update-install', { detail: { version: downloadedVersion } });
  autoUpdater.quitAndInstall(true, true);
}

// P6: clicking an 'update' notification installs it. In test mode this only
// logs — the e2e exercises the path without quitting.
export function installUpdate(): void {
  const version = downloadedVersion;
  // Remove the update entry (there may be other notifications in the list).
  const entry = notificationStore().entries().find((item) => item.kind === 'update');
  if (entry) notificationStore().remove(entry.id);
  if (testMode) {
    log('shell', 'update-install', { detail: { version, testMode: true } });
    return;
  }
    // Dynamic import would need an .cjs/.js suffix under nodenext; keep it
  // static — index.ts already imports updater.ts, cycles resolve at call time.
  void shutdown({ installUpdate: true });
}

// Called from updater's update-downloaded event and the test hook.
export function updateDownloaded(version: string): void {
  downloadedVersion = version;
  availableVersion = version;
  log('shell', 'update-downloaded', { detail: { version } });
  notificationStore().add({
    kind: 'update',
    version,
    sessionId: null,
    ownerUserId: null,
    sessionTitle: 'Agent Workspace',
    title: `Update v${version} ready`,
    body: 'Click to restart and install',
    createdAt: Date.now(),
  });
}

// Re-add the entry when a quit was vetoed by a beforeunload prompt — the
// install notification must survive cancelled shutdowns.
export function restoreUpdateEntry(): void {
  if (downloadedVersion) updateDownloadedKeep();
}
function updateDownloadedKeep(): void {
  if (!downloadedVersion) return;
  notificationStore().add({
    kind: 'update',
    version: downloadedVersion,
    sessionId: null,
    ownerUserId: null,
    sessionTitle: 'Agent Workspace',
    title: `Update v${downloadedVersion} ready`,
    body: 'Click to restart and install',
    createdAt: Date.now(),
  });
}

// GitHub Releases auto-update (feed from build.publish in package.json, baked
// into resources/app-update.yml by electron-builder). Downloads silently and
// installs via the 'update' notification. Skipped in dev and under
// AGENT_WORKSPACE_TEST so the smoke/e2e suites never touch the network.
export function setupUpdater(): void {
  if (!app.isPackaged || testMode) {
    log('shell', 'updater-disabled', { detail: { isPackaged: app.isPackaged, testMode } });
    return;
  }
  // electron-updater on darwin throws for unsigned apps; scripts/after-pack.cjs
  // records whether the build was signed so unsigned Mac builds skip the
  // updater instead of erroring on every check.
  if (process.platform === 'darwin') {
    let signed = false;
    try {
      const marker = JSON.parse(
        readFileSync(join(process.resourcesPath, 'signing.json'), 'utf8'),
      ) as { signed?: unknown };
      signed = marker.signed === true;
    } catch {
      signed = false;
    }
    if (!signed) {
      log('shell', 'updater-disabled', {
        detail: { isPackaged: app.isPackaged, testMode, reason: 'unsigned-mac' },
      });
      return;
    }
  }
  enabled = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    log('shell', 'update-available', { detail: { version: info.version } });
    updateAvailable(info.version);
  });
  autoUpdater.on('update-not-available', (info) =>
    log('shell', 'update-not-available', { detail: { version: info.version } }),
  );
  autoUpdater.on('update-downloaded', (info) => updateDownloaded(info.version));
  autoUpdater.on('error', (error) => recordError(error));

  powerMonitor.on('resume', updateOnResume);
  powerMonitor.on('unlock-screen', updateOnResume);

  setTimeout(() => checkForUpdatesNow('startup'), INITIAL_DELAY_MS).unref();
  setInterval(() => checkForUpdatesNow('timer'), INTERVAL_MS).unref();
}
