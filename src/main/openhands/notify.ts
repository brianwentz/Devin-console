// Gate + store write for OpenHands status transitions, electron-free so it is
// unit tested with an injected store. Logs kinds/counts only (never titles).
import { notifyAllowed, openHandsEntry, type OhTransition, type OhTransitionKind } from '../../core/openhands';
import type { NewNotification } from '../../core/notificationModel';

export interface TransitionNotifierDeps {
  /** `settings.notifications` right now (undefined before settings load). */
  settings(): { collect?: boolean; kinds?: Partial<Record<OhTransitionKind, boolean>> } | undefined;
  add(entry: NewNotification): void;
  log(event: string, detail: Record<string, unknown>): void;
  now?(): number;
}

export function createTransitionNotifier(deps: TransitionNotifierDeps): (transitions: OhTransition[]) => void {
  return (transitions) => {
    try {
      const settings = deps.settings();
      const counts: Partial<Record<OhTransitionKind, number>> = {};
      for (const t of transitions) {
        if (!notifyAllowed(settings?.collect, settings?.kinds, t.kind)) continue;
        deps.add(openHandsEntry(t, t.row, deps.now?.()));
        counts[t.kind] = (counts[t.kind] ?? 0) + 1;
      }
      for (const [kind, count] of Object.entries(counts)) deps.log('openhands-notify', { kind, count });
    } catch (error) {
      deps.log('openhands-notify-error', { code: error instanceof Error ? error.name : 'unknown' });
    }
  };
}
