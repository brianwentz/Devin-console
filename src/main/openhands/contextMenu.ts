// Native context menus for the OpenHands sidebar (built in main, like
// cloudSessions.contextMenu). The invoke resolves to `{action}`: only `rename`
// is completed by the shell (an inline input); everything else runs here.
//
// Test mode cannot click a native popup, so the menu is described instead and
// the invoke stays open until `clickItem(id)` (the `openhandsMenuClick` hook)
// resolves it — the same round trip the shell performs for a real click. Item
// ids are the stable ids of `openhandsMenuEntries` (`rename`, `delete`, ...).
//
// Logs carry ids/ops only — never titles.

import { clipboard, dialog, Menu, shell } from 'electron';
import {
  conversationUrl,
  openhandsMenuEntries,
  type OpenHandsMenuEntry,
  type OpenHandsMenuId,
} from '../../core/openhands';
import type { OpenHandsContextMenuRequest, OpenHandsContextMenuResult } from '../../shared/ipc';
import { log } from '../log';
import { state, testMode } from '../state';

export interface OpenHandsMenuDeps {
  /** Title of a listed conversation (display only), undefined when unknown. */
  titleOf(id: string): string | undefined;
  capabilities(): { rename: boolean; delete: boolean };
  baseUrl(): string;
  newSession(): void;
  refresh(): void;
  remove(id: string): Promise<void>;
}

export interface MenuMutation {
  op: string;
  payload: Record<string, unknown>;
}

interface DescribedItem {
  id: string;
  label: string;
  type: 'normal';
  enabled: boolean;
}

export class OpenHandsContextMenu {
  private mutations: MenuMutation[] = [];
  private described: DescribedItem[] = [];
  private pending: { sessionId: string | undefined; resolve: (r: OpenHandsContextMenuResult) => void } | null =
    null;

  constructor(private readonly deps: OpenHandsMenuDeps) {}

  /** Test-mode recorder of everything the menus / sidebar did. */
  mutationLog(): MenuMutation[] {
    return this.mutations;
  }

  record(op: string, payload: Record<string, unknown> = {}): void {
    if (testMode) this.mutations.push({ op, payload });
  }

  menuItems(): DescribedItem[] {
    return this.described;
  }

  /** Test seam: click an item of the open (described) menu. */
  async clickItem(id: string): Promise<OpenHandsContextMenuResult> {
    const pending = this.pending;
    if (!pending || !this.described.some((item) => item.id === id)) return { action: null };
    this.pending = null;
    const action = await this.perform(id as OpenHandsMenuId, pending.sessionId);
    const result: OpenHandsContextMenuResult = { action };
    pending.resolve(result);
    return result;
  }

  async show(arg: OpenHandsContextMenuRequest): Promise<OpenHandsContextMenuResult> {
    // A menu left open (test mode) is superseded by the next one.
    this.pending?.resolve({ action: null });
    this.pending = null;
    if (arg.kind === 'session' && !arg.sessionId) return { action: null };
    const entries = openhandsMenuEntries(arg.kind, this.deps.capabilities());
    if (entries.length === 0) return { action: null };
    const sessionId = arg.sessionId;

    if (testMode) {
      this.described = entries.flatMap((e) =>
        e === 'separator' ? [] : [{ id: e.id, label: e.label, type: 'normal' as const, enabled: true }],
      );
      return new Promise((resolve) => {
        this.pending = { sessionId, resolve };
      });
    }

    let action: OpenHandsContextMenuResult['action'] = null;
    const template = entries.map((e: OpenHandsMenuEntry): Electron.MenuItemConstructorOptions =>
      e === 'separator'
        ? { type: 'separator' }
        : {
            label: e.label,
            click: () => {
              // Set synchronously: the popup callback may run right after.
              if (e.id === 'rename') action = sessionId ? 'rename' : null;
              else void this.perform(e.id, sessionId);
            },
          },
    );
    const menu = Menu.buildFromTemplate(template);
    await new Promise<void>((resolve) => {
      const opts: Electron.PopupOptions = {
        x: Math.round(arg.x),
        y: Math.round(arg.y),
        callback: () => resolve(),
      };
      if (state.windowRef) menu.popup({ ...opts, window: state.windowRef });
      else menu.popup(opts);
    });
    return { action };
  }

  private async perform(id: OpenHandsMenuId, sessionId: string | undefined): Promise<'rename' | null> {
    switch (id) {
      case 'new-session':
        this.deps.newSession();
        return null;
      case 'refresh':
        this.record('refresh');
        this.deps.refresh();
        return null;
      case 'rename':
        return sessionId ? 'rename' : null;
      case 'copy-id':
        if (sessionId) {
          this.record('copy-id', { id: sessionId });
          clipboard.writeText(sessionId);
        }
        return null;
      case 'open-in-browser':
        if (sessionId) this.openInBrowser(sessionId);
        return null;
      case 'delete':
        if (sessionId) await this.confirmDelete(sessionId);
        return null;
    }
  }

  private openInBrowser(id: string): void {
    let url: string;
    try {
      url = new URL(conversationUrl(this.deps.baseUrl(), id)).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//.test(url)) return;
    this.record('open-in-browser', { id });
    if (testMode) return;
    void shell.openExternal(url).catch(() => undefined);
  }

  private async confirmDelete(id: string): Promise<void> {
    const win = state.windowRef;
    let confirmed = testMode;
    if (!testMode) {
      if (!win) return;
      const title = this.deps.titleOf(id);
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: title ? `Delete conversation "${title}"?` : 'Delete this conversation?',
        detail: 'This permanently deletes it from OpenHands.',
      });
      confirmed = response === 0;
    }
    log('shell', 'openhands-delete-confirm', { detail: { confirmed } });
    if (!confirmed) return;
    this.record('delete', { id });
    await this.deps.remove(id);
  }
}
