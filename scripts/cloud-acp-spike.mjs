#!/usr/bin/env node
// One-off investigation spike: launch the built app against the real tenant,
// wait for a manual login, then — entirely inside the Electron MAIN process —
// grab the web app's access token and probe REST /users/info and the ACP
// WebSocket endpoint, writing a redacted evidence JSON.
//
// The access token never leaves the main process: everything that touches it
// runs inside app.evaluate and the result is redacted before it returns.
//
// Requires: npm run build (out/main.cjs). Persistent login profile lives in
// os.tmpdir()/agent-workspace-spike (survives across runs — do not delete).

import { _electron } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const TENANT = 'https://cloudbeds.devinenterprise.com';
const USER_DATA = path.join(os.tmpdir(), 'agent-workspace-spike');
const LOG_FILE = path.join(USER_DATA, 'events.jsonl');
const VARIANTS = process.argv.includes('--variants');
const CAPTURE = process.argv.includes('--capture');
const EVIDENCE = path.join(
  process.cwd(),
  'docs',
  'evidence',
  CAPTURE
    ? 'cloud-acp-spike-capture.json'
    : VARIANTS
      ? 'cloud-acp-spike-variants.json'
      : 'cloud-acp-spike.json',
);

const LOGIN_WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;

function writeEvidence(obj) {
  mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(obj, null, 2));
}

// Finds the tenant webContents and executes `script` in it, racing 15 s.
// Runs in main via app.evaluate.
async function evalInTenantView(app, script) {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(args.urlPrefix));
      if (!contents) throw new Error(`No webContents for ${args.urlPrefix}`);
      return Promise.race([
        contents.executeJavaScript(args.script),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('executeJavaScript timed out (15s)')), 15_000),
        ),
      ]);
    },
    { urlPrefix: TENANT, script },
  );
}

async function tenantUrl(app) {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(prefix))
        ?.getURL() ?? null,
    TENANT,
  );
}

