import { contextBridge, ipcRenderer } from 'electron';
import type { AppNotification } from '../core/notificationModel';
import type { CredentialEntry } from '../core/credentials';
import {
  IpcChannels,
  SurfaceSchema,
  type BadgeRender,
  type ClaudeChatStatePublic,
  type ClaudePermissionMode,
  type IdentityInfo,
  type SessionPr,
  type LocalResult,
  type ReleaseNotesReply,
  type LocalSessionSummary,
  type LocalStatePublic,
  type ScopeSummary,
  type Settings,
  type SettingsCommitResult,
  type ShellState,
  type Surface,
  type TerminalSummary,
} from '../shared/ipc';

const isString = (value: unknown): value is string => typeof value === 'string';
const testEnvNumber = (name: string): number | undefined => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const localApi = {
  getLocalState: () => ipcRenderer.invoke(IpcChannels.localState) as Promise<LocalStatePublic>,
  onLocalState: (callback: (state: LocalStatePublic) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!value || typeof value !== 'object') return;
      callback(value as LocalStatePublic);
    };
    ipcRenderer.on(IpcChannels.localUpdate, listener);
    return () => ipcRenderer.removeListener(IpcChannels.localUpdate, listener);
  },
  localPickWorkspace: () =>
    ipcRenderer.invoke(IpcChannels.localWorkspacePick) as Promise<LocalResult<string | null>>,
  localAddWorkspace: (path: string) =>
    ipcRenderer.invoke(IpcChannels.localWorkspaceAdd, { path }) as Promise<LocalResult<string>>,
  localRemoveWorkspace: (path: string) =>
    ipcRenderer.invoke(IpcChannels.localWorkspaceRemove, { path }) as Promise<LocalResult<null>>,
  localNewSession: (workspace: string) =>
    ipcRenderer.invoke(IpcChannels.localSessionNew, { workspace }) as Promise<LocalResult<string>>,
  localListSessions: (workspace: string) =>
    ipcRenderer.invoke(IpcChannels.localSessionList, { workspace }) as Promise<
      LocalResult<LocalSessionSummary[]>
    >,
  localLoadSession: (workspace: string, sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.localSessionLoad, { workspace, sessionId }) as Promise<
      LocalResult<null>
    >,
  localSessionDelete: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.localSessionDelete, { sessionId }) as Promise<LocalResult<null>>,
  localSessionDeleteAll: (workspace: string) =>
    ipcRenderer.invoke(IpcChannels.localSessionDeleteAll, { workspace }) as Promise<
      LocalResult<{ deleted: number }>
    >,
  localPrompt: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IpcChannels.localPrompt, { sessionId, text }) as Promise<LocalResult<string>>,
  localCancel: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.localCancel, { sessionId }) as Promise<LocalResult<null>>,
  localPermission: (sessionId: string, requestId: string, optionId: string) =>
    ipcRenderer.invoke(IpcChannels.localPermission, { sessionId, requestId, optionId }) as Promise<
      LocalResult<null>
    >,
  localOpenLink: (url: string) => {
    if (isString(url) && url.length < 8192) ipcRenderer.send(IpcChannels.localOpenLink, { url });
  },
  localActiveSession: (sessionId: string | null) => {
    if (sessionId === null || isString(sessionId)) {
      ipcRenderer.send(IpcChannels.localActiveSession, { sessionId });
    }
  },
};

