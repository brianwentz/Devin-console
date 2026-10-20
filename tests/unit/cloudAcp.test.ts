import { describe, expect, it } from 'vitest';
import {
  acpWsUrl,
  bareSessionId,
  buildFolderPageParams,
  buildInitializeParams,
  buildListParams,
  parseListResult,
  parseUsersInfo,
  sanitizeToken,
  usersInfoUrl,
} from '../../src/core/cloudAcp';

const ORG = 'org-abc123';

describe('buildInitializeParams', () => {
  it('includes the sessionListFolders capability', () => {
    expect(buildInitializeParams('1.2.3')).toEqual({
      protocolVersion: 1,
      clientInfo: { name: 'agent-workspace', version: '1.2.3' },
      clientCapabilities: { _meta: { 'cognition.ai/sessionListFolders': true } },
    });
  });
});

describe('buildListParams', () => {
  it('produces the captured web-app shape', () => {
    expect(buildListParams({ orgId: ORG, userId: 'user-1' })).toEqual({
      _meta: {
        'cognition.ai/archivedStatus': 'ACTIVE',
        'cognition.ai/orgIds': [ORG],
        'cognition.ai/participant': ['user-1'],
        'cognition.ai/hideCodeScans': true,
        'cognition.ai/foldersExcludeArchived': true,
        'cognition.ai/sessionType': ['devin'],
        'cognition.ai/orderBy': 'updated_at',
        'cognition.ai/sortDirection': 'desc',
        'cognition.ai/includePinned': true,
        'cognition.ai/groupChildren': true,
        'cognition.ai/childrenDirect': true,
        'cognition.ai/limit': 50,
        'cognition.ai/maxChildrenPerRoot': 8,
        'cognition.ai/maxRootsPerFolder': 20,
      },
    });
  });

  it('omits participant when userId is null and never sends compact', () => {
    const params = buildListParams({ orgId: ORG, userId: null });
    const meta = params._meta as Record<string, unknown>;
    expect(meta).not.toHaveProperty('cognition.ai/participant');
    expect(JSON.stringify(params)).not.toContain('compact');
  });
});

describe('buildFolderPageParams', () => {
  it('swaps limit for folder + rootsOffset + maxRootsPerFolder', () => {
    const params = buildFolderPageParams({
      orgId: ORG,
      userId: 'user-1',
      folder: 'Activity Log',
      rootsOffset: 20,
    });
    const meta = params._meta as Record<string, unknown>;
    expect(meta['cognition.ai/folder']).toBe('Activity Log');
    expect(meta['cognition.ai/rootsOffset']).toBe(20);
    expect(meta['cognition.ai/maxRootsPerFolder']).toBe(20);
    expect(meta).not.toHaveProperty('cognition.ai/limit');
    expect(JSON.stringify(params)).not.toContain('compact');
  });
});

describe('urls', () => {
  it('acpWsUrl converts https to wss and encodes params', () => {
    expect(acpWsUrl('https://tenant.example.com', 't o k', 'o r g')).toBe(
      'wss://tenant.example.com/api/acp/live?token=t%20o%20k&org_id=o%20r%20g',
    );
  });
  it('usersInfoUrl appends /api/users/info', () => {
    expect(usersInfoUrl('https://tenant.example.com/')).toBe(
      'https://tenant.example.com/api/users/info',
    );
  });
});

describe('bareSessionId', () => {
  it('strips the devin- prefix', () => {
    expect(bareSessionId('devin-abc123')).toBe('abc123');
    expect(bareSessionId('abc123')).toBe('abc123');
  });
});

describe('sanitizeToken', () => {
  it('redacts the token', () => {
    expect(sanitizeToken('failed with tok-xyz in url', 'tok-xyz')).toBe(
      'failed with [redacted] in url',
    );
  });
});

