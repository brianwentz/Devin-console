import { session } from 'electron';
import { pools } from './cloudKit/pools';
import { log } from './log';

export interface CookieAuditEntry {
  name: string;
  domain?: string | undefined;
  path?: string | undefined;
  session?: boolean | undefined;
  expirationDate?: number | undefined;
  httpOnly?: boolean | undefined;
  secure?: boolean | undefined;
  sameSite: string;
}

export interface CookieAuditResult {
  partition: string;
  count: number;
  cookies: CookieAuditEntry[];
}

// Never include cookie values — metadata only.
export async function auditCookies(): Promise<CookieAuditResult[]> {
  const results: CookieAuditResult[] = [];
  for (const partition of [...pools().map((p) => p.config.partition), 'persist:github']) {
    try {
      const cookies = await session.fromPartition(partition).cookies.get({});
      const result: CookieAuditResult = {
        partition,
        count: cookies.length,
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          session: cookie.session,
          expirationDate: cookie.expirationDate,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        })),
      };
      results.push(result);
      log('shell', 'cookie-audit', {
        detail: result as unknown as Record<string, unknown>,
      });
    } catch (error) {
      log('shell', 'cookie-audit-failed', {
        detail: { partition, error: String(error) },
      });
    }
  }
  return results;
}

export function startCookieAudit(): void {
  setTimeout(() => void auditCookies(), 10_000);
  const interval = setInterval(() => void auditCookies(), 60 * 60 * 1000);
  interval.unref();
}
