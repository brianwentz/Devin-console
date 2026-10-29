// Cloud session sidebar protocol helpers (pure). Ground truth:
// docs/evidence/cloud-acp-spike-*.json — the ws speaks JSON-RPC 2.0 over
// wss://<tenant>/api/acp/live and all extension fields live in _meta under
// the 'cognition.ai/' prefix. The 'cognition.ai/sessionListFolders' client
// capability is required for folder data; 'cognition.ai/compact' strips it.

import { CHILD_CAP, PAGE_SIZE } from './cloudFolderPagingLimits';
import { sanitizeMessage } from './devinApi';

const META = 'cognition.ai/';

export interface CloudSession {
  /** Bare hex id — matches parseSessionId('/sessions/<hex>') output. */
  id: string;
  /** Full ACP id, e.g. 'devin-<hex>'. */
  acpId: string;
  title: string;
  url: string;
  status: string;
  statusEnum: string | null;
  userActionRequired: string | null;
  folder: string | null;
  /** Bare hex of _meta['cognition.ai/proposedByDevinId'] — the sub-agent link. */
  parentId: string | null;
  isPinned: boolean;
  isUnread: boolean;
  isStarred: boolean;
  directChildrenCount: number;
  hasMoreChildren: boolean;
  prs: SessionPrCounts;
  isArchived: boolean;
  /** ms epoch. */
  updatedAt: number;
}

// _meta['cognition.ai/sessionPRs'] buckets, classified like the web sidebar:
// open with draft → 'draft', open with queued → 'queued', else the raw
// 'open'|'merged'|'closed' state; unknown states are ignored.
export interface SessionPrCounts {
  open: number;
  queued: number;
  draft: number;
  merged: number;
  closed: number;
}

export function prTotal(prs: SessionPrCounts): number {
  return prs.open + prs.queued + prs.draft + prs.merged + prs.closed;
}

export function parseSessionPrs(raw: unknown): SessionPrCounts {
  const counts: SessionPrCounts = { open: 0, queued: 0, draft: 0, merged: 0, closed: 0 };
  if (!Array.isArray(raw)) return counts;
  for (const entry of raw) {
    const item = asRecord(entry);
    if (!item) continue;
    const state = str(item.state);
    const kind =
      state === 'open'
        ? bool(item.draft)
          ? 'draft'
          : bool(item.queued)
            ? 'queued'
            : 'open'
        : state === 'merged' || state === 'closed'
          ? state
          : null;
    if (kind) counts[kind] += 1;
  }
  return counts;
}

export interface CloudListResult {
  sessions: CloudSession[];
  /** Folder order for orgId from _meta sidebarFoldersByOrg (may include the
   * 'pinned'/'participated' system folders). */
  folders: string[];
  folderTotals: Record<string, number>;
  nextCursor: string | null;
}

export function buildInitializeParams(version: string): Record<string, unknown> {
  return {
    protocolVersion: 1,
    clientInfo: { name: 'agent-workspace', version },
    clientCapabilities: { _meta: { [`${META}sessionListFolders`]: true } },
  };
}

// Shared by page 1 and folder pages so both send the same filters — in
// particular the same archivedStatus (folder pages used to be ACTIVE-only).
function baseListMeta(options: {
  orgId: string;
  userId: string | null;
  archivedStatus: 'ACTIVE' | 'ALL';
  rootsCap: number;
  childCap: number;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [`${META}archivedStatus`]: options.archivedStatus,
    [`${META}orgIds`]: [options.orgId],
    [`${META}hideCodeScans`]: true,
    [`${META}foldersExcludeArchived`]: true,
    [`${META}sessionType`]: ['devin'],
    [`${META}orderBy`]: 'updated_at',
    [`${META}sortDirection`]: 'desc',
    [`${META}includePinned`]: true,
    [`${META}groupChildren`]: true,
    [`${META}childrenDirect`]: true,
    [`${META}maxChildrenPerRoot`]: options.childCap,
    [`${META}maxRootsPerFolder`]: options.rootsCap,
  };
  // Omitted entirely when the identity lookup failed — the key itself is
  // meaningful to the server.
  if (options.userId) meta[`${META}participant`] = [options.userId];
  return meta;
}

