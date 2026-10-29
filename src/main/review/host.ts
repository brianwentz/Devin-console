// The review host: `settings.review.host` resolved against the live host
// registry. A configured distro that is unavailable refuses — never a silent
// fallback to this PC.

import type { HostId } from '../../core/execHost';
import { resolveReviewHostPure } from '../../core/tabReview';
import { hosts } from '../hosts';
import { state } from '../state';

export function resolveReviewHost():
  | { ok: true; hostId: HostId }
  | { ok: false; reason: 'distro-unavailable' | 'helper-not-ready' } {
  const setting = state.settings?.current.review.host ?? 'local';
  let distro: { listed: boolean; enabled: boolean; fsReady: boolean } | null = null;
  if (setting.startsWith('wsl:')) {
    const name = setting.slice('wsl:'.length);
    const host = hosts().list().find((h) => h.id === setting);
    distro = {
      listed: hosts().enumerate().some((row) => row.name === name),
      enabled: host !== undefined,
      fsReady: host !== undefined && hosts().fsReady(host),
    };
  }
  return resolveReviewHostPure(setting, process.platform, distro);
}
