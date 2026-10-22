// Pure aggregation for `hosts:probe --soak`: turns event-log JSONL lines into
// the wsl.exe / claude-list cadence numbers (counts only, no payloads).
export const SOAK_GRACE_MS = 60_000;
/** claude-list sources driven by watchers/polls/host changes (not user or startup actions). */
export const BACKGROUND_LIST_SOURCES: readonly string[] = ['watch', 'hosts'];
const LONG_LIVED_KIND = 'spawn';

export type SoakSummary = {
  minutes: number;
  graceMs: number;
  hostExecTotal: number;
  hostExecByKind: Record<string, number>;
  excludedLongLived: number;
  hostExecPerMin: number;
  hostExecPerMinPostGrace: number;
  hostExecPerMinPostGraceExclLongLived: number;
  /**
   * claude-list events with source watch|hosts (not user/startup driven). Each re-list
   * lists every enabled host incl. WSL over UNC, so this is the re-list cadence, not a WSL-only count.
   */
  backgroundRelistsTotal: number;
  backgroundRelistsPerMin: number;
  backgroundRelistsPerMinPostGrace: number;
  usageScans: number;
  /** Max `files` over usage-scan events (local + wsl). */
  usageScanFilesMax: number;
  /** Max `wslFiles` over usage-scan events; null when no event carries the field (older builds). */
  wslUsageScanFiles: number | null;
  /** Per WSL host: the helper channel's start-up and store timings. */
  helpers: Record<string, HelperTimings>;
  /** `remote-fs-violation` events (the guard logs once per op per run) — must be 0. */
  remoteFsViolations: number;
  remoteFsViolationOps: Record<string, number>;
};

export type HelperTimings = {
  /** `host-helper-deploy` ms per successful deploy. */
  deployMs: number[];
  /** `starting`(spawn) → `ready`(hello) per launch, from the event timestamps. */
  helloMs: number[];
  /** `claude-store-list` ms per full list over the channel. */
  storeListMs: number[];
  storeListMaxMs: number | null;
  /** Session count of the last list. */
  storeListCount: number | null;
  /** `claude-patch` events (watch deltas applied without a list). */
  patches: number;
  readyCount: number;
};

const emptyTimings = (): HelperTimings => ({
  deployMs: [],
  helloMs: [],
  storeListMs: [],
  storeListMaxMs: null,
  storeListCount: null,
  patches: 0,
  readyCount: 0,
});

type Parsed = { ts: number; event: string; detail: Record<string, unknown> };

export function parseEventLines(text: string): Parsed[] {
  const out: Parsed[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const rec = JSON.parse(line) as { ts?: unknown; event?: unknown; detail?: unknown };
      const ts = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
      if (typeof rec.event !== 'string' || Number.isNaN(ts)) continue;
      const detail =
        rec.detail && typeof rec.detail === 'object' ? (rec.detail as Record<string, unknown>) : {};
      out.push({ ts, event: rec.event, detail });
    } catch {
      /* partial line */
    }
  }
  return out;
}

/** Keeps only the counted events with detail reduced to non-sensitive count fields. */
const REDUCED_EVENTS = [
  'host-exec',
  'claude-list',
  'usage-scan',
  'host-helper',
  'host-helper-deploy',
  'claude-store-list',
  'claude-patch',
  'remote-fs-violation',
];

export function reduceEventLog(text: string): string {
  const keep = ['kind', 'source', 'host', 'count', 'files', 'wslFiles', 'ms', 'state', 'reason', 'ok', 'updated', 'removed', 'op'];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const rec = JSON.parse(line) as { ts?: string; event?: string; detail?: Record<string, unknown> };
      if (!rec.event || !REDUCED_EVENTS.includes(rec.event)) continue;
      const detail: Record<string, unknown> = {};
      for (const k of keep) if (rec.detail && k in rec.detail) detail[k] = rec.detail[k];
      out.push(JSON.stringify({ ts: rec.ts, event: rec.event, detail }));
    } catch {
      /* partial line */
    }
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

