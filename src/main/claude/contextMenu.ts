// Claude sidebar context menus — the same test seam as cloudSessions: in
// test mode the popup is described and the claudeMenuItems/claudeMenuClick
// hooks drive the same callbacks.
import { Menu, shell } from 'electron';
import { resolve } from 'node:path';
import type { ClaudeSessions } from './sessions';
import { log } from '../log';
import { state, testMode } from '../state';

export type MenuAction =
  | 'rename'
  | 'rename-session'
  | 'open-terminal'
  | 'attach-agent'
  | 'add'
  | null;

export class ClaudeContextMenu {
  private pendingMenu = new Map<string, Electron.MenuItemConstructorOptions>();
  private lastMenuDesc: Record<string, unknown>[] = [];
  private pendingAction: MenuAction = null;
  // Test mode only: the popup invoke stays open until a click resolves it —
  // same shape as the production popup resolving with pendingAction.
  private pendingMenuResolve: ((result: { action: MenuAction }) => void) | null = null;

  constructor(private readonly owner: ClaudeSessions) {}

  items(): Record<string, unknown>[] {
    return this.lastMenuDesc;
  }

  clickItem(id: string): { action: MenuAction } {
    const item = this.pendingMenu.get(id);
    if (!item?.click) return { action: null };
    const next = !(item.checked ?? false);
    item.checked = next;
    item.click(
      { checked: next } as Electron.MenuItem,
      state.windowRef!,
      {} as Electron.KeyboardEvent,
    );
    const action = this.pendingAction;
    this.pendingAction = null;
    this.pendingMenuResolve?.({ action });
    this.pendingMenuResolve = null;
    return { action };
  }

  async popup(arg: {
    kind: 'session' | 'workspace' | 'header' | 'agent';
    sessionId?: string | undefined;
    path?: string | undefined;
    agentId?: string | undefined;
    x: number;
    y: number;
  }): Promise<{ action: MenuAction; items?: Record<string, unknown>[] }> {
    this.pendingAction = null;
    const items: Electron.MenuItemConstructorOptions[] = [];

    if (arg.kind === 'agent' && arg.agentId) {
      const agentId = arg.agentId;
      items.push(
        {
          label: 'Attach',
          click: () => {
            this.pendingAction = 'attach-agent';
          },
        },
        { label: 'Stop', click: () => void this.owner.agentStop(agentId) },
      );
    } else if (arg.kind === 'header') {
      items.push({
        label: 'Show archived sessions',
        type: 'checkbox',
        checked: this.owner.showArchived,
        click: (item) => this.owner.setShowArchived(item.checked),
      });
      items.push(
        {
          label: 'Add workspace…',
          click: () => {
            this.pendingAction = 'add';
          },
        },
        { label: 'Refresh', click: () => void this.owner.refresh('menu') },
      );
    } else if (arg.kind === 'workspace' && arg.path) {
      const path = arg.path;
      items.push(
        {
          label: 'New session here',
          click: () => void this.owner.newSession(path),
        },
        {
          label: 'Rename…',
          click: () => {
            this.pendingAction = 'rename';
          },
        },
        {
          label: 'Open terminal here',
          click: () => {
            this.pendingAction = 'open-terminal';
          },
        },
        {
          label: 'Reveal in Explorer',
          click: () => {
            shell.showItemInFolder(resolve(path));
          },
        },
        { type: 'separator' },
        {
          label: 'Remove workspace',
          click: () => void this.owner.workspaceRemove(path),
        },
      );
    } else if (arg.kind === 'session' && arg.sessionId) {
      const session = this.owner.sessions.find((s) => s.id === arg.sessionId);
      if (!session) return { action: null };
      items.push(
        {
          label: 'Rename…',
          click: () => {
            this.pendingAction = 'rename-session';
          },
        },
        { label: 'Fork', click: () => void this.owner.fork(session.id) },
        {
          label: 'Open in terminal',
          click: () => {
            this.pendingAction = 'open-terminal';
          },
        },
        { type: 'separator' },
        {
          label: session.isPinned ? 'Unpin' : 'Pin',
          click: () => void this.owner.sessionPin(session.id, !session.isPinned),
        },
        {
          label: session.isArchived ? 'Unarchive' : 'Archive',
          click: () => void this.owner.sessionArchive(session.id, !session.isArchived),
        },
        {
          label: 'Re-check host environment',
          visible: session.host !== 'local',
          click: () => void this.owner.recheckEnv(session.id),
        },
        { type: 'separator' },
        { label: 'Reveal transcript', click: () => void this.owner.revealTranscript(session.id) },
        { label: 'Copy session id', click: () => this.owner.copySessionId(session.id) },
        { type: 'separator' },
        { label: 'Remove from list', click: () => void this.owner.sessionRemove(session.id) },
        {
          label: 'Delete transcript…',
          click: () => void this.owner.sessionDeleteTranscript(session.id),
        },
      );
    } else {
      return { action: null };
    }

    if (items.length === 0) return { action: null };
    if (testMode) {
      this.pendingMenu.clear();
      let n = 0;
      const assign = (list: Electron.MenuItemConstructorOptions[]) =>
        list.forEach((item) => {
          if (item.type === 'separator') return;
          item.id = `m${n++}`;
          this.pendingMenu.set(item.id, item);
          if (Array.isArray(item.submenu)) {
            assign(item.submenu as Electron.MenuItemConstructorOptions[]);
          }
        });
      assign(items);
      const describe = (
        list: Electron.MenuItemConstructorOptions[],
      ): Record<string, unknown>[] =>
        list.map((item) => ({
          id: item.id,
          label: item.label ?? item.role ?? '',
          type: item.type ?? 'normal',
          enabled: item.enabled !== false,
          ...(item.type === 'checkbox' ? { checked: item.checked } : {}),
          ...(item.submenu
            ? { submenu: describe(item.submenu as Electron.MenuItemConstructorOptions[]) }
            : {}),
        }));
      this.lastMenuDesc = describe(items);
      // Production resolves the invoke when the popup closes with
      // pendingAction; the click hook resolves it here the same way.
      return await new Promise<{ action: MenuAction }>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingMenuResolve = null;
          resolve({ action: null });
        }, 30_000);
        this.pendingMenuResolve = (result) => {
          clearTimeout(timer);
          this.pendingMenuResolve = null;
          resolve(result);
        };
      });
    }
    const menu = Menu.buildFromTemplate(items);
    log('claude', 'claude-menu', { detail: { kind: arg.kind } });
    await new Promise<void>((resolve) => {
      const opts: Electron.PopupOptions = {
        x: Math.round(arg.x),
        y: Math.round(arg.y),
        callback: () => resolve(),
      };
      if (state.windowRef) menu.popup({ ...opts, window: state.windowRef });
      else menu.popup(opts);
    });
    return { action: this.pendingAction };
  }
}
