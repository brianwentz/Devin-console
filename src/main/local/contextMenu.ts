// Local sidebar context menus — the same test seam as claude/contextMenu.ts:
// in test mode the popup is described and the localMenuItems/localMenuClick
// test hooks drive the same callbacks.
import { clipboard, dialog, Menu, shell } from 'electron';
import { resolve } from 'node:path';
import type { LocalContextMenuRequest } from '../../shared/ipc';
import { log } from '../log';
import { defaultWorkspaceLabel } from '../../core/workspaceTree';
import { getLocalState } from './localState';
import { state, testMode } from '../state';
import { hosts } from '../hosts';
import type { DevinLocalHost } from './acpHost';
import type { terminalHost as terminalHostSingleton } from './terminalHost';

export type LocalMenuAction =
  | 'new-session'
  | 'rename'
  | 'open-terminal'
  | 'delete-all'
  | 'remove'
  | 'delete'
  | 'add'
  | 'add-remote'
  | 'refresh'
  | null;

type Host = DevinLocalHost;
type Terminals = typeof terminalHostSingleton;

export class LocalContextMenu {
  private pendingMenu = new Map<string, Electron.MenuItemConstructorOptions>();
  private lastMenuDesc: Record<string, unknown>[] = [];
  private pendingAction: LocalMenuAction = null;
  // Test mode only: the popup invoke stays open until a click resolves it.
  private pendingMenuResolve: ((result: { action: LocalMenuAction }) => void) | null = null;

  constructor(
    private readonly host: () => Host | null,
    private readonly terminals: Terminals,
    private readonly removeWorkspace: (path: string) => void,
    // Republish shell state after a main-side selection change (kept as a
    // callback so contextMenu.ts doesn't import window.ts).
    private readonly publish: () => void,
  ) {}

  items(): Record<string, unknown>[] {
    return this.lastMenuDesc;
  }

  clickItem(id: string): { action: LocalMenuAction } {
    const item = this.pendingMenu.get(id);
    if (!item?.click) return { action: null };
    item.click(
      { checked: !(item.checked ?? false) } as Electron.MenuItem,
      state.windowRef!,
      {} as Electron.KeyboardEvent,
    );
    const action = this.pendingAction;
    this.pendingAction = null;
    this.pendingMenuResolve?.({ action });
    this.pendingMenuResolve = null;
    return { action };
  }

  private agentFor(path: string) {
    const normalized = resolve(path);
    return (
      getLocalState().agents[normalized] ??
      getLocalState().agents[path]
    );
  }

  async popup(arg: LocalContextMenuRequest): Promise<{ action: LocalMenuAction }> {
    this.pendingAction = null;
    const items: Electron.MenuItemConstructorOptions[] = [];
    const host = this.host();

    if (arg.kind === 'workspace') {
      const path = arg.path;
      const normalized = resolve(path);
      const agent = this.agentFor(path);
      const sessions = Object.values(getLocalState().sessions).filter(
        (s) => s.workspace === normalized || s.workspace === path,
      );
      items.push(
        {
          label: 'New session',
          click: () => void this.newSession(normalized),
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
            shell.showItemInFolder(normalized);
          },
        },
        { type: 'separator' },
        {
          label: 'Delete all sessions…',
          enabled: Boolean(agent?.capabilities?.sessionDelete) && sessions.length > 0,
          click: () => {
            this.pendingAction = 'delete-all';
          },
        },
        {
          label: 'Remove workspace',
          click: () => void this.confirmRemove(normalized),
        },
      );
    } else if (arg.kind === 'session') {
      const session = getLocalState().sessions[arg.sessionId];
      if (!session) return { action: null };
      const agent = this.agentFor(session.workspace);
      items.push(
        {
          label: 'Open terminal',
          click: () => {
            this.pendingAction = 'open-terminal';
          },
        },
        {
          label: 'Copy session id',
          click: () => {
            clipboard.writeText(arg.sessionId);
            log('local', 'local-session-copy-id', {});
          },
        },
        { type: 'separator' },
        {
          label: 'Delete',
          enabled: Boolean(agent?.capabilities?.sessionDelete) && !session.running,
          click: () => {
            this.pendingAction = 'delete';
          },
        },
      );
    } else if (arg.kind === 'header') {
      items.push(
        {
          label: 'Add workspace…',
          click: () => {
            this.pendingAction = 'add';
          },
        },
        {
          // A WSL folder through the in-app RemoteFolderInput (P3).
          label: 'Add WSL workspace…',
          enabled: hosts().list().some((h) => h.kind === 'wsl'),
          click: () => {
            this.pendingAction = 'add-remote';
          },
        },
        {
          label: 'Refresh all',
          click: () => {
            for (const ws of host?.listWorkspaces() ?? []) {
              void host?.listSessions(ws).catch(() => undefined);
            }
          },
        },
      );
    } else {
      return { action: null };
    }

    if (items.length === 0) return { action: null };
    if (testMode) {
      this.pendingMenu.clear();
      let n = 0;
      for (const item of items) {
        if (item.type === 'separator') continue;
        item.id = `m${n++}`;
        this.pendingMenu.set(item.id, item);
      }
      this.lastMenuDesc = items.map((item) => ({
        id: item.id,
        label: item.label ?? item.role ?? '',
        type: item.type ?? 'normal',
        enabled: item.enabled !== false,
      }));
      return await new Promise<{ action: LocalMenuAction }>((resolve) => {
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
    return await new Promise<{ action: LocalMenuAction }>((resolve) => {
      menu.popup({
        window: state.windowRef!,
        x: Math.round(arg.x),
        y: Math.round(arg.y),
        callback: () => {
          const action = this.pendingAction;
          this.pendingAction = null;
          resolve({ action });
        },
      });
    });
  }

  private async newSession(workspace: string): Promise<void> {
    const id = await this.host()?.newSession(workspace);
    if (typeof id === 'string' && id) {
      state.localSessionId = id;
      this.publish();
    }
  }

  private async confirmRemove(path: string): Promise<void> {
    const win = state.windowRef;
    let confirmed = testMode;
    if (!confirmed && win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Remove', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Remove workspace "${defaultWorkspaceLabel(path)}"?`,
        detail: 'Sessions stay on disk; the Local agent for this folder is stopped.',
      });
      confirmed = response === 0;
    }
    if (confirmed) this.removeWorkspace(path);
  }
}
