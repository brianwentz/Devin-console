import type { Surface } from '../shared/ipc';
import { commitDraft, lastDraftSettings } from './settingsDraft';
import { getShellState } from './store';

// Leaving Settings commits any dirty draft first; a validation failure keeps
// the current surface so the error stays visible.
export async function requestSurface(next: Surface): Promise<void> {
  const current = getShellState();
  if (current?.surface === 'settings' && next !== 'settings') {
    const settings = lastDraftSettings() ?? current.settings;
    const ok = await commitDraft('surface', settings);
    if (!ok) return;
  }
  window.agentworkspace.setSurface(next);
}
