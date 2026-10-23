import { clipboard, Menu } from 'electron';
import { guardedHandle, guardedOn } from './ipcGuard';
import { openFolderDialog } from './dialogs';
import { clampFraction01 } from '../core/layout';
import { closeAutofillOverlays } from './autofill';
import {
  CredentialDeleteSchema,
  CredentialRevealSchema,
  CredentialSaveSchema,
  CredentialUpdateSchema,
  CloudLoadMoreArg,
  CloudOpenArg,
  CloudPanelArg,
  CloudPrefetchArg,
  DragCancelReasonArg,
  DragPosArg,
  DragStartArg,
  IpcChannels,
  LinkOpenArg,
  NavActionArg,
  SettingsFlushDoneArg,
  SettingsPatchSchema,
  SettingsSchema,
  OpenHandsApiKeySetArg,
  SetPatArg,
  SurfaceArg,
  TabIdArg,
  TabReorderArgs,
  TabsCloseScopeArg,
  TabsReloadMenuArg,
  TabsTabMenuArg,
  type Settings,
  type SettingsCommitResult,
  type SettingsPatch,
} from '../shared/ipc';
import { fieldErrorsFromIssues } from '../core/settingsDraft';
import { sanitizeMessage } from '../core/devinApi';
import { analyticsUrl } from '../core/sessions';
import { refreshAnalyticsView } from './analytics';
import { devinUsage } from './devinUsage';
import { settingsFlushDone } from './settingsFlush';
import { identityResolver } from './identity';
import { log } from './log';
import { badgeIconSize, notificationStore } from './notifications';
import { notifier, openNotification, openPr, openPrs } from './notifier';
import { prStore } from './prs';
import { handleLink } from './routing';
import { checkForUpdatesNow, hasDownloadedUpdate, installUpdate, releaseNotesReply } from './updater';
import { historyAction, navigationTarget } from './shortcuts';
import { BadgeRenderedSchema, CloudContextMenuArg, CloudCopyLinkArg, CloudFolderCreateArg, CloudFolderDeleteArg, CloudFolderRenameArg, CloudFolderReorderArg, CloudNewSessionArg, CloudSessionArchiveArg, CloudSessionMoveArg, CloudShowArchivedArg, DialogPickFolderArg, SessionReorderArg, NotificationIdArg, NotificationPanelArg, PrOpenArg, PrPanelArg, PrUrlArg, UpdateCheckArg } from '../shared/ipc';
import { state } from './state';
import { keepAliveMs } from './tabs';
import { cloudSessions } from './cloudSessions';
import { runtimeFor, runtimes } from './providers';
import { cloudViews } from './cloudViews';
import {
  applyLayout,
  beginDrag,
  cancelDrag,
  endDrag,
  moveDrag,
  notifyShell,
  publicState,
  setNotificationsPanel,
  setPrsPanel,
  setPaneOpen,
  setSessionsOpen,
} from './window';

// "Reload all tabs in this session" (strip menu + test hook).
export function reloadCurrentScope(): number {
  return state.tabManager?.reloadScope() ?? 0;
}

// "Copy address" (tab context menu + test hook). Returns false when the tab is gone.
export function copyTabAddress(tabId: string): boolean {
  const tab = state.tabManager?.getTab(tabId);
  if (!tab) return false;
  clipboard.writeText(tab.url);
  log('shell', 'tab-copy-address', { detail: { id: tabId }, url: tab.url });
  return true;
}

