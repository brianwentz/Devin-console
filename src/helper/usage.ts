// usage.* methods: the Claude analytics reads, run natively in the distro so
// the app never reads transcripts or credentials over \\wsl.localhost.
// usage.scan folds transcripts with the same core/claudeUsage.ts helpers the
// app uses for its local store; the per-file offset cache lives in helper
// memory only (a restarted helper rescans in full).

import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import {
  aggregateUsageLines,
  fileMayContainMonths,
  fileScanPlan,
  isValidTimeZone,
  mergeBuckets,
  type UsageBuckets,
} from '../core/claudeUsage';
import { RpcError, type Handler } from './params';

const SCAN_WORKERS = 6;
const MAX_MONTHS = 24;
const MONTH_RE = /^\d{4}-\d{2}$/;
/** The CLI's `.usage-cache` is a small JSON body; anything bigger is not it. */
const MAX_USAGE_CACHE_BYTES = 1024 * 1024;

interface FileEntry {
  size: number;
  mtime: number;
  offset: number;
  buckets: UsageBuckets;
}

export interface UsageScanResult {
  buckets: UsageBuckets;
  files: number;
  changed: number;
  skipped: number;
}

export interface UsageAccounts {
  accessToken: string | null;
  expiresAt: number | null;
  plan: string | null;
  email: string | null;
  org: string | null;
  usageCache: { body: string; mtimeMs: number } | null;
}

async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith('.jsonl')) out.push(path);
    }
  }
  return out;
}

async function byteAt(path: string, pos: number): Promise<number> {
  try {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(1);
      const { bytesRead } = await handle.read(buf, 0, 1, pos);
      return bytesRead === 1 ? buf[0]! : -1;
    } finally {
      await handle.close();
    }
  } catch {
    return -1;
  }
}

function pick(buckets: UsageBuckets, months: Set<string>): UsageBuckets {
  const out: UsageBuckets = {};
  for (const [month, bucket] of Object.entries(buckets)) if (months.has(month)) out[month] = bucket;
  return out;
}

export class UsageScanner {
  private readonly cache = new Map<string, FileEntry>();
  /** Zone the cached buckets are keyed in; a different zone drops the cache. */
  private cacheZone: string | undefined;
  /** One walk at a time: an identical overlapping request (e.g. the app's next
   * pass after its 60 s timeout gave up on this one) joins the running walk. */
  private inflight: { key: string; promise: Promise<UsageScanResult> } | null = null;
  /** Transcript bytes read so far (tests assert incremental reads). */
  bytesRead = 0;

  constructor(private readonly projectsDir: string) {}

