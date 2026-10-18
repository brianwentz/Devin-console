import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeImage, screen } from 'electron';
import { z } from 'zod';
import {
  addNotification,
  clearNotifications,
  collapseSuperseded,
  markAllRead,
  markRead,
  MAX_NOTIFICATIONS,
  pruneForeign,
  removeNotification,
  unreadCount,
  type AppNotification,
  type NewNotification,
} from '../core/notificationModel';
import { IpcChannels } from '../shared/ipc';
import { log } from './log';
import { state } from './state';
import { notifyShell } from './window';

const AppNotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(['waiting', 'approval', 'blocked', 'finished', 'pr-opened', 'pr-completed', 'update', 'identity', 'auth']),
  sessionId: z.string().nullable(),
  ownerUserId: z.string().nullable().optional(),
  source: z.enum(['devin', 'claude']).optional(),
  sessionTitle: z.string(),
  prUrl: z.string().optional(),
  prState: z.string().optional(),
  version: z.string().optional(),
  title: z.string(),
  body: z.string(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
});

const SAVE_DEBOUNCE_MS = 300;

// 'update'/'identity'/'auth' entries are runtime-only — never persisted.
const RUNTIME_ONLY = new Set<AppNotification['kind']>(['update', 'identity', 'auth']);

// In-app notification center state: persisted history (minus 'update' entries,
// which are runtime-only), the taskbar overlay count, and the title-bar banner
// push. The panel itself is DOM in the shell; main only tracks open/closed so
// the z-order raise survives relayout.
export class NotificationStore {
  private list: AppNotification[] = [];
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(userData: string) {
    this.file = join(userData, 'notifications.json');
    try {
      const parsed = AppNotificationSchema.array().safeParse(
        JSON.parse(readFileSync(this.file, 'utf8')),
      );
      this.list = parsed.success ? collapseSuperseded(parsed.data).slice(0, MAX_NOTIFICATIONS) : [];
    } catch {
      this.list = [];
    }
  }

  entries(): AppNotification[] {
    return this.list;
  }

  add(next: NewNotification): AppNotification {
    const id = randomUUID();
    const before = this.list;
    this.list = addNotification(before, next, id);
    // Supersession always prepends the new entry — find it by its fresh id.
    const entry = this.list.find((item) => item.id === id)!;
    const removed = Math.max(0, before.length - (this.list.length - 1));
    if (removed > 0) {
      log('shell', 'notification-superseded', {
        detail: { kind: entry.kind, count: removed },
      });
    }
    this.persist();
    this.changed();
    this.updateBadge();
    if (state.settings?.current.notifications.banner) {
      state.shellView?.webContents.send(IpcChannels.notificationBanner, entry);
    }
    log('shell', 'notification-added', {
      detail: { id: entry.id, kind: entry.kind, sessionId: entry.sessionId },
    });
    return entry;
  }

  markRead(id: string): void {
    this.list = markRead(this.list, id, Date.now());
    this.persist();
    this.changed();
    this.updateBadge();
  }

  markAllRead(): void {
    this.list = markAllRead(this.list, Date.now());
    this.persist();
    this.changed();
    this.updateBadge();
  }

  remove(id: string): void {
    this.list = removeNotification(this.list, id);
    this.persist();
    this.changed();
    this.updateBadge();
  }

  clear(): void {
    this.list = clearNotifications(this.list);
    this.persist();
    this.changed();
    this.updateBadge();
  }

  unread(): number {
    return unreadCount(this.list);
  }

  // Drop session-scoped entries derived for a different token user (or a
  // pre-owner build). Runs once per identity resolution in the notifier.
  reconcile(ownerUserId: string | null): number {
    const before = this.list.length;
    this.list = pruneForeign(this.list, ownerUserId);
    const removed = before - this.list.length;
    if (removed === 0) return 0;
    this.persist();
    this.changed();
    this.updateBadge();
    log('shell', 'notifications-pruned', {
      detail: { removed, hasOwner: ownerUserId !== null },
    });
    return removed;
  }

  private changed(): void {
    notifyShell();
  }

  // Taskbar overlay = unread count (the only surviving OS-level surface).
  // The glyphs are rendered in the shell renderer (canvas — main has no DOM
  // and nativeImage can't rasterise SVG); the reply carries the desired
  // {count,size} so a late mount re-renders.
  private updateBadge(): void {
    const windowRef = state.windowRef;
    if (!windowRef || windowRef.isDestroyed()) return;
    const count = this.unread();
    if (count === 0) {
      windowRef.setOverlayIcon(null, '');
      log('shell', 'badge', { detail: { count } });
      return;
    }
    this.shellView()?.webContents.send(IpcChannels.badgeRender, {
      count,
      size: badgeIconSize(),
    });
    log('shell', 'badge', { detail: { count } });
  }

  private shellView() {
    return state.shellView && !state.shellView.webContents.isDestroyed()
      ? state.shellView
      : null;
  }

  // Called from the badge:rendered IPC — applies the shell-rendered icon.
  applyBadgeIcon(dataUrl: string | null): void {
    const windowRef = state.windowRef;
    if (!windowRef || windowRef.isDestroyed()) return;
    const count = this.unread();
    // A null probe (shell mount) must not clear a badge that is still due;
    // the reply makes the shell render and call back with the PNG.
    if (count > 0 && !dataUrl) return;
    try {
      windowRef.setOverlayIcon(
        count > 0 ? nativeImage.createFromDataURL(dataUrl!) : null,
        count > 0 ? `${count} unread notification${count === 1 ? '' : 's'}` : '',
      );
    } catch (error) {
      log('shell', 'badge-error', { detail: { message: String(error) } });
    }
  }

  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(join(this.file, '..'), { recursive: true });
        const stored = this.list.filter((item) => !RUNTIME_ONLY.has(item.kind));
        writeFileSync(this.file, JSON.stringify(stored.slice(0, MAX_NOTIFICATIONS)));
      } catch (error) {
        log('shell', 'notifications-save-error', { detail: { message: String(error) } });
      }
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const stored = this.list.filter((item) => !RUNTIME_ONLY.has(item.kind));
      writeFileSync(this.file, JSON.stringify(stored.slice(0, MAX_NOTIFICATIONS)));
    } catch {
      // best effort at shutdown
    }
  }
}

let store: NotificationStore | null = null;

export function notificationStore(userData?: string): NotificationStore {
  if (!store) {
    if (!userData) throw new Error('notificationStore not initialised');
    store = new NotificationStore(userData);
  }
  return store;
}

// publicState-safe: zero before the store exists (called before createWindow).
export function notificationsUnread(): number {
  return store?.unread() ?? 0;
}

export function notificationsFlush(): void {
  store?.flush();
}

// Badge icon: 16 logical px at the display's scale factor (16–64 device px).
export function badgeIconSize(): number {
  const scale = screen.getPrimaryDisplay().scaleFactor;
  return Math.min(64, Math.max(16, Math.round(16 * scale)));
}
