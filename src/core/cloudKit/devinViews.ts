// Devin Cloud's view-pool keying + ownership, kept pure so the ViewPoolConfig
// wiring in src/main/cloudViews.ts stays a thin adapter over state.tenantUrl.

import { parseSessionId } from '../sessions';
import { HOME_KEY } from '../viewPool';

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Pool key for a URL: the session id for `/sessions/<id>`, HOME_KEY for any
// other page on the tenant host, null when the URL is not on the tenant host
// (or either URL is unparseable). Host-matched like parseSessionId, so a
// non-null result always equals core/viewPool keyForUrl.
export function devinViewKey(url: string, tenantUrl: string): string | null {
  const parsed = parse(url);
  const tenant = parse(tenantUrl);
  if (!parsed || !tenant) return null;
  if (parsed.host.toLowerCase() !== tenant.host.toLowerCase()) return null;
  return parseSessionId(url, tenantUrl) ?? HOME_KEY;
}

// True only for URLs on the tenant origin (scheme + host + port).
export function devinOwnsUrl(url: string, tenantUrl: string): boolean {
  const parsed = parse(url);
  const tenant = parse(tenantUrl);
  if (!parsed || !tenant) return false;
  return parsed.origin === tenant.origin;
}