  /** Lines in [offset, size) — never past the size the plan was made for. */
  private async readLines(path: string, offset: number, size: number): Promise<string[]> {
    if (size <= offset) return [];
    const stream = createReadStream(path, { start: offset, end: size - 1 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    try {
      for await (const line of rl) if (line) lines.push(line);
    } finally {
      rl.close();
      this.bytesRead += stream.bytesRead;
    }
    return lines;
  }

  scan(monthList: string[], timeZone?: string): Promise<UsageScanResult> {
    const key = JSON.stringify([monthList, timeZone ?? null]);
    if (this.inflight?.key === key) return this.inflight.promise;
    const previous = this.inflight?.promise;
    const promise = (async () => {
      // A different request waits for the running walk instead of overlapping it.
      if (previous) await previous.catch(() => undefined);
      return this.walk(monthList, timeZone);
    })().finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { key, promise };
    return promise;
  }

  private async walk(monthList: string[], timeZone: string | undefined): Promise<UsageScanResult> {
    if (timeZone !== this.cacheZone) {
      this.cache.clear();
      this.cacheZone = timeZone;
    }
    const months = new Set(monthList);
    const files = await walkJsonl(this.projectsDir);
    let changed = 0;
    let skipped = 0;
    let total: UsageBuckets = {};
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < files.length) {
        const path = files[index++]!;
        let info;
        try {
          info = await stat(path);
        } catch {
          continue; // vanished mid-scan
        }
        const cached = this.cache.get(path);
        const plan = fileScanPlan(cached, info.size, info.mtimeMs);
        let buckets: UsageBuckets = cached?.buckets ?? {};
        if (plan !== 'reuse' && !fileMayContainMonths(info.mtimeMs, months, timeZone)) {
          skipped += 1;
          buckets = {};
          this.cache.set(path, { size: info.size, mtime: info.mtimeMs, offset: info.size, buckets });
        } else if (plan !== 'reuse') {
          changed += 1;
          let offset = plan === 'append' && cached ? cached.offset : 0;
          // A cached offset that isn't on a line boundary → re-read the file.
          if (offset > 0 && (await byteAt(path, offset - 1)) !== 0x0a) offset = 0;
          let lines: string[];
          try {
            lines = await this.readLines(path, offset, info.size);
          } catch {
            continue;
          }
          const fresh = aggregateUsageLines(lines, { months, timeZone });
          buckets = offset > 0 && cached ? mergeBuckets(cached.buckets, fresh) : fresh;
          this.cache.set(path, { size: info.size, mtime: info.mtimeMs, offset: info.size, buckets });
        }
        total = mergeBuckets(total, buckets);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_WORKERS, files.length) }, () => worker()));
    const live = new Set(files);
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
    return { buckets: pick(total, months), files: files.length, changed, skipped };
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const objOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `<configDir>/.credentials.json`, `<dirname(configDir)>/.claude.json` and `<configDir>/.usage-cache`. */
export async function readUsageAccounts(configDir: string): Promise<UsageAccounts> {
  const [creds, account] = await Promise.all([
    readJson(join(configDir, '.credentials.json')),
    readJson(join(dirname(configDir), '.claude.json')),
  ]);
  const oauth = objOf(creds?.claudeAiOauth);
  const who = objOf(account?.oauthAccount);
  let usageCache: UsageAccounts['usageCache'] = null;
  try {
    const file = join(configDir, '.usage-cache');
    const info = await stat(file);
    if (info.isFile() && info.size <= MAX_USAGE_CACHE_BYTES) {
      usageCache = { body: await readFile(file, 'utf8'), mtimeMs: info.mtimeMs };
    }
  } catch {
    // no CLI usage cache
  }
  const expiresAt = Number(oauth.expiresAt);
  return {
    accessToken: strOrNull(oauth.accessToken),
    expiresAt: Number.isFinite(expiresAt) && oauth.expiresAt !== undefined ? expiresAt : null,
    plan: strOrNull(oauth.subscriptionType),
    email: strOrNull(who.emailAddress),
    org: strOrNull(who.organizationName),
    usageCache,
  };
}

function monthsParam(params: unknown): string[] {
  const v = objOf(params).months;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_MONTHS || !v.every((m) => typeof m === 'string' && MONTH_RE.test(m))) {
    throw new RpcError('bad-params', `months must be 1..${MAX_MONTHS} YYYY-MM strings`);
  }
  return v as string[];
}

/** A zone name this Node's ICU can't resolve (e.g. built without full ICU) is not
 * the caller's error: scan in distro-local time and report `fallback`. */
function timeZoneParam(params: unknown): { zone: string | undefined; fallback: boolean } {
  const v = objOf(params).timeZone;
  if (v === undefined || v === null) return { zone: undefined, fallback: false };
  if (typeof v !== 'string' || v === '' || v.length > 64) {
    throw new RpcError('bad-params', 'timeZone must be an IANA zone name');
  }
  return isValidTimeZone(v) ? { zone: v, fallback: false } : { zone: undefined, fallback: true };
}

export function usageHandlers(configDir: string): Record<string, Handler> {
  const scanner = new UsageScanner(join(configDir, 'projects'));
  return {
    'usage.scan': async (params) => {
      const months = monthsParam(params);
      const { zone, fallback } = timeZoneParam(params);
      const result = await scanner.scan(months, zone);
      return fallback ? { ...result, zoneFallback: true } : result;
    },
    'usage.accounts': () => readUsageAccounts(configDir),
  };
}
