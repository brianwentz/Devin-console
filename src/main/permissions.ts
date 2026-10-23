import { session } from 'electron';
import { isGitHubHost } from '../core/linkRouter';
import { ruleOwnsOrigin } from '../core/linkRules';
import { pools } from './cloudKit/pools';
import { log } from './log';
import { routeContext } from './routing';
import { fixtureOrigins } from './state';

// F1: GitHub tab views get sanitized clipboard writes (PR copy buttons); the
// Devin view gets clipboard-write only (OS notifications go through the in-app center). In test mode
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

export function setPermissions(
  targetSession: Electron.Session,
  viewName: 'devin' | `gh:${string}`,
): void {
  const isGhTab = viewName.startsWith('gh:');
  const allowed = (permission: string, origin: string): boolean => {
    if (viewName === 'devin') {
      // Resolved at check time: the pool may register after this handler is set.
      const pool = pools().find(
        (p) => session.fromPartition(p.config.partition) === targetSession,
      );
      return !!pool?.config.ownsUrl(origin) && permission === 'clipboard-sanitized-write';
    }
    if (isGhTab) return permission === 'clipboard-sanitized-write' && isGitOrigin(origin);
    return false;
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
