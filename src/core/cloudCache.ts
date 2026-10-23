// Persisted snapshot of the cloud session list (userData/cloud-cache.json) so
// the sidebar can render instantly while the live socket connects. Pure TS —
// no electron imports.

import { z } from 'zod';
import { CloudSessionSchema } from '../shared/ipc';

export const CloudCacheSchema = z.object({
  version: z.literal(1),
  tenantUrl: z.string(),
  savedAt: z.string(),
  sessions: z.array(CloudSessionSchema),
  folders: z.array(z.string()),
  folderTotals: z.record(z.string(), z.number()),
});
export type CloudCache = z.infer<typeof CloudCacheSchema>;

export function buildCloudCache(input: {
  tenantUrl: string;
  savedAt: string;
  sessions: CloudCache['sessions'];
  folders: string[];
  folderTotals: Record<string, number>;
}): CloudCache {
  return {
    version: 1,
    tenantUrl: input.tenantUrl,
    savedAt: input.savedAt,
    sessions: input.sessions,
    folders: input.folders,
    folderTotals: input.folderTotals,
  };
}

export function serializeCloudCache(input: Parameters<typeof buildCloudCache>[0]): string {
  return JSON.stringify(buildCloudCache(input));
}

// Cache files are per-tenant — a stale file from another tenant is a miss.
const normalizeTenant = (url: string) => url.replace(/\/+$/, '');

// Already-parsed form (the generic sessions controller reads the JSON through
// an injected reader); a malformed value or another tenant's cache is a miss.
export function parseCloudCacheValue(value: unknown, tenantUrl: string): CloudCache | null {
  const parsed = CloudCacheSchema.safeParse(value);
  if (!parsed.success) return null;
  if (normalizeTenant(parsed.data.tenantUrl) !== normalizeTenant(tenantUrl)) return null;
  return parsed.data;
}

export function parseCloudCache(json: string, tenantUrl: string): CloudCache | null {
  try {
    return parseCloudCacheValue(JSON.parse(json), tenantUrl);
  } catch {
    return null;
  }
}