const PROBE_FN = async ({ webContents }, args) => {
  const tenantPrefix = args.tenant;
  const variantsMode = Boolean(args.variants);
  const result = {
    mode: variantsMode ? 'variants' : 'default',
    rest: { attempts: [] },
    ws: { requests: [], notifications: [], notificationSamples: [], errors: [] },
  };
  // Strip values under keys ending in 'Contents', containing 'Excerpt',
  // named message fields, or equal to 'title' (recursive).
  const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === 'title' || k.endsWith('Contents') || k.includes('Excerpt')) continue;
        out[k] = sanitize(v);
      }
      return out;
    }
    return value;
  };
  const contents = webContents
    .getAllWebContents()
    .find((candidate) => candidate.getURL().startsWith(tenantPrefix));
  if (!contents) return { fatal: 'tenant webContents not found' };

  const token = await contents.executeJavaScript('window.devinDebug.getAccessToken()');
  const orgId = await contents.executeJavaScript('window.devinDebug.getOrgId()');
  const cfg = JSON.parse(
    await contents.executeJavaScript('JSON.stringify(globalThis.__DEVIN_CONFIG__ ?? {})'),
  );
  result.cfg = {
    keys: Object.keys(cfg),
    API_URL: cfg.API_URL ?? null,
    API_PROXY_URL: cfg.API_PROXY_URL ?? null,
    WEBAPP_HOST: cfg.WEBAPP_HOST ?? null,
  };
  result.orgId = orgId;

  // --- REST probe ---
  const bases = [
    ...(cfg.API_URL ? [cfg.API_URL] : []),
    'https://api.devinenterprise.com',
    `${tenantPrefix}/api`,
  ];
  for (const base of bases) {
    const attempt = { base, status: null };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(`${base.replace(/\/$/, '')}/users/info`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-cog-org-id': orgId,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      attempt.status = res.status;
      if (res.status >= 200 && res.status < 300) {
        const body = await res.json();
        attempt.bodyKeys = Object.keys(body ?? {});
        attempt.preferencesKeys = Object.keys(body?.preferences ?? {});
        attempt.sidebarFoldersByOrg = body?.preferences?.sidebar_folders_by_org ?? null;
        result.rest.successBase = base;
      }
    } catch (error) {
      attempt.error = String(error?.name === 'AbortError' ? 'timeout' : error);
    }
    result.rest.attempts.push(attempt);
    if (result.rest.successBase) break;
  }

  // --- WebSocket probe ---
  if (typeof WebSocket === 'undefined') {
    result.ws.skipped = 'WebSocket global not available in main process';
  } else {
    let wsBase = `${tenantPrefix}/api`.replace(/^http/, 'ws');
    const proxy = cfg.API_PROXY_URL;
    if (typeof proxy === 'string' && /^https?:\/\//.test(proxy)) {
      wsBase = proxy.replace(/\/$/, '').replace(/^http/, 'ws') + '/acp/live';
    } else {
      wsBase = wsBase.replace(/\/$/, '') + '/acp/live';
    }
    const wsUrl = `${wsBase}?token=${encodeURIComponent(token)}&org_id=${encodeURIComponent(orgId)}`;
    result.ws.urlHost = new URL(wsUrl).host; // host only — URL contains the token

    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      result.ws.fatal = `WebSocket constructor threw: ${String(error)}`;
    }

    if (socket) {
      const pending = new Map();
      let closeInfo = null;
      let resolveOpen;
      const opened = new Promise((resolve) => (resolveOpen = resolve));
      socket.addEventListener('open', () => resolveOpen(true));
      socket.addEventListener('error', () => resolveOpen(false));
      socket.addEventListener('close', (event) => {
        closeInfo = { code: event.code, reason: event.reason || null };
        resolveOpen(false);
        for (const { reject } of pending.values()) reject(new Error('ws closed'));
        pending.clear();
      });
      socket.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && typeof msg === 'object' && msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id).resolve(msg);
            pending.delete(msg.id);
          } else if (msg && typeof msg === 'object' && typeof msg.method === 'string') {
            result.ws.notifications.push(msg.method);
            if (result.ws.notificationSamples.length < 3) {
              result.ws.notificationSamples.push(sanitize(msg));
            }
          }
        } catch {
          // non-JSON frame — ignore
        }
      });

      const openOk = await Promise.race([
        opened,
        new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
      ]);
      if (!openOk && socket.readyState !== WebSocket.OPEN) {
        result.ws.fatal = 'ws failed to open within 20s';
      }

      const request = (id, method, params) =>
        new Promise((resolve) => {
          if (socket.readyState !== WebSocket.OPEN) {
            resolve({ id, transportError: 'ws not open' });
            return;
          }
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ id, transportError: 'timeout (20s)' });
          }, 20_000);
          pending.set(id, {
            resolve: (msg) => {
              clearTimeout(timer);
              resolve(msg);
            },
            reject: (error) => {
              clearTimeout(timer);
              resolve({ id, transportError: String(error) });
            },
          });
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });

      // Shared summariser for session/list responses — redacted fields only,
      // no titles and nothing under a *Contents key.
      const summarizeSessions = (sessions) => {
        const sessionKeys = new Set();
        const metaKeys = new Set();
        let firstFolder = null;
        let folderSampleMeta = null;
        let withFolderKey = 0;
        let pinnedCount = 0;
        let directChildrenGt0 = 0;
        let proposedByCount = 0;
        let firstIdWithChildren = null;
        const folderCounts = {};
        const perSession = sessions.map((s) => {
          Object.keys(s ?? {}).forEach((k) => sessionKeys.add(k));
          const meta = s?._meta ?? {};
          Object.keys(meta).forEach((k) => metaKeys.add(k));
          const hasFolderKey = 'cognition.ai/folder' in meta;
          if (hasFolderKey) withFolderKey++;
          const folder = meta['cognition.ai/folder'] ?? null;
          folderCounts[folder === null ? 'null' : String(folder)] =
            (folderCounts[folder === null ? 'null' : String(folder)] ?? 0) + 1;
          if (folder && !firstFolder) firstFolder = folder;
          if (!folderSampleMeta && hasFolderKey) folderSampleMeta = sanitize(meta);
          if ((meta['cognition.ai/isPinned'] ?? s?.isPinned) === true) pinnedCount++;
          if (meta['cognition.ai/proposedByDevinId'] != null) proposedByCount++;
          const dcc = meta['cognition.ai/directChildrenCount'] ?? s?.directChildrenCount;
          if (typeof dcc === 'number' && dcc > 0) {
            directChildrenGt0++;
            if (!firstIdWithChildren) firstIdWithChildren = s?.sessionId ?? s?.id ?? null;
          }
          return {
            sessionId: s?.sessionId ?? s?.id ?? null,
            folder,
            isPinned: meta['cognition.ai/isPinned'] ?? null,
            isStarred: meta['cognition.ai/isStarred'] ?? null,
            isUnread: meta['cognition.ai/isUnread'] ?? null,
            isDone: meta['cognition.ai/isDoneForViewer'] ?? null,
            parentId:
              meta['cognition.ai/proposedByDevinId'] ??
              meta['cognition.ai/parentSessionId'] ??
              meta['cognition.ai/parentDevinId'] ??
              null,
            directChildrenCount: meta['cognition.ai/directChildrenCount'] ?? null,
            totalChildrenCount: meta['cognition.ai/totalChildrenCount'] ?? null,
            hasMoreChildren: meta['cognition.ai/hasMoreChildren'] ?? null,
            status: meta['cognition.ai/sessionStatus'] ?? null,
            updatedAt: s?.updatedAt ?? meta['cognition.ai/updatedAt'] ?? null,
          };
        });
        return {
          sessions: perSession,
          sessionKeyUnion: [...sessionKeys],
          sessionMetaKeyUnion: [...metaKeys],
          firstFolder,
          folderSampleMeta,
          withFolderKey,
          folderCounts,
          pinnedCount,
          proposedByCount,
          directChildrenGt0,
          firstIdWithChildren,
        };
      };
      const extractSessions = (res) =>
        Array.isArray(res?.sessions) ? res.sessions : Array.isArray(res?.items) ? res.items : [];

      if (!result.ws.fatal) {
        // id 1: initialize
        const init = await request(1, 'initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'agent-workspace-spike', version: '0.0.0' },
          clientCapabilities: variantsMode
            ? { _meta: { 'cognition.ai/sessionListFolders': true } }
            : {},
        });
        if (init.error) {
          result.ws.errors.push({ id: 1, code: init.error.code, message: init.error.message });
        } else if (init.result) {
          result.ws.requests.push({
            id: 1,
            method: 'initialize',
            resultKeys: Object.keys(init.result),
            agentCapabilities: init.result.agentCapabilities ?? null,
            metaKeys: Object.keys(init.result._meta ?? {}),
            sidebarFoldersByOrg:
              init.result._meta?.['cognition.ai/sidebarFoldersByOrg'] ?? null,
          });
        } else {
          result.ws.requests.push({ id: 1, method: 'initialize', raw: init });
        }

        if (variantsMode) {
          // Probe many session/list request shapes to find one that returns data.
          // All keys inside _meta carry the 'cognition.ai/' prefix.
          const M = 'cognition.ai/';
          const meta = (o) => {
            const out = {};
            for (const [k, v] of Object.entries(o)) out[`${M}${k}`] = v;
            return { _meta: out };
          };
          const sidebarMeta = (extra = {}) =>
            meta({
              archivedStatus: 'ACTIVE',
              orgIds: [orgId],
              includePinned: true,
              groupChildren: true,
              limit: 50,
              maxChildrenPerRoot: 8,
              maxRootsPerFolder: 10,
              messageSnippetLength: 50,
              orderBy: 'updated_at',
              ...extra,
            });
          const folderPageMeta = (archivedStatus) =>
            meta({
              archivedStatus,
              orgIds: [orgId],
              includePinned: true,
              groupChildren: true,
              folder: 'Activity Log',
              maxRootsPerFolder: 10,
              rootsOffset: 0,
              childrenDirect: true,
              maxChildrenPerRoot: 8,
            });
          const webShapeMeta = (extra = {}) =>
            meta({
              archivedStatus: 'ACTIVE',
              orgIds: [orgId],
              hideCodeScans: true,
              foldersExcludeArchived: true,
              sessionType: ['devin'],
              orderBy: 'updated_at',
              sortDirection: 'desc',
              includePinned: true,
              groupChildren: true,
              limit: 30,
              maxChildrenPerRoot: 8,
              maxRootsPerFolder: 10,
              messageSnippetLength: 50,
              childrenDirect: true,
              ...extra,
            });
          const variants = [
            { label: 'bare', params: {} },
            { label: 'sidebar-full', params: sidebarMeta() },
            { label: 'web-shape', params: webShapeMeta(), keepSessions: true },
            { label: 'web-shape-compact', params: webShapeMeta({ compact: true }) },
            { label: 'folder-page', params: folderPageMeta('ACTIVE') },
            { label: 'folder-page-ALL', params: folderPageMeta('ALL') },
            // 'children-of-root' appended below once a session with children is seen
          ];

          let id = 2;
          let runSampleMeta = null; // first session _meta (sanitised) with a folder key
          let firstSessionIdWithChildren = null;
          for (const variant of variants) {
            if (variant.skip) {
              result.ws.requests.push({ id: id++, label: variant.label, skipped: variant.skip });
              continue;
            }
            const recordedParams = JSON.parse(JSON.stringify(variant.params));
            const response = await request(id, 'session/list', variant.params);
            const entry = { id, label: variant.label, params: recordedParams };
            id++;
            if (response.transportError) {
              entry.transportError = response.transportError;
            } else if (response.error) {
              entry.error = { code: response.error.code, message: response.error.message };
            } else if (response.result) {
              const sessions = extractSessions(response.result);
              entry.resultKeys = Object.keys(response.result);
              entry.metaKeys = Object.keys(response.result._meta ?? {});
              entry.sessionCount = sessions.length;
              entry.hasNextCursor = Boolean(response.result.nextCursor);
              entry.folderTotals =
                response.result._meta?.[`${M}folderTotals`] ?? null;
              entry.listSidebarFolders =
                response.result._meta?.[`${M}sidebarFoldersByOrg`] ?? null;
              if (sessions.length) {
                const summary = summarizeSessions(sessions);
                entry.sessionKeyUnion = summary.sessionKeyUnion;
                entry.sessionMetaKeyUnion = summary.sessionMetaKeyUnion;
                entry.withFolderKey = summary.withFolderKey;
                entry.folderCounts = summary.folderCounts;
                entry.pinnedCount = summary.pinnedCount;
                entry.proposedByCount = summary.proposedByCount;
                entry.directChildrenGt0 = summary.directChildrenGt0;
                if (!runSampleMeta && summary.folderSampleMeta) {
                  runSampleMeta = summary.folderSampleMeta;
                }
                if (!firstSessionIdWithChildren && summary.firstIdWithChildren) {
                  firstSessionIdWithChildren = summary.firstIdWithChildren;
                }
                if (variant.keepSessions) entry.sessions = summary.sessions;
              }
            } else {
              entry.raw = response;
            }
            result.ws.requests.push(entry);
          }

          // children-of-root: only if an earlier variant produced a session
          // with directChildrenCount > 0.
          const childrenEntry = { id, label: 'children-of-root' };
          id++;
          if (!firstSessionIdWithChildren) {
            childrenEntry.skipped = 'no session with directChildrenCount > 0 in earlier variants';
          } else {
            const params = meta({
              archivedStatus: 'ALL',
              sessionIds: [firstSessionIdWithChildren],
              groupChildren: true,
              childrenDirect: true,
              maxChildrenPerRoot: 20,
            });
            childrenEntry.params = params;
            childrenEntry.rootSessionId = firstSessionIdWithChildren;
            const response = await request(childrenEntry.id, 'session/list', params);
            if (response.transportError) {
              childrenEntry.transportError = response.transportError;
            } else if (response.error) {
              childrenEntry.error = { code: response.error.code, message: response.error.message };
            } else if (response.result) {
              const sessions = extractSessions(response.result);
              const parentKeys = new Set();
              let proposedByCount = 0;
              for (const s of sessions) {
                for (const k of Object.keys(s?._meta ?? {})) {
                  if (/parent/i.test(k)) parentKeys.add(k);
                }
                for (const k of Object.keys(s ?? {})) {
                  if (/parent/i.test(k)) parentKeys.add(k);
                }
                if (s?._meta?.['cognition.ai/proposedByDevinId'] != null) proposedByCount++;
              }
              childrenEntry.resultKeys = Object.keys(response.result);
              childrenEntry.metaKeys = Object.keys(response.result._meta ?? {});
              childrenEntry.sessionCount = sessions.length;
              childrenEntry.parentMetaKeyUnion = [...parentKeys];
              childrenEntry.proposedByCount = proposedByCount;
              childrenEntry.allChildrenOfRoot =
                sessions.length > 0 &&
                sessions.every(
                  (s) => s?._meta?.['cognition.ai/proposedByDevinId'] === firstSessionIdWithChildren,
                );
            } else {
              childrenEntry.raw = response;
            }
          }
          result.ws.requests.push(childrenEntry);
          if (runSampleMeta) result.ws.sampleSessionMeta = runSampleMeta;
        } else {
        const listMeta = {
          'cognition.ai/archivedStatus': 'ACTIVE',
          'cognition.ai/orgIds': [orgId],
          'cognition.ai/limit': 50,
          'cognition.ai/orderBy': 'updated_at',
          'cognition.ai/sortDirection': 'desc',
          'cognition.ai/compact': true,
        };

        // id 2: session/list
        const list = await request(2, 'session/list', { _meta: listMeta });
        let firstFolder = null;
        if (list.error) {
          result.ws.errors.push({ id: 2, code: list.error.code, message: list.error.message });
        } else if (list.result) {
          const sessions = Array.isArray(list.result.sessions)
            ? list.result.sessions
            : Array.isArray(list.result.items)
              ? list.result.items
              : [];
          const sessionKeys = new Set();
          const metaKeys = new Set();
          const perSession = sessions.map((s) => {
            Object.keys(s ?? {}).forEach((k) => sessionKeys.add(k));
            const meta = s?._meta ?? {};
            Object.keys(meta).forEach((k) => metaKeys.add(k));
            const folder = meta['cognition.ai/folder'] ?? null;
            if (folder && !firstFolder) firstFolder = folder;
            return {
              sessionId: s?.sessionId ?? s?.id ?? null,
              folder,
              isPinned: meta['cognition.ai/isPinned'] ?? null,
              isStarred: meta['cognition.ai/isStarred'] ?? null,
              isUnread: meta['cognition.ai/isUnread'] ?? null,
              isDone: meta['cognition.ai/isDoneForViewer'] ?? null,
              parentId: meta['cognition.ai/parentSessionId'] ?? meta['cognition.ai/parentDevinId'] ?? null,
              directChildrenCount: meta['cognition.ai/directChildrenCount'] ?? null,
              totalChildrenCount: meta['cognition.ai/totalChildrenCount'] ?? null,
              hasMoreChildren: meta['cognition.ai/hasMoreChildren'] ?? null,
              status: meta['cognition.ai/sessionStatus'] ?? null,
              updatedAt: s?.updatedAt ?? meta['cognition.ai/updatedAt'] ?? null,
            };
          });
          result.ws.requests.push({
            id: 2,
            method: 'session/list',
            resultKeys: Object.keys(list.result),
            metaKeys: Object.keys(list.result._meta ?? {}),
            folderTotals: list.result._meta?.['cognition.ai/folderTotals'] ?? null,
            hasNextCursor: Boolean(list.result.nextCursor),
            sessionCount: sessions.length,
            sessionKeyUnion: [...sessionKeys],
            sessionMetaKeyUnion: [...metaKeys],
            sessions: perSession,
          });
        } else {
          result.ws.requests.push({ id: 2, method: 'session/list', raw: list });
        }

        // id 3: session/list grouped by folder
        const grouped = await request(3, 'session/list', {
          _meta: { ...listMeta, 'cognition.ai/groupBy': 'folder' },
        });
        if (grouped.error) {
          result.ws.errors.push({ id: 3, code: grouped.error.code, message: grouped.error.message });
        } else if (grouped.result) {
          result.ws.requests.push({
            id: 3,
            method: 'session/list groupBy=folder',
            resultKeys: Object.keys(grouped.result),
            metaKeys: Object.keys(grouped.result._meta ?? {}),
            groups: grouped.result._meta?.['cognition.ai/groups'] ?? null,
            groupWindow: grouped.result._meta?.['cognition.ai/groupWindow'] ?? null,
          });
        } else {
          result.ws.requests.push({ id: 3, method: 'session/list groupBy=folder', raw: grouped });
        }

        // id 4: filter by first seen folder (only if we saw one)
        if (firstFolder) {
          const filtered = await request(4, 'session/list', {
            _meta: { ...listMeta, 'cognition.ai/folder': firstFolder },
          });
          if (filtered.error) {
            result.ws.errors.push({
              id: 4,
              code: filtered.error.code,
              message: filtered.error.message,
            });
          } else if (filtered.result) {
            const sessions = Array.isArray(filtered.result.sessions)
              ? filtered.result.sessions
              : Array.isArray(filtered.result.items)
                ? filtered.result.items
                : [];
            result.ws.requests.push({
              id: 4,
              method: 'session/list folder=<firstFolder>',
              filterFolder: firstFolder,
              count: sessions.length,
              allMatchFolder: sessions.every(
                (s) => (s?._meta?.['cognition.ai/folder'] ?? null) === firstFolder,
              ),
            });
          } else {
            result.ws.requests.push({ id: 4, method: 'session/list folder', raw: filtered });
          }
        }
        }
      }

      result.ws.closedEarly = closeInfo;
      result.ws.stillOpen = socket.readyState === WebSocket.OPEN;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  // Redact: the token must never cross back to the node process.
  let json = JSON.stringify(result);
  if (token && json.includes(token)) {
    json = json.split(token).join('[redacted]');
    const parsed = JSON.parse(json);
    parsed.redactionHit = true;
    return parsed;
  }
  return result;
};

