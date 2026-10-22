// Side-effect first: bootstrap applies the userData override and migrates
// the legacy profile before this module resolves/mkdirs userData below.
import './bootstrap';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { LOG_MAX_BYTES, rotatedPath, shouldRotate } from '../core/logModel';
import { scrubKnownAliases, scrubSshAliases } from '../core/sshLog';
import { state, testMode, type ViewName } from './state';

type LogEvent = {
  ts: string;
  view: ViewName;
  event: string;
  url?: string | undefined;
  decision?: string | undefined;
  detail?: Record<string, unknown> | undefined;
};

// Resolved at import time, which is before index.ts applies the userData
// override — so honour AGENT_WORKSPACE_USER_DATA here as well.
const userDataDir = process.env.AGENT_WORKSPACE_USER_DATA
  ? resolve(process.env.AGENT_WORKSPACE_USER_DATA)
  : app.getPath('userData');
export const logFile = resolve(
  process.env.AGENT_WORKSPACE_LOG ?? join(userDataDir, 'events.jsonl'),
);
mkdirSync(resolve(logFile, '..'), { recursive: true });

// F2: rotate at 10 MB into a single events.1.jsonl (Q1). Bytes written are
// tracked in-process; size is statSync'd once at startup. The limit is
// overridable in test mode for the rotation e2e.
const logMaxBytes =
  testMode && process.env.AGENT_WORKSPACE_LOG_MAX_BYTES
    ? Number(process.env.AGENT_WORKSPACE_LOG_MAX_BYTES)
    : LOG_MAX_BYTES;
let writtenBytes = 0;
try {
  writtenBytes = statSync(logFile).size;
} catch {
  // fresh profile — file does not exist yet
}

// Outside test mode, URLs are logged without query/hash: IdP callbacks and
// authorize URLs carry one-time codes, state and nonces that must not end up
// in a log file that may later be shared as evidence.
export function redactUrl(value: string): string {
  if (testMode) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}<redacted>`;
    return `${url.origin}${url.pathname}${url.search || url.hash ? '?<redacted>' : ''}`;
  } catch {
    return '<unparseable-url>';
  }
}

/** sha256-8 of the canonical (lower-case) ssh alias — the only form of an alias in the log (P3). */
export function sshAliasHash(alias: string): string {
  return createHash('sha256').update(alias.toLowerCase()).digest('hex').slice(0, 8);
}

function configuredAliases(): string[] {
  try {
    return (state.settings?.current.hosts.ssh ?? []).map((h) => h.alias);
  } catch {
    return [];
  }
}

export function log(
  view: ViewName,
  event: string,
  options: {
    url?: string | undefined;
    decision?: string | undefined;
    detail?: Record<string, unknown> | undefined;
  } = {},
): void {
  const record: LogEvent = {
    ts: new Date().toISOString(),
    view,
    event,
    ...options,
  };
  if (record.url !== undefined) record.url = redactUrl(record.url);
  let line = JSON.stringify(record);
  // An `ssh:<alias>` id or `ssh://<alias>/…` path anywhere in the record
  // becomes `ssh:#<hash>` — the alias itself is never written.
  if (/ssh:/i.test(line)) line = JSON.stringify(scrubSshAliases(record, sshAliasHash));
  // R39 #6: a configured alias as a bare word in free text (an ssh error
  // message, a hostname in an exception) is hashed too.
  const lower = line.toLowerCase();
  const aliases = configuredAliases().filter((alias) => lower.includes(alias));
  if (aliases.length > 0) {
    const parsed = JSON.parse(line) as LogEvent;
    const { ts, view: v, event: e, ...rest } = parsed;
    const scrubbed = scrubKnownAliases(rest, aliases, sshAliasHash);
    if (scrubbed !== rest) line = JSON.stringify({ ts, view: v, event: e, ...scrubbed });
  }
  try {
    if (shouldRotate(writtenBytes, line.length + 1, logMaxBytes)) {
      renameSync(logFile, rotatedPath(logFile));
      writtenBytes = 0;
    }
    appendFileSync(logFile, `${line}\n`, 'utf8');
    writtenBytes += line.length + 1;
  } catch (error) {
    console.error('spike-log-write-failed', String(error));
  }
  try {
    console.log(line);
  } catch {
    // stdout may be a full disk (ENOSPC)
  }
}