// Claude chat (Agent SDK host in main). Same shapes as the local* methods.
const claudeChatApi = {
  getClaudeChatState: () =>
    ipcRenderer.invoke(IpcChannels.claudeChatState) as Promise<ClaudeChatStatePublic>,
  onClaudeChatState: (callback: (state: ClaudeChatStatePublic) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!value || typeof value !== 'object') return;
      callback(value as ClaudeChatStatePublic);
    };
    ipcRenderer.on(IpcChannels.claudeChatUpdate, listener);
    return () => ipcRenderer.removeListener(IpcChannels.claudeChatUpdate, listener);
  },
  claudeNewSession: (cwd: string | null) =>
    ipcRenderer.invoke(IpcChannels.claudeNewSession, { cwd }) as Promise<LocalResult<string>>,
  claudePrompt: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IpcChannels.claudePrompt, { sessionId, text }) as Promise<LocalResult<null>>,
  claudeCancel: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.claudeCancel, { sessionId }) as Promise<LocalResult<null>>,
  claudePermission: (sessionId: string, requestId: string, optionId: string) =>
    ipcRenderer.invoke(IpcChannels.claudePermission, { sessionId, requestId, optionId }) as Promise<
      LocalResult<null>
    >,
  claudeSetPermissionMode: (sessionId: string, mode: ClaudePermissionMode) =>
    ipcRenderer.invoke(IpcChannels.claudeSetPermissionMode, { sessionId, mode }) as Promise<
      LocalResult<null>
    >,
  claudeSetModel: (sessionId: string, model: string | null) =>
    ipcRenderer.invoke(IpcChannels.claudeSetModel, { sessionId, model }) as Promise<
      LocalResult<null>
    >,
  claudeLoadHistory: (sessionId: string) =>
    ipcRenderer.invoke(IpcChannels.claudeLoadHistory, { sessionId }) as Promise<LocalResult<null>>,
};

// P4b embedded terminal + F5 dock.
const terminalApi = {
  terminalOpen: (
    options:
      | { kind: 'devin'; workspace: string; sessionId: string }
      | { kind: 'shell'; cwd?: string; profile?: string },
  ) =>
    ipcRenderer.invoke(IpcChannels.terminalOpen, options) as Promise<
      { ok: true; id: string } | { ok: false; error: string }
    >,
  terminalList: () => ipcRenderer.invoke(IpcChannels.terminalList) as Promise<TerminalSummary[]>,
  terminalCwdOptions: () =>
    ipcRenderer.invoke(IpcChannels.terminalCwdOptions) as Promise<string[]>,
  terminalProfiles: () =>
    ipcRenderer.invoke(IpcChannels.terminalProfiles) as Promise<
      { guid: string; name: string; default: boolean; available: boolean }[]
    >,
  terminalToggle: () => ipcRenderer.send(IpcChannels.terminalToggle),
  terminalActivate: (id: string) => {
    if (isString(id)) ipcRenderer.send(IpcChannels.terminalActivate, { id });
  },
  terminalTitle: (id: string, title: string) => {
    if (isString(id) && isString(title)) {
      ipcRenderer.send(IpcChannels.terminalTitle, { id, title: title.slice(0, 256) });
    }
  },
  terminalInput: (id: string, data: string) => {
    if (isString(id) && isString(data) && data.length <= 65536) {
      ipcRenderer.send(IpcChannels.terminalInput, { id, data });
    }
  },
  terminalResize: (id: string, cols: number, rows: number) => {
    if (isString(id) && Number.isInteger(cols) && Number.isInteger(rows)) {
      ipcRenderer.send(IpcChannels.terminalResize, { id, cols, rows });
    }
  },
  terminalClose: (id: string) => {
    if (isString(id)) ipcRenderer.send(IpcChannels.terminalClose, { id });
  },
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === 'object') callback(payload as { id: string; data: string });
    };
    ipcRenderer.on(IpcChannels.terminalData, listener);
    return () => ipcRenderer.removeListener(IpcChannels.terminalData, listener);
  },
  onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (payload && typeof payload === 'object')
        callback(payload as { id: string; exitCode: number });
    };
    ipcRenderer.on(IpcChannels.terminalExit, listener);
    return () => ipcRenderer.removeListener(IpcChannels.terminalExit, listener);
  },
  clipboardReadText: () => ipcRenderer.invoke(IpcChannels.clipboardReadText) as Promise<string>,
  clipboardWriteText: (text: string) => {
    if (isString(text) && text.length <= 65536) {
      ipcRenderer.send(IpcChannels.clipboardWriteText, { text });
    }
  },
};

