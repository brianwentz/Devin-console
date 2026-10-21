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
  hostExecPerMinPostGraceExclSpawn: number;
  claudeListTotal: number;
  wslClaudeListPerMin: number;
  wslClaudeListPerMinPostGrace: number;
  usageScans: number;
  /** Max `files` over usage-scan events; the log carries no per-host split, so this includes local files. */
  usageScanFilesMax: number;
  wslUsageScanFiles: number | null;
};

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
  for (const e of events) {
    const post = e.ts >= graceEnd;
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
    hostExecPerMinPostGraceExclSpawn: rate(execPostNoSpawn, postMin),
    claudeListTotal: lists,
    wslClaudeListPerMin: rate(lists, minutes),
    wslClaudeListPerMinPostGrace: rate(listsPost, postMin),
    usageScans: scans,
    usageScanFilesMax: scanFilesMax,
    wslUsageScanFiles: null,
  };
}
