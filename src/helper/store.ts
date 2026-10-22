// store.* methods: the Agent SDK's session-store functions, run natively in
// the distro. The SDK resolves the config dir from process.env.CLAUDE_CONFIG_DIR
// (else ~/.claude) at call time — the same dir `configDir` names here.

import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  renameSession,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { STORE_MESSAGES_PAGE } from '../core/hostRpc';
import { optInt, optStr, str, type Handler } from './params';
import type { WatchChange } from './watch';

export const MESSAGES_PAGE_MAX = STORE_MESSAGES_PAGE;

export type StoreChanged = { files: string[]; sessions: SDKSessionInfo[]; removed: string[] };

// SDK mutations resolve void; `undefined` would drop `result` from the frame.
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function page(params: unknown): { offset?: number; limit: number } {
  const offset = optInt(params, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = optInt(params, 'limit', 1, MESSAGES_PAGE_MAX) ?? MESSAGES_PAGE_MAX;
  return offset === undefined ? { limit } : { offset, limit };
}

/** `<projects>/<encoded-cwd>/<id>.jsonl` (linux path), null when absent. */
export async function transcriptPath(projectsDir: string, id: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(projectsDir, project, `${id}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* not in this project dir */
    }
  }
  return null;
}

/** Session id a watch-relative file belongs to: `<p>/<id>.jsonl` or `<p>/<id>/subagents/<f>`. */
export function sessionIdOfFile(file: string): string | null {
  const parts = file.split('/');
  if (parts.length === 2 && parts[1]!.endsWith('.jsonl')) return parts[1]!.slice(0, -'.jsonl'.length);
  if (parts.length === 4 && parts[2] === 'subagents') return parts[1]!;
  return null;
}

/** Watch change → `store.changed` params: SDK info for every changed id whose transcript still exists. */
export async function changePayload(projectsDir: string, change: WatchChange): Promise<StoreChanged> {
  const ids = new Set<string>();
  for (const file of change.files) {
    const id = sessionIdOfFile(file);
    if (id && !change.removed.includes(id)) ids.add(id);
  }
  const sessions: SDKSessionInfo[] = [];
  for (const id of ids) {
    const parts = change.files.find((f) => sessionIdOfFile(f) === id)!.split('/');
    if (!existsSync(join(projectsDir, parts[0]!, `${id}.jsonl`))) continue;
    try {
      const info = await getSessionInfo(id);
      if (info) sessions.push(info);
    } catch {
      // unreadable mid-write; the next change re-reports it
    }
  }
  return { files: change.files, sessions, removed: change.removed };
}

export function storeHandlers(configDir: string): Record<string, Handler> {
  const projectsDir = join(configDir, 'projects');
  return {
    'store.list': () => listSessions({ includeProgrammatic: true }),
    'store.rename': async (p) => orNull(await renameSession(str(p, 'sessionId'), str(p, 'title'))),
    'store.fork': (p) => {
      const upToMessageId = optStr(p, 'upToMessageId');
      const title = optStr(p, 'title');
      return forkSession(str(p, 'sessionId'), {
        ...(upToMessageId ? { upToMessageId } : {}),
        ...(title ? { title } : {}),
      });
    },
    'store.delete': async (p) => orNull(await deleteSession(str(p, 'sessionId'))),
    'store.listSubagents': (p) => listSubagents(str(p, 'sessionId')),
    'store.messages': (p) => {
      const sessionId = str(p, 'sessionId');
      return getSessionMessages(sessionId, page(p));
    },
    'store.subagentMessages': (p) => {
      const sessionId = str(p, 'sessionId');
      const agentId = str(p, 'agentId');
      return getSubagentMessages(sessionId, agentId, page(p));
    },
    // `rel` (`<project>/<id>.jsonl`, `/`-separated) lets the app rebuild the
    // path under its own view of the config dir.
    'store.transcriptPath': async (p) => {
      const path = await transcriptPath(projectsDir, str(p, 'sessionId'));
      return { path, rel: path === null ? null : relative(projectsDir, path).split(/[\\/]/).join('/') };
    },
  };
}
