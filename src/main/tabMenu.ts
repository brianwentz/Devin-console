// The Linked Context tab right-click menu (tabs:tabMenu). Built from tabMenuModel so the
// Review items follow the tab's URL and review status. Same test seam as
// src/main/favoritesMenu.ts: in test mode the menu is described (ids m0…) instead of
// popped, and tabMenuClick(id) runs the action. URLs are never logged here.
import { clipboard, dialog, Menu } from 'electron';
import { tabMenuModel, type TabMenuItem } from '../core/tabReview';
import { log } from './log';
import { reviews, type ReviewStartResult } from './review/controller';
import { state, testMode } from './state';

export type TabMenuAction = TabMenuItem['action'] | null;
export interface TabMenuItemDesc {
  id: string;
  label: string;
  enabled: boolean;
}
type RefusalReason = Extract<ReviewStartResult, { ok: false }>['reason'];

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  'not-pr': 'This tab is not a pull request.',
  running: 'A review of this tab is already running.',
  'distro-unavailable': 'The WSL distro chosen for reviews is not available.',
  'distro-stopped': "The WSL distro chosen for reviews is stopped and couldn't be started. Start it and try again.",
  'helper-not-ready': 'The WSL distro chosen for reviews is not ready yet. Try again in a moment.',
  'no-claude': 'The claude CLI was not found on the review host.',
  spawn: 'The review terminal could not be started.',
};

function refusalText(reason: RefusalReason): string {
  const host = state.settings?.current.review.host ?? '';
  if (reason === 'distro-stopped' && host.startsWith('wsl:')) {
    return `The WSL distro ${host.slice('wsl:'.length)} is stopped and couldn't be started. Start it and try again.`;
  }
  return REFUSAL_TEXT[reason];
}

// "Copy address" (tab context menu + test hook). Returns false when the tab is gone.
export function copyTabAddress(tabId: string): boolean {
  const tab = state.tabManager?.getTab(tabId);
  if (!tab) return false;
  clipboard.writeText(tab.url);
  log('shell', 'tab-copy-address', { detail: { id: tabId }, url: tab.url });
  return true;
}

// Test mode only.
let pending: { tabId: string; items: TabMenuItem[] } | null = null;
let lastRefusal: RefusalReason | null = null;

async function startReview(tabId: string): Promise<void> {
  lastRefusal = null;
  const result = await reviews().start(tabId);
  if (result.ok) return;
  if (testMode) {
    lastRefusal = result.reason;
    return;
  }
  const options = { type: 'info' as const, message: refusalText(result.reason), buttons: ['OK'] };
  if (state.windowRef) await dialog.showMessageBox(state.windowRef, options);
  else await dialog.showMessageBox(options);
}

async function runAction(tabId: string, action: TabMenuItem['action']): Promise<void> {
  switch (action) {
    case 'copy':
      copyTabAddress(tabId);
      return;
    case 'review':
    case 'rerun':
      await startReview(tabId);
      return;
    case 'show-review':
      reviews().showTerminal(tabId);
      return;
  }
}

export function popupTabMenu(tabId: string, x: number, y: number): void {
  const tab = state.tabManager?.getTab(tabId);
  if (!tab || !state.windowRef) return;
  const record = reviews().active(tabId);
  const terminalHidden = record !== null && record.ptyId !== null && !record.terminalOpen;
  const items = tabMenuModel(tab.url, record?.status ?? null, terminalHidden);
  if (testMode) {
    pending = { tabId, items };
    return;
  }
  Menu.buildFromTemplate(
    items.map((item) => ({
      label: item.label,
      enabled: item.enabled,
      click: () => {
        runAction(tabId, item.action).catch((error: unknown) => {
          log('shell', 'tab-menu-error', {
            detail: { action: item.action, code: error instanceof Error ? error.name : 'unknown' },
          });
        });
      },
    })),
  ).popup({ window: state.windowRef, x: Math.round(x), y: Math.round(y) });
}

// Test hooks. Item ids are m0… in display order, like the other menu seams.
export function tabMenuItems(): TabMenuItemDesc[] | null {
  return pending ? pending.items.map((item, i) => ({ id: `m${i}`, label: item.label, enabled: item.enabled })) : null;
}

export async function tabMenuClick(id: string): Promise<{ action: TabMenuAction }> {
  const open = pending;
  const item = open?.items[Number(id.slice(1))];
  if (!open || !item || !/^m\d+$/.test(id) || !item.enabled) return { action: null };
  pending = null;
  await runAction(open.tabId, item.action);
  return { action: item.action };
}

export function lastReviewRefusal(): RefusalReason | null {
  return lastRefusal;
}
