// Pure policy for store change events. A full SDK listSessions over the wsl
// UNC (9P) costs seconds, so a wsl transcript change that names its files only
// feeds the history reload — never a full re-list.

import { isWslHost, type ExecHost } from './execHost';

export function watchAction(host: ExecHost, files: string[]): 'history-only' | 'refresh' {
  return isWslHost(host) && files.length > 0 ? 'history-only' : 'refresh';
}

/** True when a project dir was added, removed or has a different mtime; a null `prev` counts as changed. */
export function dirsChanged(prev: Map<string, number> | null, next: Map<string, number>): boolean {
  if (!prev || prev.size !== next.size) return true;
  for (const [dir, mtime] of next) {
    if (prev.get(dir) !== mtime) return true;
  }
  return false;
}