export function applySettingsPatch(patch: SettingsPatch): Settings {
  const previousTenant = state.settings!.current.tenantUrl;
  const previousSettings = state.settings!.current;
  const next: Settings = state.settings!.merge(patch);
  for (const runtime of runtimes()) runtime.onSettingsChanged?.(previousSettings, next);
  // Stays named to keep today's order: after the Claude fan-out.
  devinUsage().onSettingsChanged(previousSettings, next);
  if (next.pane.open !== state.paneOpen) setPaneOpen(next.pane.open, 'settings');
  // Skip layout churn on the quit-flush path — it sits inside the settings
  // commit round trip and must stay cheap.
  if (!state.shuttingDown && next.sessions.open !== state.sessionsOpen)
    setSessionsOpen(next.sessions.open, 'settings');
  state.sessionsWidth = next.sessions.width;
  // Raw 0..1 preference; the px guards are applied when laying out.
  state.paneFraction = clampFraction01(next.pane.fraction);
  state.surface = next.surface;
  state.tabManager?.setKeepAliveMs(keepAliveMs(next.tabs.keepAliveHours));
  state.tabManager?.setMaxLiveTabs(next.tabs.maxLiveTabs);
  cloudViews().applyLimits(); // sessions.maxLiveViews / keepAliveHours
  if (next.tenantUrl !== previousTenant) {
    state.tenantUrl = next.tenantUrl;
    log('shell', 'tenant-changed', { url: next.tenantUrl });
    cloudViews().reset(next.tenantUrl);
    const analytics = analyticsUrl(next.tenantUrl);
    state.analyticsView?.webContents.loadURL(analytics).catch((error: unknown) => {
      log('analytics', 'load-error', { url: analytics, detail: { message: String(error) } });
    });
  }
  applyLayout();
  return next;
}