const RAW_SESSION = {
  sessionId: 'devin-aaaa0000000000000000000000000001',
  title: 'Do the thing',
  updatedAt: '2026-10-05T09:58:32.215079+00:00',
  cwd: '/repo',
  _meta: {
    'cognition.ai/url': 'https://tenant.example.com/sessions/aaaa0000000000000000000000000001',
    'cognition.ai/sessionStatus': 'running',
    'cognition.ai/statusEnum': 'working',
    'cognition.ai/userActionRequired': null,
    'cognition.ai/folder': 'Activity Log',
    'cognition.ai/isPinned': false,
    'cognition.ai/isUnread': true,
    'cognition.ai/isStarred': false,
    'cognition.ai/isArchived': false,
    'cognition.ai/proposedByDevinId': 'devin-bbbb0000000000000000000000000002',
    'cognition.ai/directChildrenCount': 3,
    'cognition.ai/hasMoreChildren': true,
    'cognition.ai/sessionPRs': [
      { url: 'https://github.com/x/y/pull/1', state: 'open' },
      { url: 'https://github.com/x/y/pull/2', state: 'open', draft: true },
      { url: 'https://github.com/x/y/pull/3', state: 'open', queued: true },
      { url: 'https://github.com/x/y/pull/4', state: 'merged' },
      { url: 'https://github.com/x/y/pull/5', state: 'closed' },
      { url: 'https://github.com/x/y/pull/6', state: 'bogus' },
      'junk',
    ],
    'cognition.ai/sortUpdatedAt': '2026-10-02T12:45:44.533751+00:00',
  },
};

describe('parseListResult', () => {
  const raw = {
    sessions: [
      RAW_SESSION,
      // Folder key absent → folder null.
      {
        sessionId: 'devin-cccc0000000000000000000000000003',
        title: null,
        updatedAt: '2026-10-04T00:00:00Z',
        _meta: { 'cognition.ai/sessionStatus': 'suspended' },
      },
      // Archived sessions parse with isArchived (show-archived opt-in).
      {
        sessionId: 'devin-dddd0000000000000000000000000004',
        _meta: { 'cognition.ai/isArchived': true, 'cognition.ai/sessionStatus': 'exit' },
      },
      // No sessionId → dropped.
      { title: 'broken', _meta: {} },
    ],
    nextCursor: 'cursor-9',
    _meta: {
      'cognition.ai/sidebarFoldersByOrg': { [ORG]: ['Activity Log', 'participated', 'pinned'] },
      'cognition.ai/folderTotals': { 'Activity Log': 2, participated: 5 },
    },
  };

  it('maps wire sessions to CloudSession', () => {
    const result = parseListResult(raw, ORG);
    expect(result.sessions).toHaveLength(3);
    const s = result.sessions[0]!;
    expect(s.id).toBe('aaaa0000000000000000000000000001');
    expect(s.acpId).toBe('devin-aaaa0000000000000000000000000001');
    expect(s.title).toBe('Do the thing');
    expect(s.url).toBe('https://tenant.example.com/sessions/aaaa0000000000000000000000000001');
    expect(s.status).toBe('running');
    expect(s.statusEnum).toBe('working');
    expect(s.folder).toBe('Activity Log');
    expect(s.parentId).toBe('bbbb0000000000000000000000000002');
    expect(s.isPinned).toBe(false);
    expect(s.isUnread).toBe(true);
    expect(s.directChildrenCount).toBe(3);
    expect(s.hasMoreChildren).toBe(true);
    expect(s.prs).toEqual({ open: 1, queued: 1, draft: 1, merged: 1, closed: 1 });
    expect(s.isArchived).toBe(false);
    expect(s.updatedAt).toBe(Date.parse('2026-10-05T09:58:32.215079+00:00'));
  });

  it('reads folders, totals and cursor from _meta', () => {
    const result = parseListResult(raw, ORG);
    expect(result.folders).toEqual(['Activity Log', 'participated', 'pinned']);
    expect(result.folderTotals).toEqual({ 'Activity Log': 2, participated: 5 });
    expect(result.nextCursor).toBe('cursor-9');
    expect(result.sessions[1]!.folder).toBeNull();
    expect(result.sessions[2]!.isArchived).toBe(true);
    expect(result.sessions[1]!.parentId).toBeNull();
  });

  it('returns empty defaults on junk', () => {
    expect(parseListResult(null, ORG)).toEqual({
      sessions: [],
      folders: [],
      folderTotals: {},
      nextCursor: null,
    });
    expect(parseListResult({ sessions: 'nope' }, ORG).sessions).toEqual([]);
  });
});

describe('parseUsersInfo', () => {
  it('extracts user_id', () => {
    expect(parseUsersInfo({ user_id: 'user-1', preferences: {} })).toEqual({
      userId: 'user-1',
    });
    expect(parseUsersInfo({})).toEqual({ userId: null });
  });
});