// --capture mode: attach the CDP debugger to the tenant webContents, reload
// the page, and passively record the web app's own ACP websocket traffic plus
// REST request pathnames. The token is read only to redact it from the result.
const CAPTURE_FN = async ({ webContents }, args) => {
  const tenantPrefix = args.tenant;
  const result = {
    mode: 'capture',
    sockets: [],
    sent: [],
    listResponses: [],
    otherResponses: [],
    notifications: [],
    notificationSamples: [],
    restRequests: [],
  };
  const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === 'title' || k.endsWith('Contents') || k.includes('Excerpt')) continue;
        out[k] = sanitize(v);
      }
      return out;
    }
    return value;
  };
  const sanitizeParams = (value) => {
    if (Array.isArray(value)) return value.map(sanitizeParams);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = /participant|creators|userId|user_id/i.test(k) ? '[set]' : sanitizeParams(v);
      }
      return out;
    }
    return value;
  };

  const contents = webContents
    .getAllWebContents()
    .find((candidate) => candidate.getURL().startsWith(tenantPrefix));
  if (!contents) return { fatal: 'tenant webContents not found' };

  const token = await contents.executeJavaScript('window.devinDebug.getAccessToken()');

  try {
    contents.debugger.attach('1.3');
  } catch (error) {
    result.captureError = `debugger.attach failed: ${String(error)}`;
    return result;
  }

  try {
    await contents.debugger.sendCommand('Network.enable');
  } catch (error) {
    result.captureError = `Network.enable failed: ${String(error)}`;
  }

  const sentMethods = new Map(); // msg.id -> method
  const restById = new Map(); // requestId -> index in result.restRequests

  contents.debugger.on('message', (_event, method, params) => {
    try {
      if (method === 'Network.webSocketCreated') {
        let pathname = null;
        try {
          pathname = new URL(params.url).pathname;
        } catch {
          pathname = '(unparseable)';
        }
        result.sockets.push({ requestId: params.requestId, pathname });
      } else if (method === 'Network.webSocketFrameSent') {
        let msg;
        try {
          msg = JSON.parse(params?.response?.payloadData ?? 'null');
        } catch {
          return;
        }
        if (msg && typeof msg === 'object' && typeof msg.method === 'string') {
          if (msg.id != null) sentMethods.set(msg.id, msg.method);
          if (result.sent.length < 200) {
            result.sent.push({
              id: msg.id ?? null,
              method: msg.method,
              params: sanitizeParams(msg.params),
            });
          }
        }
      } else if (method === 'Network.webSocketFrameReceived') {
        let msg;
        try {
          msg = JSON.parse(params?.response?.payloadData ?? 'null');
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.id != null) {
          const sentMethod = sentMethods.get(msg.id) ?? null;
          const res = msg.result;
          const sessions = Array.isArray(res?.sessions)
            ? res.sessions
            : Array.isArray(res?.items)
              ? res.items
              : [];
          if (sentMethod === 'session/list' && res && result.listResponses.length < 50) {
            const sessionKeys = new Set();
            const metaKeys = new Set();
            let withFolderKey = 0;
            let proposedByCount = 0;
            let sampleSessionMeta = null;
            const folderCounts = {};
            for (const s of sessions) {
              Object.keys(s ?? {}).forEach((k) => sessionKeys.add(k));
              const meta = s?._meta ?? {};
              Object.keys(meta).forEach((k) => metaKeys.add(k));
              if ('cognition.ai/folder' in meta) {
                withFolderKey++;
                if (!sampleSessionMeta) sampleSessionMeta = sanitize(meta);
              }
              const folder = meta['cognition.ai/folder'] ?? null;
              const fkey = folder === null ? 'null' : String(folder);
              folderCounts[fkey] = (folderCounts[fkey] ?? 0) + 1;
              if (meta['cognition.ai/proposedByDevinId'] != null) proposedByCount++;
            }
            result.listResponses.push({
              id: msg.id,
              resultKeys: Object.keys(res),
              metaKeys: Object.keys(res._meta ?? {}),
              folderTotals: res._meta?.['cognition.ai/folderTotals'] ?? null,
              sessionCount: sessions.length,
              sessionKeyUnion: [...sessionKeys],
              sessionMetaKeyUnion: [...metaKeys],
              withFolderKey,
              folderCounts,
              proposedByCount,
              sampleSessionMeta,
            });
          } else if (result.otherResponses.length < 300) {
            result.otherResponses.push({
              id: msg.id,
              method: sentMethod,
              resultKeys: res && typeof res === 'object' ? Object.keys(res) : null,
              metaKeys:
                res && typeof res === 'object' && res._meta ? Object.keys(res._meta) : null,
            });
          }
        } else if (typeof msg.method === 'string') {
          result.notifications.push(msg.method);
          if (result.notificationSamples.length < 5) {
            result.notificationSamples.push(sanitize(msg));
          }
        }
      } else if (method === 'Network.requestWillBeSent') {
        const url = params?.request?.url;
        if (typeof url !== 'string') return;
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return;
        }
        if (parsed.host !== 'api.devinenterprise.com' && !parsed.pathname.startsWith('/api/')) {
          return;
        }
        if (result.restRequests.length < 300) {
          const entry = {
            method: params.request.method,
            pathname: parsed.pathname,
            searchKeys: [...new URLSearchParams(parsed.search).keys()].join(','),
          };
          result.restRequests.push(entry);
          restById.set(params.requestId, result.restRequests.length - 1);
        }
      } else if (method === 'Network.responseReceived') {
        const idx = restById.get(params?.requestId);
        if (idx != null && result.restRequests[idx]) {
          result.restRequests[idx].status = params.response?.status ?? null;
        }
      }
    } catch {
      // malformed frame — skip
    }
  });

  try {
    await contents.reload();
  } catch (error) {
    result.captureError = `reload failed: ${String(error)}`;
  }
  await new Promise((resolve) => setTimeout(resolve, 45_000));

  if (contents.getURL().startsWith(tenantPrefix)) {
    try {
      result.devinDebugAfterReload = await Promise.race([
        contents.executeJavaScript("window.devinDebug ? 'ok' : 'none'"),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
    } catch (error) {
      result.devinDebugAfterReload = `error: ${String(error)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  try {
    contents.debugger.detach();
  } catch {
    // already detached
  }

  // Redact: the token must never cross back to the node process.
  let json = JSON.stringify(result);
  if (token && json.includes(token)) {
    json = json.split(token).join('[redacted]');
    const parsed = JSON.parse(json);
    parsed.redactionHit = true;
    return parsed;
  }
  return result;
};

async function closeApp(app) {
  try {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.quit()),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    // connection gone or hung — fall through
  }
  try {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  } catch {
    // kill below covers a lingering process
  }
  try {
    const proc = app.process();
    if (proc && proc.exitCode === null && !proc.killed) proc.kill();
  } catch {
    // no process handle available
  }
}

async function main() {
  const app = await _electron.launch({
    args: [process.cwd()],
    timeout: 30_000,
    env: {
      ...process.env,
      AGENT_WORKSPACE_TEST: '1',
      AGENT_WORKSPACE_USER_DATA: USER_DATA,
      AGENT_WORKSPACE_LOG: LOG_FILE,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });

  try {
    console.log('Log in to the Devin window that just opened…');

    const deadline = Date.now() + LOGIN_WAIT_MS;
    let loggedIn = false;
    let nonLoginSince = null;
    let debugHints = null;

    while (Date.now() < deadline) {
      let status;
      try {
        status = await evalInTenantView(
          app,
          "typeof window.devinDebug?.getAccessToken === 'function' ? window.devinDebug.getAccessToken().then(t => Boolean(t)) : 'no-devinDebug'",
        );
      } catch {
        status = 'no-view';
      }
      if (status === true) {
        loggedIn = true;
        break;
      }

      // If devinDebug is missing for >60 s after the URL stops looking like a
      // login page, collect storage/cookie/config key names once for evidence.
      const url = await tenantUrl(app);
      const looksLikeLogin = typeof url === 'string' && /login|signin|auth/i.test(url);
      if (status === 'no-devinDebug' && !looksLikeLogin && url) {
        if (nonLoginSince === null) nonLoginSince = Date.now();
        if (!debugHints && Date.now() - nonLoginSince > 60_000) {
          try {
            debugHints = await app.evaluate(
              async ({ webContents }, prefix) => {
                const contents = webContents
                  .getAllWebContents()
                  .find((candidate) => candidate.getURL().startsWith(prefix));
                if (!contents) return null;
                const [lsKeys, configKeys] = await Promise.all([
                  contents.executeJavaScript('Object.keys(localStorage)'),
                  contents.executeJavaScript(
                    'Object.keys(globalThis.__DEVIN_CONFIG__ ?? {})',
                  ),
                ]);
                const cookies = await contents.session.cookies.get({});
                return {
                  url: contents.getURL(),
                  localStorageKeys: lsKeys,
                  cookieNames: cookies.map((c) => c.name),
                  devinConfigKeys: configKeys,
                };
              },
              TENANT,
            );
          } catch (error) {
            debugHints = { error: String(error) };
          }
        }
      } else {
        nonLoginSince = null;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    if (!loggedIn) {
      const out = { at: new Date().toISOString(), fatal: 'login wait timed out', debugHints };
      writeEvidence(out);
      console.error('Timed out waiting for login — evidence written to', EVIDENCE);
      return 1;
    }

    console.log(
      CAPTURE
        ? 'Login detected — capturing the web app’s own ACP traffic via CDP…'
        : 'Login detected — running probes inside the main process…',
    );
    const result = CAPTURE
      ? await app.evaluate(CAPTURE_FN, { tenant: TENANT })
      : await app.evaluate(PROBE_FN, { tenant: TENANT, variants: VARIANTS });
    if (debugHints) result.debugHints = debugHints;

    writeEvidence({ at: new Date().toISOString(), ...result });
    console.log('Evidence written to', EVIDENCE);

    // stdout summary — redacted values only.
    if (CAPTURE) {
      if (result?.captureError) console.log('captureError:', result.captureError);
      console.log('sockets:', JSON.stringify(result?.sockets ?? []));
      for (const s of result?.sent ?? []) {
        if (s.method === 'session/list') {
          console.log(`sent session/list id=${s.id} params=${JSON.stringify(s.params)}`);
        }
      }
      for (const r of result?.listResponses ?? []) {
        console.log(
          `recv id=${r.id} count=${r.sessionCount} withFolderKey=${r.withFolderKey} folderTotals=${JSON.stringify(r.folderTotals)} proposedBy=${r.proposedByCount} metaKeys=[${(r.metaKeys ?? []).join(',')}]`,
        );
      }
      const seen = new Map();
      for (const r of result?.restRequests ?? []) {
        if (/(folder|sessions)/i.test(r.pathname) && !seen.has(r.pathname)) {
          seen.set(r.pathname, r);
        }
      }
      for (const r of seen.values()) {
        console.log(`REST ${r.method} ${r.pathname} → ${r.status ?? '?'}`);
      }
      console.log(
        `capture totals: sent=${result?.sent?.length ?? 0} listResponses=${result?.listResponses?.length ?? 0} otherResponses=${result?.otherResponses?.length ?? 0} restRequests=${result?.restRequests?.length ?? 0} notifications=${result?.notifications?.length ?? 0}`,
      );
      if (result?.devinDebugAfterReload != null) {
        console.log('devinDebug after reload:', result.devinDebugAfterReload);
      }
    }
    const restOk = result?.rest?.attempts?.find((a) => a.status >= 200 && a.status < 300);
    console.log('REST:', result?.rest?.attempts?.map((a) => `${a.base} → ${a.status ?? a.error}`).join(', ') ?? 'n/a');
    if (restOk?.sidebarFoldersByOrg != null) {
      console.log('sidebar_folders_by_org:', JSON.stringify(restOk.sidebarFoldersByOrg));
    }
    if (result?.ws?.skipped) console.log('WS skipped:', result.ws.skipped);
    if (result?.ws?.fatal) console.log('WS fatal:', result.ws.fatal);
    for (const req of result?.ws?.requests ?? []) {
      if (req.label) {
        // variants mode: one line per variant
        console.log(
          `${req.label} → ${req.skipped ? `skipped (${req.skipped})` : `count=${req.sessionCount ?? '-'} withFolderKey=${req.withFolderKey ?? '-'} proposedBy=${req.proposedByCount ?? '-'} folderTotals=${req.folderTotals != null ? JSON.stringify(req.folderTotals) : 'null'} listSidebarFolders=${req.listSidebarFolders != null ? 'present' : 'null'} metaKeys=[${(req.metaKeys ?? []).join(',')}] error=${req.error ? JSON.stringify(req.error) : req.transportError ?? 'none'}`}`,
        );
      } else if (req.method === 'initialize') {
        console.log(
          'WS initialize ok:',
          req.resultKeys?.length > 0,
          '| metaKeys:', req.metaKeys,
          '| sidebarFoldersByOrg:', req.sidebarFoldersByOrg != null ? 'present' : 'null',
        );
      } else if (req.id === 2) {
        console.log('session/list: count =', req.sessionCount, '| folderTotals =', JSON.stringify(req.folderTotals));
      } else if (req.id === 3) {
        console.log('groupBy=folder: groups =', JSON.stringify(req.groups), '| groupWindow =', JSON.stringify(req.groupWindow));
      } else if (req.id === 4) {
        console.log(`folder filter "${req.filterFolder}": count = ${req.count}, allMatch = ${req.allMatchFolder}`);
      }
    }
    console.log('WS notifications:', result?.ws?.notifications ?? []);
    if (result?.ws?.errors?.length) console.log('WS errors:', JSON.stringify(result.ws.errors));
    if (result?.ws?.closedEarly) console.log('WS closed early:', JSON.stringify(result.ws.closedEarly));
    if (result?.redactionHit) console.log('NOTE: redaction hit — token appeared in result and was scrubbed');
    return 0;
  } finally {
    await closeApp(app);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    try {
      writeEvidence({ at: new Date().toISOString(), fatal: String(error?.stack ?? error) });
    } catch {
      // evidence dir may not be writable
    }
    console.error('Fatal:', error);
    process.exit(1);
  });