const api = {
  platform: process.platform,
  ...localApi,
  ...claudeChatApi,
  ...terminalApi,
  getState: () => ipcRenderer.invoke(IpcChannels.stateGet) as Promise<ShellState>,
  onState: (callback: (state: ShellState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!value || typeof value !== 'object') return;
      callback(value as ShellState);
    };
    ipcRenderer.on(IpcChannels.stateUpdate, listener);
    return () => ipcRenderer.removeListener(IpcChannels.stateUpdate, listener);
  },
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet) as Promise<Settings>,
  setSettings: (patch: unknown) =>
    ipcRenderer.invoke(IpcChannels.settingsSet, patch) as Promise<Settings>,
  commitSettings: (patch: unknown) =>
    ipcRenderer.invoke(IpcChannels.settingsCommit, patch) as Promise<SettingsCommitResult>,
  onSettingsFlush: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IpcChannels.settingsFlush, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.settingsFlush, listener);
    };
  },
  settingsFlushDone: (payload: { pending: boolean; ok: boolean }) => {
    if (typeof payload?.pending === 'boolean' && typeof payload?.ok === 'boolean') {
      ipcRenderer.send(IpcChannels.settingsFlushDone, payload);
    }
  },
  togglePane: () => ipcRenderer.send(IpcChannels.paneToggle),
  activateTab: (id: string) => {
    if (typeof id === 'string') ipcRenderer.send(IpcChannels.tabActivate, id);
  },
  closeTab: (id: string) => {
    if (typeof id === 'string') ipcRenderer.send(IpcChannels.tabClose, id);
  },
  reorderTab: (id: string, toIndex: number) => {
    if (typeof id === 'string' && Number.isInteger(toIndex)) {
      ipcRenderer.send(IpcChannels.tabReorder, id, toIndex);
    }
  },
  listScopes: () =>
    ipcRenderer.invoke(IpcChannels.tabsListScopes) as Promise<ScopeSummary[]>,
  closeScope: (scope: string) => {
    if (typeof scope === 'string') ipcRenderer.send(IpcChannels.tabsCloseScope, { scope });
  },
  openReloadMenu: (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      ipcRenderer.send(IpcChannels.tabsReloadMenu, { x, y });
    }
  },
  openTabMenu: (id: string, x: number, y: number) => {
    if (typeof id === 'string' && Number.isFinite(x) && Number.isFinite(y)) {
      ipcRenderer.send(IpcChannels.tabsTabMenu, { id, x, y });
    }
  },
  navigate: (action: 'back' | 'forward' | 'reload') => {
    if (action === 'back' || action === 'forward' || action === 'reload') {
      ipcRenderer.send(IpcChannels.navAction, action);
    }
  },
  setSurface: (surface: Surface) => {
    if (SurfaceSchema.safeParse(surface).success) {
      ipcRenderer.send(IpcChannels.surfaceSet, surface);
    }
  },
  openLink: (url: string) => {
    if (typeof url === 'string' && url.length < 8192) ipcRenderer.send(IpcChannels.linkOpen, url);
  },
  dragStart: (axis: 'x' | 'y' | 's', pos: number) => {
    if ((axis === 'x' || axis === 'y' || axis === 's') && Number.isFinite(pos)) {
      ipcRenderer.send(IpcChannels.layoutDragStart, { axis, pos });
    }
  },
  dragMove: (pos: number) => {
    if (Number.isFinite(pos)) ipcRenderer.send(IpcChannels.layoutDragMove, pos);
  },
  dragEnd: (pos: number) => {
    if (Number.isFinite(pos)) ipcRenderer.send(IpcChannels.layoutDragEnd, pos);
  },
  dragCancel: (reason: 'escape' | 'pointer-cancel' = 'pointer-cancel') => {
    if (reason === 'escape' || reason === 'pointer-cancel')
      ipcRenderer.send(IpcChannels.layoutDragCancel, reason);
  },
  listCredentials: () =>
    ipcRenderer.invoke(IpcChannels.credentialsList) as Promise<CredentialEntry[]>,
  saveCredential: (credential: { origin: string; username: string; password: string }) =>
    ipcRenderer.invoke(IpcChannels.credentialsSave, credential) as Promise<
      { ok: true; entry: CredentialEntry } | { ok: false; error: string }
    >,
  updateCredential: (id: string, patch: { username?: string; password?: string }) =>
    ipcRenderer.invoke(IpcChannels.credentialsUpdate, { id, ...patch }) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  deleteCredential: (id: string) =>
    ipcRenderer.invoke(IpcChannels.credentialsDelete, { id }) as Promise<boolean>,
  revealCredential: (id: string) =>
    ipcRenderer.invoke(IpcChannels.credentialsReveal, { id }) as Promise<string | null>,
  autofillPick: (id: string) => {
    if (isString(id)) ipcRenderer.send(IpcChannels.autofillPick, { id });
  },
  autofillPickerClose: () => ipcRenderer.send(IpcChannels.autofillPickerClose),
  autofillPromptResolve: (action: 'save' | 'dismiss') => {
    if (action === 'save' || action === 'dismiss') {
      ipcRenderer.send(IpcChannels.autofillPromptResolve, { action });
    }
  },
  onDragReset: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IpcChannels.layoutDragReset, listener);
    return () => ipcRenderer.removeListener(IpcChannels.layoutDragReset, listener);
  },
  // P5: the token only travels renderer -> main; main never echoes it back.
  hasPat: () => ipcRenderer.invoke(IpcChannels.secretsHasPat) as Promise<boolean>,
  setPat: (pat: string) =>
    ipcRenderer.invoke(IpcChannels.secretsSetPat, { pat }) as Promise<SecretResult>,
  clearPat: () => ipcRenderer.invoke(IpcChannels.secretsClearPat) as Promise<SecretResult>,
  listPrs: () => ipcRenderer.invoke(IpcChannels.prsList) as Promise<SessionPr[]>,
  prsMarkRead: (url: string) => ipcRenderer.send(IpcChannels.prsMarkRead, { url }),
  prsMarkAllRead: () => ipcRenderer.send(IpcChannels.prsMarkAllRead),
  prsRemove: (url: string) => ipcRenderer.send(IpcChannels.prsRemove, { url }),
  prsClear: () => ipcRenderer.send(IpcChannels.prsClear),
  prsOpen: (sessionId: string, url: string) =>
    ipcRenderer.send(IpcChannels.prsOpen, { sessionId, url }),
  prsPanel: (open: boolean) => ipcRenderer.send(IpcChannels.prsPanel, { open }),
  // P6 notification center
  notificationsList: () =>
    ipcRenderer.invoke(IpcChannels.notificationsList) as Promise<AppNotification[]>,
  notificationsMarkRead: (id: string) => ipcRenderer.send(IpcChannels.notificationsMarkRead, { id }),
  notificationsMarkAllRead: () => ipcRenderer.send(IpcChannels.notificationsMarkAllRead),
  notificationsRemove: (id: string) => ipcRenderer.send(IpcChannels.notificationsRemove, { id }),
  notificationsClear: () => ipcRenderer.send(IpcChannels.notificationsClear),
  notificationsOpen: (id: string) => ipcRenderer.send(IpcChannels.notificationsOpen, { id }),
  notificationsPanel: (open: boolean) => ipcRenderer.send(IpcChannels.notificationsPanel, { open }),
  // Service-user identity: source + masked id only, never the raw user id.
  identity: () => ipcRenderer.invoke(IpcChannels.notificationsIdentity) as Promise<IdentityInfo>,
  identityReset: () => ipcRenderer.send(IpcChannels.notificationsIdentityReset),
  updateInstall: () => ipcRenderer.send(IpcChannels.updateInstall),
  // Cloud session sidebar.
  cloudOpen: (sessionId: string) => {
    if (isString(sessionId) && sessionId.length <= 128) {
      ipcRenderer.send(IpcChannels.cloudOpen, { sessionId });
    }
  },
  cloudRefresh: () => ipcRenderer.send(IpcChannels.cloudRefresh),
  cloudLoadMore: (folder: string) => {
    if (isString(folder) && folder.length >= 1 && folder.length <= 256) {
      ipcRenderer.send(IpcChannels.cloudLoadMore, { folder });
    }
  },
  cloudPanel: (open: boolean) => ipcRenderer.send(IpcChannels.cloudPanel, { open }),
  cloudPrefetch: (sessionId: string) => {
    if (isString(sessionId) && sessionId.length <= 128) {
      ipcRenderer.send(IpcChannels.cloudPrefetch, { sessionId });
    }
  },
  // Cloud sidebar mutations + native context menus.
  cloudFolderCreate: (name: string) => {
    const trimmed = name.trim();
    if (trimmed.length >= 1 && trimmed.length <= 100) {
      ipcRenderer.send(IpcChannels.cloudFolderCreate, { name: trimmed });
    }
  },
  cloudFolderRename: (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (isString(oldName) && trimmed.length >= 1 && trimmed.length <= 100) {
      ipcRenderer.send(IpcChannels.cloudFolderRename, { oldName, newName: trimmed });
    }
  },
  cloudFolderDelete: (name: string) => {
    if (isString(name)) ipcRenderer.send(IpcChannels.cloudFolderDelete, { name });
  },
  cloudFolderReorder: (names: string[]) => {
    if (Array.isArray(names)) ipcRenderer.send(IpcChannels.cloudFolderReorder, { names });
  },
  cloudSessionMove: (sessionId: string, folder: string | null) => {
    if (isString(sessionId) && sessionId.length <= 128) {
      ipcRenderer.send(IpcChannels.cloudSessionMove, { sessionId, folder });
    }
  },
  cloudSessionArchive: (sessionId: string, archive: boolean) => {
    if (isString(sessionId) && sessionId.length <= 128) {
      ipcRenderer.send(IpcChannels.cloudSessionArchive, { sessionId, archive });
    }
  },
  cloudCopyLink: (sessionId: string) => {
    if (isString(sessionId) && sessionId.length <= 128) {
      ipcRenderer.send(IpcChannels.cloudCopyLink, { sessionId });
    }
  },
  cloudContextMenu: (request: {
    kind: 'session' | 'folder' | 'header';
    sessionId?: string;
    name?: string;
    x: number;
    y: number;
  }) =>
    ipcRenderer.invoke(IpcChannels.cloudContextMenu, request) as Promise<{
      action: 'rename' | 'new-folder' | null;
    }>,
  cloudShowArchived: (value: boolean) =>
    ipcRenderer.send(IpcChannels.cloudShowArchived, { value }),
  cloudNewSession: (folder: string | null) => {
    if (folder === null) {
      ipcRenderer.send(IpcChannels.cloudNewSession, { folder: null });
      return;
    }
    const trimmed = folder.trim();
    if (trimmed.length >= 1 && trimmed.length <= 100) {
      ipcRenderer.send(IpcChannels.cloudNewSession, { folder: trimmed });
    }
  },
  // Claude session sidebar. Handlers land in PR 3; invoke/send of an
  // unregistered channel is harmless until then.
  claudeOpen: (sessionId: string) => {
    if (isString(sessionId)) ipcRenderer.send(IpcChannels.claudeOpen, { sessionId });
  },
  claudeRefresh: () => ipcRenderer.send(IpcChannels.claudeRefresh),
  claudeRename: (sessionId: string, title: string) => {
    const trimmed = title.trim();
    if (isString(sessionId) && trimmed.length >= 1 && trimmed.length <= 200) {
      ipcRenderer.send(IpcChannels.claudeRename, { sessionId, title: trimmed });
    }
  },
  claudeFork: (sessionId: string) => {
    if (isString(sessionId)) ipcRenderer.send(IpcChannels.claudeFork, { sessionId });
  },
  claudeSessionMove: (sessionId: string, folder: string | null) => {
    if (isString(sessionId)) ipcRenderer.send(IpcChannels.claudeSessionMove, { sessionId, folder });
  },
  claudeSessionPin: (sessionId: string, pinned: boolean) => {
    if (isString(sessionId)) ipcRenderer.send(IpcChannels.claudeSessionPin, { sessionId, pinned });
  },
  claudeSessionArchive: (sessionId: string, archive: boolean) => {
    if (isString(sessionId)) {
      ipcRenderer.send(IpcChannels.claudeSessionArchive, { sessionId, archive });
    }
  },
  claudeSessionRemove: (sessionId: string) => {
    if (isString(sessionId)) ipcRenderer.send(IpcChannels.claudeSessionRemove, { sessionId });
  },
  claudeSessionDeleteTranscript: (sessionId: string) => {
    if (isString(sessionId)) {
      ipcRenderer.send(IpcChannels.claudeSessionDeleteTranscript, { sessionId });
    }
  },
  claudeRevealTranscript: (sessionId: string) => {
    if (isString(sessionId)) ipcRenderer.send(IpcChannels.claudeRevealTranscript, { sessionId });
  },
  claudeFolderCreate: (name: string) => {
    const trimmed = name.trim();
    if (trimmed.length >= 1 && trimmed.length <= 100) {
      ipcRenderer.send(IpcChannels.claudeFolderCreate, { name: trimmed });
    }
  },
  claudeFolderRename: (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (isString(oldName) && trimmed.length >= 1 && trimmed.length <= 100) {
      ipcRenderer.send(IpcChannels.claudeFolderRename, { oldName, newName: trimmed });
    }
  },
  claudeFolderDelete: (name: string) => {
    if (isString(name)) ipcRenderer.send(IpcChannels.claudeFolderDelete, { name });
  },
  claudeFolderReorder: (names: string[]) => {
    if (Array.isArray(names)) ipcRenderer.send(IpcChannels.claudeFolderReorder, { names });
  },
  claudeShowArchived: (value: boolean) =>
    ipcRenderer.send(IpcChannels.claudeShowArchived, { value }),
  claudeContextMenu: (request: {
    kind: 'session' | 'folder' | 'header';
    sessionId?: string;
    name?: string;
    x: number;
    y: number;
  }) =>
    ipcRenderer.invoke(IpcChannels.claudeContextMenu, request) as Promise<{
      action: 'rename' | 'rename-session' | 'new-folder' | null;
    }>,
  // Taskbar badge: main asks the shell to render, replies get {count,size}.
  onBadgeRender: (callback: (request: BadgeRender) => void) => {
    const listener = (_event: unknown, request: BadgeRender) => callback(request);
    ipcRenderer.on(IpcChannels.badgeRender, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.badgeRender, listener);
    };
  },
  badgeRendered: (dataUrl: string | null) =>
    ipcRenderer.invoke(IpcChannels.badgeRendered, { dataUrl }) as Promise<{
      count: number;
      size: number;
    }>,
  updateCheck: (source: 'settings' | 'manual') =>
    ipcRenderer.send(IpcChannels.updateCheck, { source }),
  releaseNotes: () =>
    ipcRenderer.invoke(IpcChannels.updateReleaseNotes) as Promise<ReleaseNotesReply>,
  // DEVIN_WORKSPACES_TEST_BANNER_MS shortens the banner auto-hide in tests.
  bannerMs: testEnvNumber('DEVIN_WORKSPACES_TEST_BANNER_MS'),
  onNotificationBanner: (callback: (entry: AppNotification) => void) => {
    const listener = (_event: unknown, entry: AppNotification) => callback(entry);
    ipcRenderer.on(IpcChannels.notificationBanner, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.notificationBanner, listener);
    };
  },
  // Test mode only: dispatch into the main-process __devinworkspaces hooks.
  // The channel exists only when test hooks are registered.
  testHook: (name: string, ...args: unknown[]) =>
    ipcRenderer.invoke('test:hook', name, args),
};

export type SecretResult = { ok: true } | { ok: false; error: string };

contextBridge.exposeInMainWorld('devinworkspaces', api);

export type DevinWorkspacesApi = typeof api;
