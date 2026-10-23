import { isGitHubHost } from '../core/linkRouter';
import { ruleOwnsOrigin } from '../core/linkRules';
import { pools } from './cloudKit/pools';
import type { ViewPool } from './cloudKit/viewPool';
import { log } from './log';
import { routeContext } from './routing';
import { fixtureOrigins } from './state';

// F1: GitHub tab views get sanitized clipboard writes (PR copy buttons); hosted
// provider views (Devin, OpenHands) get clipboard-write only for their own origin
// (OS notifications go through the in-app center). In test mode
// the fixture Git origins count as GitHub hosts. Origins owned by an enabled
// link rule count too — rule-routed tabs are gh:* views.
function isGitOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (isGitHubHost(url.hostname)) return true;
    if (fixtureOrigins.includes(url.origin)) return true;
    return ruleOwnsOrigin(url.origin, routeContext().rules ?? []);
  } catch {
    return false;
  }
}

// `hostedPartition` names the pool partition the session serves (hosted views
// only); the pool is looked up by it once, on first use — it may register after
// this handler is installed.
export function setPermissions(
  targetSession: Electron.Session,
  viewName: 'devin' | 'openhands' | `gh:${string}`,
  hostedPartition?: string,
): void {
  const isGhTab = viewName.startsWith('gh:');
  let hostedPool: ViewPool | undefined;
  const allowed = (permission: string, origin: string): boolean => {
    if (isGhTab) return permission === 'clipboard-sanitized-write' && isGitOrigin(origin);
    hostedPool ??= pools().find((p) => p.config.partition === hostedPartition);
    return !!hostedPool?.config.ownsUrl(origin) && permission === 'clipboard-sanitized-write';
  };

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl || webContents.getURL();
    const grant = allowed(permission, origin);
    callback(grant);
    log(viewName, 'permission-request', {
      url: origin,
      decision: grant ? 'allow' : 'deny',
      detail: { permission },
    });
  });
  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const grant = allowed(permission, requestingOrigin);
    log(viewName, 'permission-check', {
      url: requestingOrigin,
      decision: grant ? 'allow' : 'deny',
      detail: { permission, webContentsId: webContents?.id },
    });
    return grant;
  });
}