export function buildListParams(options: {
  orgId: string;
  userId: string | null;
  archivedStatus?: 'ACTIVE' | 'ALL';
  rootsCap?: number;
  childCap?: number;
}): Record<string, unknown> {
  const meta = baseListMeta({
    orgId: options.orgId,
    userId: options.userId,
    archivedStatus: options.archivedStatus ?? 'ACTIVE',
    rootsCap: options.rootsCap ?? PAGE_SIZE,
    childCap: options.childCap ?? CHILD_CAP,
  });
  meta[`${META}limit`] = 50;
  return { _meta: meta };
}

// One folder page: page 1's shape minus limit, plus folder + rootsOffset
// (offset counted in top-level rows of the folder).
export function buildFolderPageParams(options: {
  orgId: string;
  userId: string | null;
  folder: string;
  rootsOffset: number;
  archivedStatus: 'ACTIVE' | 'ALL';
  pageSize: number;
  childCap: number;
}): Record<string, unknown> {
  const meta = baseListMeta({
    orgId: options.orgId,
    userId: options.userId,
    archivedStatus: options.archivedStatus,
    rootsCap: options.pageSize,
    childCap: options.childCap,
  });
  meta[`${META}folder`] = options.folder;
  meta[`${META}rootsOffset`] = options.rootsOffset;
  return { _meta: meta };
}

export function acpWsUrl(tenantUrl: string, token: string, orgId: string): string {
  const base = tenantUrl.replace(/\/$/, '').replace(/^http/, 'ws');
  return `${base}/api/acp/live?token=${encodeURIComponent(token)}&org_id=${encodeURIComponent(orgId)}`;
}

export function usersInfoUrl(tenantUrl: string): string {
  return `${tenantUrl.replace(/\/$/, '')}/api/users/info`;
}

export function bareSessionId(acpId: string): string {
  return acpId.startsWith('devin-') ? acpId.slice('devin-'.length) : acpId;
}

// Backoff for the new-session watch: the composer navigates home→/sessions/<id>
// a few seconds before the backend actually lists the session.
export const NEW_SESSION_WATCH_DELAYS_MS = [
  1500, 2500, 4000, 6000, 8000, 10000, 12000,
];

export function sanitizeToken(message: string, token: string): string {
  return sanitizeMessage(message, token);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return Date.parse(value) || 0;
  return 0;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
  }
  return out;
}

export function parseListResult(raw: unknown, orgId: string): CloudListResult {
  const record = asRecord(raw);
  const meta = asRecord(record?._meta) ?? {};
  const foldersByOrg = asRecord(meta[`${META}sidebarFoldersByOrg`]);
  const folders = strArray(foldersByOrg?.[orgId]);
  const folderTotals = numRecord(meta[`${META}folderTotals`]);
  const nextCursor = str(record?.nextCursor);

  const rawSessions = Array.isArray(record?.sessions)
    ? record.sessions
    : Array.isArray(record?.items)
      ? record.items
      : [];
  const sessions: CloudSession[] = [];
  for (const entry of rawSessions) {
    const item = asRecord(entry);
    if (!item) continue;
    const itemMeta = asRecord(item._meta) ?? {};
    const acpId = str(item.sessionId) ?? str(item.id);
    if (!acpId) continue;
    const proposedBy = str(itemMeta[`${META}proposedByDevinId`]);
    sessions.push({
      id: bareSessionId(acpId),
      acpId,
      title: str(item.title) ?? '',
      url: str(itemMeta[`${META}url`]) ?? '',
      status: str(itemMeta[`${META}sessionStatus`]) ?? '',
      statusEnum: str(itemMeta[`${META}statusEnum`]),
      userActionRequired: str(itemMeta[`${META}userActionRequired`]),
      folder: str(itemMeta[`${META}folder`]),
      parentId: proposedBy ? bareSessionId(proposedBy) : null,
      isPinned: bool(itemMeta[`${META}isPinned`]),
      isUnread: bool(itemMeta[`${META}isUnread`]),
      isStarred: bool(itemMeta[`${META}isStarred`]),
      directChildrenCount: num(itemMeta[`${META}directChildrenCount`]),
      hasMoreChildren: bool(itemMeta[`${META}hasMoreChildren`]),
      prs: parseSessionPrs(itemMeta[`${META}sessionPRs`]),
      isArchived: bool(itemMeta[`${META}isArchived`]),
      updatedAt:
        timestampMs(item.updatedAt) || timestampMs(itemMeta[`${META}sortUpdatedAt`]),
    });
  }
  return { sessions, folders, folderTotals, nextCursor };
}

export function parseUsersInfo(raw: unknown): { userId: string | null } {
  const record = asRecord(raw);
  return { userId: str(record?.user_id) };
}