export function summarizeSoak(
  lines: string,
  startedAtMs: number,
  minutes: number,
  graceMs: number = SOAK_GRACE_MS,
): SoakSummary {
  const events = parseEventLines(lines).filter((e) => e.ts >= startedAtMs);
  const graceEnd = startedAtMs + graceMs;
  const postMin = Math.max(minutes - graceMs / 60_000, 1e-9);
  const rate = (n: number, m: number) => Math.round((n / m) * 100) / 100;

  const byKind: Record<string, number> = {};
  let execTotal = 0;
  let execPost = 0;
  let execPostNoSpawn = 0;
  let lists = 0;
  let listsPost = 0;
  let scans = 0;
  let scanFilesMax = 0;
  let wslFilesMax: number | null = null;
  const helpers: Record<string, HelperTimings> = {};
  const violationOps: Record<string, number> = {};
  let violations = 0;
  const spawnAt = new Map<string, number>();
  const timingsFor = (host: unknown): HelperTimings | null => {
    if (typeof host !== 'string') return null;
    helpers[host] ??= emptyTimings();
    return helpers[host];
  };
  for (const e of events) {
    const post = e.ts >= graceEnd;
    if (e.event === 'remote-fs-violation') {
      const op = typeof e.detail.op === 'string' ? e.detail.op : 'unknown';
      violationOps[op] = (violationOps[op] ?? 0) + 1;
      violations += 1;
      continue;
    }
    if (e.event === 'host-helper') {
      const t = timingsFor(e.detail.host);
      if (!t) continue;
      const host = e.detail.host as string;
      if (e.detail.state === 'starting') spawnAt.set(host, e.ts);
      else if (e.detail.state === 'ready') {
        t.readyCount += 1;
        const at = spawnAt.get(host);
        if (at !== undefined) t.helloMs.push(e.ts - at);
        spawnAt.delete(host);
      }
      continue;
    }
    if (e.event === 'host-helper-deploy') {
      const t = timingsFor(e.detail.host);
      if (t && e.detail.ok === true && typeof e.detail.ms === 'number') t.deployMs.push(e.detail.ms);
      continue;
    }
    if (e.event === 'claude-store-list') {
      const t = timingsFor(e.detail.host);
      if (t && typeof e.detail.ms === 'number') {
        t.storeListMs.push(e.detail.ms);
        t.storeListMaxMs = Math.max(t.storeListMaxMs ?? 0, e.detail.ms);
        if (typeof e.detail.count === 'number') t.storeListCount = e.detail.count;
      }
      continue;
    }
    if (e.event === 'claude-patch') {
      const t = timingsFor(e.detail.host);
      if (t) t.patches += 1;
      continue;
    }
    if (e.event === 'host-exec') {
      const kind = typeof e.detail.kind === 'string' ? e.detail.kind : 'unknown';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      execTotal += 1;
      if (post) {
        execPost += 1;
        if (kind !== LONG_LIVED_KIND) execPostNoSpawn += 1;
      }
    } else if (e.event === 'claude-list') {
      const source = e.detail.source;
      if (typeof source === 'string' && BACKGROUND_LIST_SOURCES.includes(source)) {
        lists += 1;
        if (post) listsPost += 1;
      }
    } else if (e.event === 'usage-scan') {
      scans += 1;
      const files = e.detail.files;
      if (typeof files === 'number') scanFilesMax = Math.max(scanFilesMax, files);
      const wsl = e.detail.wslFiles;
      if (typeof wsl === 'number') wslFilesMax = Math.max(wslFilesMax ?? 0, wsl);
    }
  }
  return {
    minutes,
    graceMs,
    hostExecTotal: execTotal,
    hostExecByKind: byKind,
    excludedLongLived: byKind[LONG_LIVED_KIND] ?? 0,
    hostExecPerMin: rate(execTotal, minutes),
    hostExecPerMinPostGrace: rate(execPost, postMin),
    hostExecPerMinPostGraceExclLongLived: rate(execPostNoSpawn, postMin),
    backgroundRelistsTotal: lists,
    backgroundRelistsPerMin: rate(lists, minutes),
    backgroundRelistsPerMinPostGrace: rate(listsPost, postMin),
    usageScans: scans,
    usageScanFilesMax: scanFilesMax,
    wslUsageScanFiles: wslFilesMax,
    helpers,
    remoteFsViolations: violations,
    remoteFsViolationOps: violationOps,
  };
}
