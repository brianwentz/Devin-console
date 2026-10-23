// The #tabFavorites native menu of Chrome bookmarks. Native because hosted views paint
// over the shell. Same test seam as src/main/claude/contextMenu.ts: in test mode the menu
// is described (ids m0… depth-first) and the invoke stays open until
// favoritesMenuClick(id) resolves it. Labels and URLs are never logged — the one URL in
// the log is openUserUrl's `tab-user-open` for the bookmark the user opened.
import { Menu } from 'electron';
import { buildFavoritesMenu, type FavoritesMenuNode } from '../core/chromeBookmarks';
import type { BookmarksLoadResult } from '../core/bookmarksReader';
import { bookmarksReader } from './bookmarks';
import { openUserUrl } from './routing';
import { state, testMode } from './state';

export type FavoritesMenuAction = 'open' | null;
export interface FavoritesMenuItemDesc {
  id: string;
  label: string;
  enabled: boolean;
  submenu?: FavoritesMenuItemDesc[];
}

const NOT_FOUND = 'Chrome bookmarks not found';
const UNREADABLE = "Chrome bookmarks couldn't be read";
const EMPTY = 'No bookmarks';

type Template = Electron.MenuItemConstructorOptions;

// Bumped per open: a load that finishes after a newer open started is dropped.
let generation = 0;
// Test mode only.
const pendingItems = new Map<string, Template>();
let pendingDesc: FavoritesMenuItemDesc[] | null = null;
let pendingResolve: ((result: { action: FavoritesMenuAction }) => void) | null = null;

function toTemplate(nodes: FavoritesMenuNode[], onOpen: () => void): Template[] {
  return nodes.map((node): Template => {
    if (node.kind === 'folder') return { label: node.label, submenu: toTemplate(node.children, onOpen) };
    if (node.kind === 'more') return { label: node.label, enabled: false };
    const url = node.url;
    return {
      label: node.label,
      click: () => {
        onOpen();
        openUserUrl(url, 'favorite', 'new');
      },
    };
  });
}

export function favoritesMenuTemplate(result: BookmarksLoadResult, onOpen: () => void = () => {}): Template[] {
  if (result.state === 'missing') return [{ label: NOT_FOUND, enabled: false }];
  if (result.state === 'unreadable') return [{ label: UNREADABLE, enabled: false }];
  const nodes = buildFavoritesMenu(result.tree);
  return nodes.length > 0 ? toTemplate(nodes, onOpen) : [{ label: EMPTY, enabled: false }];
}

function describe(list: Template[]): FavoritesMenuItemDesc[] {
  return list.map((item) => ({
    id: item.id!,
    label: item.label ?? '',
    enabled: item.enabled !== false,
    ...(Array.isArray(item.submenu) ? { submenu: describe(item.submenu as Template[]) } : {}),
  }));
}

function settlePending(action: FavoritesMenuAction): void {
  const resolve = pendingResolve;
  pendingResolve = null;
  pendingDesc = null;
  pendingItems.clear();
  resolve?.({ action });
}

export async function popupFavoritesMenu(x: number, y: number): Promise<{ action: FavoritesMenuAction }> {
  const mine = ++generation;
  // A second open replaces a menu still open (a native popup closes first); the
  // previous invoke settles now and the description is cleared until this load lands.
  if (testMode) settlePending(null);
  // Per open, so overlapping opens cannot overwrite each other's reply.
  let action: FavoritesMenuAction = null;
  // Re-loaded on every open: the profile is the one configured at click time.
  const loaded = await bookmarksReader().load();
  if (mine !== generation) return { action: null };
  const items = favoritesMenuTemplate(loaded, () => {
    action = 'open';
  });
  if (testMode) {
    let n = 0;
    const assign = (list: Template[]): void =>
      list.forEach((item) => {
        item.id = `m${n++}`;
        pendingItems.set(item.id, item);
        if (Array.isArray(item.submenu)) assign(item.submenu as Template[]);
      });
    assign(items);
    pendingDesc = describe(items);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingResolve === done) settlePending(null);
      }, 30_000);
      const done = (result: { action: FavoritesMenuAction }): void => {
        clearTimeout(timer);
        resolve(result);
      };
      pendingResolve = done;
    });
  }
  const menu = Menu.buildFromTemplate(items);
  await new Promise<void>((resolve) => {
    const opts: Electron.PopupOptions = { x: Math.round(x), y: Math.round(y), callback: () => resolve() };
    if (state.windowRef) menu.popup({ ...opts, window: state.windowRef });
    else menu.popup(opts);
  });
  return { action };
}

// Test hooks.
export function favoritesMenuItems(): FavoritesMenuItemDesc[] | null {
  return pendingDesc;
}

export function favoritesMenuClick(id: string): { action: FavoritesMenuAction } {
  const item = pendingItems.get(id);
  if (!item?.click || item.enabled === false) return { action: null };
  item.click({} as Electron.MenuItem, state.windowRef!, {} as Electron.KeyboardEvent);
  settlePending('open');
  return { action: 'open' };
}