export function setupIpc(): void {
  guardedHandle(IpcChannels.stateGet, () => publicState());
  guardedHandle(IpcChannels.analyticsRefresh, () => {
    refreshAnalyticsView();
    return null;
  });
  guardedOn(IpcChannels.devinUsageRefresh, () => {
    void devinUsage().refresh();
  });
  guardedHandle(IpcChannels.settingsGet, () => state.settings?.current ?? SettingsSchema.parse({}));
  guardedHandle(IpcChannels.settingsSet, (_event, patch: unknown) => {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success || !state.settings) return state.settings?.current;
    return applySettingsPatch(parsed.data);
  });
  // Implicit-save path: same patch shape as settings:set, but reports
  // field-level validation errors and persist failures back to the draft UI.
  guardedHandle(IpcChannels.settingsCommit, (_event, patch: unknown): SettingsCommitResult => {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success) {
      const { errors, other } = fieldErrorsFromIssues(parsed.error.issues);
      log('shell', 'settings-commit', {
        detail: { ok: false, fields: 0, errorFields: Object.keys(errors), persistError: false },
      });
      return { ok: false, errors, message: other.length > 0 ? other.join('; ') : null };
    }
    if (!state.settings) return { ok: false, errors: {}, message: 'Settings unavailable' };
    try {
      const next = applySettingsPatch(parsed.data);
      log('shell', 'settings-commit', {
        detail: { ok: true, fields: Object.keys(parsed.data).length, errorFields: [], persistError: false },
      });
      return { ok: true, settings: next };
    } catch (error) {
      log('shell', 'settings-commit', {
        detail: { ok: false, fields: Object.keys(parsed.data).length, errorFields: [], persistError: true },
      });
      return {
        ok: false,
        errors: {},
        message: sanitizeMessage(String(error), state.secrets?.getPat() ?? ''),
      };
    }
  });
  guardedOn(IpcChannels.settingsFlushDone, (_event, payload: unknown) => {
    const parsed = SettingsFlushDoneArg.safeParse(payload);
    if (parsed.success) settingsFlushDone(parsed.data);
  });
  guardedOn(IpcChannels.paneToggle, () => {
    setPaneOpen(!state.paneOpen, 'rail');
  });
  guardedOn(IpcChannels.tabActivate, (_event, id: unknown) => {
    const parsed = TabIdArg.safeParse(id);
    if (!parsed.success) return;
    state.tabManager?.activate(parsed.data);
    applyLayout();
  });
  guardedOn(IpcChannels.tabClose, (_event, id: unknown) => {
    const parsed = TabIdArg.safeParse(id);
    if (!parsed.success) return;
    void state.tabManager?.close(parsed.data).then(applyLayout);
  });
  guardedOn(IpcChannels.tabReorder, (...args: unknown[]) => {
    const parsed = TabReorderArgs.safeParse(args.slice(1));
    if (!parsed.success) return;
    state.tabManager?.reorder(parsed.data[0], parsed.data[1]);
    // notifyShell is called via applyLayout in the spike; keep onChange-driven persistence
    applyLayout();
  });
  // P8: close every tab in a scope (used by the strip overflow menu and the
  // notifier's archived-session sweep).
  guardedOn(IpcChannels.tabsCloseScope, (_event, payload: unknown) => {
    const parsed = TabsCloseScopeArg.safeParse(payload);
    if (!parsed.success) return;
    void state.tabManager?.closeScope(parsed.data.scope).then(applyLayout);
  });
  guardedHandle(IpcChannels.tabsListScopes, () => state.tabManager?.listScopes() ?? []);
  // Native menus: hosted views paint over the shell, so these can't be DOM.
  guardedOn(IpcChannels.tabsReloadMenu, (_event, payload: unknown) => {
    const parsed = TabsReloadMenuArg.safeParse(payload);
    if (!parsed.success || !state.windowRef) return;
    Menu.buildFromTemplate([
      { label: 'Reload all tabs in this session', click: () => reloadCurrentScope() },
    ]).popup({
      window: state.windowRef,
      x: Math.round(parsed.data.x),
      y: Math.round(parsed.data.y),
    });
  });
  guardedOn(IpcChannels.tabsTabMenu, (_event, payload: unknown) => {
    const parsed = TabsTabMenuArg.safeParse(payload);
    if (!parsed.success || !state.windowRef) return;
    if (!state.tabManager?.getTab(parsed.data.id)) return;
    Menu.buildFromTemplate([
      { label: 'Copy address', click: () => copyTabAddress(parsed.data.id) },
    ]).popup({
      window: state.windowRef,
      x: Math.round(parsed.data.x),
      y: Math.round(parsed.data.y),
    });
  });
  guardedOn(IpcChannels.navAction, (_event, action: unknown) => {
    const parsed = NavActionArg.safeParse(action);
    if (!parsed.success) return;
    const contents = navigationTarget();
    if (contents) historyAction(parsed.data, contents);
  });
  guardedOn(IpcChannels.surfaceSet, (_event, next: unknown) => {
    const parsed = SurfaceArg.safeParse(next);
    if (!parsed.success) return;
    const previous = state.surface;
    state.surface = parsed.data;
    if (parsed.data === 'analytics' && previous !== 'analytics') refreshAnalyticsView();
    setNotificationsPanel(false);
    setPrsPanel(false);
    closeAutofillOverlays();
    log('shell', 'surface-set', { detail: { surface: state.surface } });
    applyLayout();
  });
  guardedOn(IpcChannels.linkOpen, (_event, url: unknown) => {
    const parsed = LinkOpenArg.safeParse(url);
    if (parsed.success) handleLink(parsed.data);
  });
  guardedOn(IpcChannels.layoutDragStart, (_event, payload: unknown) => {
    const parsed = DragStartArg.safeParse(payload);
    if (parsed.success) beginDrag(parsed.data.axis, parsed.data.pos);
  });
  guardedOn(IpcChannels.layoutDragMove, (_event, pos: unknown) => {
    const parsed = DragPosArg.safeParse(pos);
    if (parsed.success) moveDrag(parsed.data);
  });
  guardedOn(IpcChannels.layoutDragEnd, (_event, pos: unknown) => {
    const parsed = DragPosArg.safeParse(pos);
    if (parsed.success) endDrag(parsed.data);
  });
  guardedOn(IpcChannels.layoutDragCancel, (_event, reason: unknown) => {
    const parsed = DragCancelReasonArg.safeParse(reason);
    cancelDrag(true, parsed.success ? parsed.data : 'pointer-cancel');
  });
  // Cloud session sidebar.
  guardedOn(IpcChannels.cloudOpen, (_event, payload: unknown) => {
    const parsed = CloudOpenArg.safeParse(payload);
    if (parsed.success) cloudSessions().openSession(parsed.data.sessionId);
  });
  guardedOn(IpcChannels.cloudRefresh, () => cloudSessions().refresh('shell'));
  guardedOn(IpcChannels.cloudLoadMore, (_event, payload: unknown) => {
    const parsed = CloudLoadMoreArg.safeParse(payload);
    if (parsed.success) cloudSessions().loadMore(parsed.data.folder);
  });
  guardedOn(IpcChannels.cloudPanel, (_event, payload: unknown) => {
    const parsed = CloudPanelArg.safeParse(payload);
    if (parsed.success) setSessionsOpen(parsed.data.open, 'rail');
  });
  guardedOn(IpcChannels.cloudPrefetch, (_event, payload: unknown) => {
    const parsed = CloudPrefetchArg.safeParse(payload);
    if (parsed.success) cloudSessions().prefetchSession(parsed.data.sessionId);
  });
  // Cloud sidebar mutations — REST ops live in cloudSessions; log ids/names
  // nowhere (handlers stay zod-safeParse + void).
  guardedOn(IpcChannels.cloudFolderCreate, (_event, payload: unknown) => {
    const parsed = CloudFolderCreateArg.safeParse(payload);
    if (parsed.success) void cloudSessions().folderCreate(parsed.data.name);
  });
  guardedOn(IpcChannels.cloudFolderRename, (_event, payload: unknown) => {
    const parsed = CloudFolderRenameArg.safeParse(payload);
    if (parsed.success) void cloudSessions().folderRename(parsed.data.oldName, parsed.data.newName);
  });
  guardedOn(IpcChannels.cloudFolderDelete, (_event, payload: unknown) => {
    const parsed = CloudFolderDeleteArg.safeParse(payload);
    if (parsed.success)
      void cloudSessions()
        .folderDelete(parsed.data.name)
        .then(() => {
          const order = { ...(state.settings?.current.sessions.sessionOrder ?? {}) };
          if (!(parsed.data.name in order)) return;
          delete order[parsed.data.name];
          state.settings?.merge({ sessions: { sessionOrder: order } });
        })
        .catch(() => undefined);
  });
  guardedOn(IpcChannels.cloudFolderReorder, (_event, payload: unknown) => {
    const parsed = CloudFolderReorderArg.safeParse(payload);
    if (parsed.success) void cloudSessions().folderReorder(parsed.data.names);
  });
  guardedOn(IpcChannels.cloudSessionReorder, (_event, payload: unknown) => {
    const parsed = SessionReorderArg.safeParse(payload);
    if (!parsed.success) return;
    const { section, ids } = parsed.data;
    const current = state.settings?.current.sessions.sessionOrder ?? {};
    state.settings?.merge({
      sessions: { sessionOrder: { ...current, [section]: ids } },
    });
    const kind =
      section === 'pinned' || section === 'recent' || section === 'participated'
        ? section
        : 'folder';
    log('cloud', 'cloud-session-reorder', {
      detail: { section: kind, count: ids.length },
    });
  });
  guardedHandle(IpcChannels.dialogPickFolder, async (_event, payload: unknown) => {
    const parsed = DialogPickFolderArg.safeParse(payload);
    if (!parsed.success || !state.windowRef) return null;
    const result = await openFolderDialog(state.windowRef, {
      title: parsed.data.title,
      properties: ['openDirectory', 'createDirectory'],
      ...(parsed.data.defaultPath ? { defaultPath: parsed.data.defaultPath } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  guardedOn(IpcChannels.cloudSessionMove, (_event, payload: unknown) => {
    const parsed = CloudSessionMoveArg.safeParse(payload);
    if (parsed.success) void cloudSessions().sessionMove(parsed.data.sessionId, parsed.data.folder);
  });
  guardedOn(IpcChannels.cloudSessionArchive, (_event, payload: unknown) => {
    const parsed = CloudSessionArchiveArg.safeParse(payload);
    if (parsed.success) void cloudSessions().sessionArchive(parsed.data.sessionId, parsed.data.archive);
  });
  guardedOn(IpcChannels.cloudCopyLink, (_event, payload: unknown) => {
    const parsed = CloudCopyLinkArg.safeParse(payload);
    if (parsed.success) cloudSessions().copyLink(parsed.data.sessionId);
  });
  guardedHandle(IpcChannels.cloudContextMenu, (_event, payload: unknown) => {
    const parsed = CloudContextMenuArg.safeParse(payload);
    if (!parsed.success) return { action: null };
    return cloudSessions().contextMenu(parsed.data);
  });
  guardedOn(IpcChannels.cloudShowArchived, (_event, payload: unknown) => {
    const parsed = CloudShowArchivedArg.safeParse(payload);
    if (parsed.success) cloudSessions().setShowArchived(parsed.data.value);
  });
  guardedOn(IpcChannels.cloudNewSession, (_event, payload: unknown) => {
    const parsed = CloudNewSessionArg.safeParse(payload);
    if (parsed.success) cloudSessions().newSession(parsed.data.folder);
  });
  // Credentials: never log IPC payloads (they may carry secrets).
  guardedHandle(IpcChannels.credentialsList, () => state.credentials?.list() ?? []);
  guardedHandle(IpcChannels.credentialsSave, async (_event, payload: unknown) => {
    const parsed = CredentialSaveSchema.safeParse(payload);
    if (!parsed.success || !state.credentials) {
      return { ok: false, error: 'invalid payload' };
    }
    try {
      const entry = await state.credentials.add(parsed.data);
      notifyShell();
      return { ok: true, entry };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  guardedHandle(IpcChannels.credentialsUpdate, async (_event, payload: unknown) => {
    const parsed = CredentialUpdateSchema.safeParse(payload);
    if (!parsed.success || !state.credentials) {
      return { ok: false, error: 'invalid payload' };
    }
    try {
      const { id, ...patch } = parsed.data;
      const entry = await state.credentials.update(id, patch);
      if (!entry) return { ok: false, error: 'Unknown credential' };
      notifyShell();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  guardedHandle(IpcChannels.credentialsDelete, (_event, payload: unknown) => {
    const parsed = CredentialDeleteSchema.safeParse(payload);
    if (!parsed.success || !state.credentials) return false;
    const removed = state.credentials.delete(parsed.data.id);
    if (removed) notifyShell();
    return removed;
  });
  // Never log the returned plaintext.
  guardedHandle(IpcChannels.credentialsReveal, async (_event, payload: unknown) => {
    const parsed = CredentialRevealSchema.safeParse(payload);
    if (!parsed.success || !state.credentials) return null;
    return state.credentials.reveal(parsed.data.id);
  });
  setupExtrasIpc();
}

// P5: secrets, PR quick-open and notifications. Handlers never return or log
// the token; setPat resolves to { ok, error? } so the renderer can show status.
function setupExtrasIpc(): void {
  guardedHandle(IpcChannels.secretsHasPat, () => state.secrets?.hasPat() ?? false);
  guardedHandle(IpcChannels.secretsSetPat, async (_event, arg: unknown) => {
    const parsed = SetPatArg.safeParse(arg);
    if (!parsed.success) return { ok: false, error: 'Token must be at least 10 characters.' };
    if (!state.secrets) return { ok: false, error: 'Secret store unavailable.' };
    try {
      await state.secrets.setPat(parsed.data.pat.trim());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not store token.' };
    }
    notifier.restart('pat-set');
    return { ok: true };
  });
  guardedHandle(IpcChannels.secretsClearPat, async () => {
    if (!state.secrets) return { ok: false, error: 'Secret store unavailable.' };
    try {
      await state.secrets.clearPat();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not clear token.' };
    }
    notifier.restart('pat-cleared');
    return { ok: true };
  });
  // OpenHands API key: replies carry `{ ok }` only; the key is never logged
  // or echoed (SecretStore logs presence only). notifyShell refreshes
  // ShellState.openhandsApiKeySet.
  guardedHandle(IpcChannels.openhandsApiKeySet, async (_event, arg: unknown) => {
    const parsed = OpenHandsApiKeySetArg.safeParse(arg);
    if (!parsed.success || !state.secrets) return { ok: false };
    try {
      await state.secrets.setOpenHandsApiKey(parsed.data.value);
    } catch {
      return { ok: false };
    }
    runtimeFor('openhands')?.onCredentialsChanged?.();
    notifyShell();
    return { ok: true };
  });
  guardedHandle(IpcChannels.openhandsApiKeyClear, async () => {
    if (!state.secrets) return { ok: false };
    try {
      await state.secrets.setOpenHandsApiKey(null);
    } catch {
      return { ok: false };
    }
    runtimeFor('openhands')?.onCredentialsChanged?.();
    notifyShell();
    return { ok: true };
  });
  guardedHandle(IpcChannels.prsList, () => openPrs());
  guardedOn(IpcChannels.prsMarkRead, (_e, arg: unknown) => {
    const parsed = PrUrlArg.safeParse(arg);
    if (parsed.success) prStore().markRead(parsed.data.url);
  });
  guardedOn(IpcChannels.prsMarkAllRead, () => prStore().markAllRead());
  guardedOn(IpcChannels.prsRemove, (_e, arg: unknown) => {
    const parsed = PrUrlArg.safeParse(arg);
    if (parsed.success) prStore().dismiss(parsed.data.url);
  });
  guardedOn(IpcChannels.prsClear, () => prStore().dismissAll());
  guardedOn(IpcChannels.prsOpen, (_e, arg: unknown) => {
    const parsed = PrOpenArg.safeParse(arg);
    if (parsed.success) openPr(parsed.data.sessionId, parsed.data.url);
  });
  guardedOn(IpcChannels.prsPanel, (_e, arg: unknown) => {
    const parsed = PrPanelArg.safeParse(arg);
    if (parsed.success) setPrsPanel(parsed.data.open);
  });
  // P6 notification center
  guardedHandle(IpcChannels.notificationsList, () => notificationStore().entries());
  guardedOn(IpcChannels.notificationsMarkRead, (_e, arg: unknown) => {
    const parsed = NotificationIdArg.safeParse(arg);
    if (parsed.success) notificationStore().markRead(parsed.data.id);
  });
  guardedOn(IpcChannels.notificationsMarkAllRead, () => notificationStore().markAllRead());
  guardedOn(IpcChannels.notificationsRemove, (_e, arg: unknown) => {
    const parsed = NotificationIdArg.safeParse(arg);
    if (parsed.success) notificationStore().remove(parsed.data.id);
  });
  guardedOn(IpcChannels.notificationsClear, () => notificationStore().clear());
  guardedOn(IpcChannels.notificationsOpen, (_e, arg: unknown) => {
    const parsed = NotificationIdArg.safeParse(arg);
    if (parsed.success) openNotification(parsed.data.id);
  });
  guardedOn(IpcChannels.notificationsPanel, (_e, arg: unknown) => {
    const parsed = NotificationPanelArg.safeParse(arg);
    if (parsed.success) setNotificationsPanel(parsed.data.open);
  });
  // Shell-rendered taskbar badge; the reply is the current desired spec so a
  // shell that mounted late can re-render and converge.
  guardedHandle(IpcChannels.badgeRendered, (_e, arg: unknown) => {
    const parsed = BadgeRenderedSchema.parse(arg);
    notificationStore().applyBadgeIcon(parsed.dataUrl);
    return { count: notificationStore().unread(), size: badgeIconSize() };
  });
  // Service-user identity: read the resolved source + masked id; reset clears
  // identity.json and re-runs resolution (never returns the raw user id).
  guardedHandle(IpcChannels.notificationsIdentity, () => identityResolver().current());
  guardedOn(IpcChannels.notificationsIdentityReset, () => {
    identityResolver().reset();
    notifier.restart('identity-reset');
  });
  guardedOn(IpcChannels.updateInstall, () => {
    if (hasDownloadedUpdate()) installUpdate();
  });
  guardedOn(IpcChannels.updateCheck, (_e, arg: unknown) => {
    const parsed = UpdateCheckArg.safeParse(arg);
    if (parsed.success) checkForUpdatesNow(parsed.data.source);
  });
  guardedHandle(IpcChannels.updateReleaseNotes, () => releaseNotesReply());
}
