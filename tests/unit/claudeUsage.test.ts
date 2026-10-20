// Analytics Claude tab — pure helpers.
//
// Fixture transcript totals (tests/fixtures/claude-home/projects/C--work-alpha/usage-a/):
//   usage-a.jsonl          req-a1  opus-5-5  in 1000 out 200 cr 5000 cw 300  (2026-10-05)
//                          req-a1  opus-5-5  in  500 out 100 cr 2000 cw   0  ← deduped (same requestId)
//                          req-a2  sonnet-5  in  400 out 150 cr 1000 cw  50  (2026-10-06)
//   subagents/agent-1.jsonl req-sub opus-5-5  in  200 out 100 cr  500 cw   0  (2026-10-07)
// Expected month "2026-10" (local): opus-5-5 {in 1200 out 300 cr 5500 cw 300 msg 2}
//                                   sonnet-5 {in 400 out 150 cr 1000 cw 50 msg 1}
//                                   total    {in 1600 out 450 cr 6500 cw 350 msg 3}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateUsageLines,
  fileMayContainMonths,
  fileScanPlan,
  emptyClaudeUsageState,
  emptyTotals,
  gaugeArc,
  groupAccounts,
  mergeBuckets,
  monthKey,
  parseUsageResponse,
  previousMonthKey,
  pruneFileCache,
  resetsIn,
  severityFor,
  sumTotals,
} from '../../src/core/claudeUsage';

const FIXTURES = join(__dirname, '..', 'fixtures');
const USAGE_BODY = JSON.parse(
  readFileSync(join(FIXTURES, 'claude-usage.json'), 'utf8'),
) as Record<string, unknown>;
const USAGE_A = join(FIXTURES, 'claude-home', 'projects', 'C--work-alpha', 'usage-a');
const usageA = () => readFileSync(join(USAGE_A, 'usage-a.jsonl'), 'utf8').split('\n').filter(Boolean);
const agentA = () =>
  readFileSync(join(USAGE_A, 'subagents', 'agent-1.jsonl'), 'utf8').split('\n').filter(Boolean);

describe('parseUsageResponse', () => {
  it('parses the recorded body: 3 limits + spend credits', () => {
    const { limits, credits } = parseUsageResponse(USAGE_BODY);
    expect(limits).toHaveLength(3);
    expect(limits[0]).toMatchObject({
      kind: 'session',
      label: 'Current session',
      percent: 0,
      severity: 'normal',
      resetsAt: '2026-10-20T18:00:00.000Z',
      active: true,
    });
    expect(limits[1]).toMatchObject({
      kind: 'weekly_all',
      label: 'Current week (all models)',
      percent: 10,
    });
    expect(limits[2]).toMatchObject({
      kind: 'weekly_scoped',
      label: 'Current week (Fable)',
      percent: 0,
    });
    expect(credits).toMatchObject({
      enabled: false,
      usedMinor: 0,
      limitMinor: null,
      currency: 'USD',
      percent: 0,
    });
  });

  it('synthesises session/weekly_all from five_hour + seven_day when limits is absent', () => {
    const { limits } = parseUsageResponse({ ...USAGE_BODY, limits: undefined });
    expect(limits.map((l) => l.kind)).toEqual(['session', 'weekly_all']);
    expect(limits[1]!.percent).toBe(10);
  });

  it('derives severity from percent when the API omits it, maps unknown kinds to other', () => {
    const { limits } = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 95, resets_at: 'x' },
        { kind: 'something_new', percent: 80 },
      ],
    });
    expect(limits[0]).toMatchObject({ kind: 'session', severity: 'critical' });
    expect(limits[1]).toMatchObject({ kind: 'other', severity: 'warning', label: 'something_new' });
  });

  it('reads credits from extra_usage when spend is absent (decimal_places → minor)', () => {
    const { credits } = parseUsageResponse({
      extra_usage: {
        is_enabled: true,
        used_credits: 12.34,
        monthly_limit: 50,
        utilization: 24.68,
        currency: 'USD',
        decimal_places: 2,
      },
    });
    expect(credits).toMatchObject({
      enabled: true,
      usedMinor: 1234,
      limitMinor: 5000,
      currency: 'USD',
      percent: 24.68,
    });
  });

  it('returns null credits when neither spend nor extra_usage exists', () => {
    expect(parseUsageResponse({}).credits).toBeNull();
  });
});

describe('aggregateUsageLines', () => {
  const OCT = '2026-10';

  it('sums the fixture transcripts: dedupe, subagent line, per-day buckets', () => {
    const buckets = aggregateUsageLines([...usageA(), ...agentA()]);
    const oct = buckets[OCT]!;
    expect(oct).toBeTruthy();
    expect(Object.keys(buckets)).toEqual([OCT]);
    expect(oct.byModel['opus-5-5']).toEqual({
      input: 1200, output: 300, cacheRead: 5500, cacheWrite: 300, messages: 2,
    });
    expect(oct.byModel['sonnet-5']).toEqual({
      input: 400, output: 150, cacheRead: 1000, cacheWrite: 50, messages: 1,
    });
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    };
    expect(oct.byDay[dayKey('2026-10-05T10:00:00.000Z')]).toEqual({ 'opus-5-5': 6500 });
    expect(oct.byDay[dayKey('2026-10-06T10:00:00.000Z')]).toEqual({ 'sonnet-5': 1600 });
    expect(oct.byDay[dayKey('2026-10-07T10:00:00.000Z')]).toEqual({ 'opus-5-5': 800 });
  });

  it('skips malformed lines, user lines that mention usage, and bad timestamps', () => {
    const junk = [
      'not json "usage"',
      '{"type":"user","message":{"role":"user","content":"usage stats"},"timestamp":"2026-10-05T10:00:00Z","uuid":"u"}',
      '{"type":"assistant","message":{"usage":{}},"timestamp":"nope","uuid":"u2"}',
      '{"type":"assistant","message":{"role":"assistant"},"timestamp":"2026-10-05T10:00:00Z","uuid":"u3"}',
    ];
    expect(Object.keys(aggregateUsageLines(junk))).toHaveLength(0);
  });

  it('buckets by LOCAL month — a boundary pair lands in two months', () => {
    const oct = new Date(2026, 9, 31, 23, 30);
    const nov = new Date(2026, 10, 1, 0, 30);
    const line = (d: Date, uuid: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        timestamp: d.toISOString(),
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      });
    const buckets = aggregateUsageLines([line(oct, 'a'), line(nov, 'b')]);
    expect(buckets[monthKey(oct)]).toBeTruthy();
    expect(buckets[monthKey(nov)]).toBeTruthy();
    expect(monthKey(oct)).not.toBe(monthKey(nov));
  });

  it('opts.months filters which months are kept', () => {
    const buckets = aggregateUsageLines([...usageA(), ...agentA()], {
      months: new Set(['2026-11']),
    });
    expect(buckets['2026-10']).toBeUndefined();
  });
});

describe('bucket merge + totals', () => {
  it('mergeBuckets sums matching months/models/days', () => {
    const a = aggregateUsageLines(usageA());
    const b = aggregateUsageLines(agentA());
    const merged = mergeBuckets(a, b);
    expect(merged['2026-10']!.byModel['opus-5-5']).toMatchObject({ input: 1200, messages: 2 });
    expect(mergeBuckets(a, {})['2026-10']).toBeTruthy();
    expect(Object.keys(mergeBuckets({}, b))).toEqual(Object.keys(b));
  });

  it('sumTotals + emptyTotals', () => {
    const t = sumTotals([{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messages: 5 }, emptyTotals()]);
    expect(t).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messages: 5 });
    expect(sumTotals([])).toEqual(emptyTotals());
  });

  it('monthKey/previousMonthKey roll over the year', () => {
    expect(monthKey(new Date(2026, 9, 1))).toBe('2026-10');
    expect(previousMonthKey('2026-10')).toBe('2026-09');
    expect(previousMonthKey('2026-01')).toBe('2025-12');
  });
});

describe('gauge + labels', () => {
  it('gaugeArc produces a path starting with M; 0% collapses to a point, 100% draws 270°', () => {
    expect(gaugeArc(50, 10, 0, 0)).toMatch(/^M /);
    expect(gaugeArc(0, 10, 0, 0)).toMatch(/^M /);
    expect(gaugeArc(100, 10, 0, 0)).toMatch(/ 1 1 /); // large-arc + sweep flags
  });

  it('severityFor thresholds: <75 normal, 75–89 warning, ≥90 critical', () => {
    expect(severityFor(74)).toBe('normal');
    expect(severityFor(75)).toBe('warning');
    expect(severityFor(89)).toBe('warning');
    expect(severityFor(90)).toBe('critical');
  });

  it('resetsIn formats days/hours/minutes and null/past', () => {
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    expect(resetsIn(now, '2026-10-21T03:00:00.000Z')).toBe('1d 3h');
    expect(resetsIn(now, '2026-10-20T03:20:00.000Z')).toBe('3h 20m');
    expect(resetsIn(now, '2026-10-20T00:12:00.000Z')).toBe('12m');
    expect(resetsIn(now, '2026-10-19T00:00:00.000Z')).toBe('now');
    expect(resetsIn(now, null)).toBeNull();
  });

  it('emptyClaudeUsageState parses as the pushed-state schema seed', () => {
    const state = emptyClaudeUsageState('2026-10');
    expect(state).toMatchObject({
      status: 'idle',
      accounts: [],
      perToken: false,
      month: '2026-10',
      tokens: { total: emptyTotals(), byModel: {}, byHost: {}, byDay: [] },
    });
  });
});

describe('fileScanPlan (incremental scan decisions)', () => {
  const prev = { size: 100, mtime: 1, offset: 100 };
  it('new file → full; unchanged size+mtime → reuse; grown → append; shrunk/rewritten → full', () => {
    expect(fileScanPlan(undefined, 100, 1)).toBe('full');
    expect(fileScanPlan(prev, 100, 1)).toBe('reuse');
    expect(fileScanPlan(prev, 150, 2)).toBe('append');
    expect(fileScanPlan(prev, 50, 2)).toBe('full');
    expect(fileScanPlan(prev, 100, 2)).toBe('full'); // same size, new mtime → rewritten
  });
});

describe('groupAccounts', () => {
  it('groups hosts by email; no email → per-host group', () => {
    const groups = groupAccounts([
      { hostId: 'local', email: 'dev@example.com', organization: 'Org', plan: 'team' },
      { hostId: 'wsl:D', email: 'dev@example.com', organization: 'Org', plan: 'team' },
      { hostId: 'wsl:E', email: null, organization: null, plan: null },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: 'dev@example.com',
      email: 'dev@example.com',
      hostIds: ['local', 'wsl:D'],
    });
    expect(groups[1]).toMatchObject({ key: 'host:wsl:E', hostIds: ['wsl:E'] });
  });
});

describe('fileMayContainMonths (cold-scan gate)', () => {
  const months = new Set(['2026-11', '2026-10']);
  const at = (iso: string) => new Date(iso).getTime();
  // Local-midnight boundary: 2026-10-01T00:00 local is the earliest point.
  const prevStart = new Date(2026, 9, 1).getTime();
  it('skips files older than the previous month; keeps recent ones', () => {
    expect(fileMayContainMonths(prevStart - 1, months)).toBe(false);
    expect(fileMayContainMonths(prevStart, months)).toBe(true);
    expect(fileMayContainMonths(at('2026-10-05T10:00:00'), months)).toBe(true);
    expect(fileMayContainMonths(at('2026-09-30T23:59:00'), months)).toBe(false);
    expect(fileMayContainMonths(0, months)).toBe(false);
    expect(fileMayContainMonths(0, new Set())).toBe(true);
  });
});

describe('aggregateUsageLines zero-token models', () => {
  it('drops all-zero usage lines (synthetic messages)', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'z1',
        requestId: 'rz1',
        timestamp: '2026-10-05T10:00:00.000Z',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'z2',
        requestId: 'rz2',
        timestamp: '2026-10-05T11:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'opus-5-5',
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    ];
    const buckets = aggregateUsageLines(lines);
    expect(Object.keys(buckets['2026-10']!.byModel)).toEqual(['opus-5-5']);
    expect(buckets['2026-10']!.byDay['2026-10-05']).toEqual({ 'opus-5-5': 6 });
  });
});

describe('pruneFileCache', () => {
  const entry = { size: 1, mtime: 1, offset: 1, buckets: {} };
  it('drops keys of scanned hosts that no longer map to a live file', () => {
    // The poisoned shape: local: keys that carry a WSL store's project paths.
    // Keys use the scanner's shape `<hostId>:<path relative to projects/>`
    // (Windows separators on the real machine; the helper never parses them).
    const files = {
      'local:/C--work-alpha/a.jsonl': entry,
      'local:/-home-u-ws/poisoned.jsonl': entry,
      'wsl:Fake:/-home-u-ws/w.jsonl': entry,
    };
    const out = pruneFileCache(
      files,
      ['local', 'wsl:Fake'],
      ['local:/C--work-alpha/a.jsonl', 'wsl:Fake:/-home-u-ws/w.jsonl'],
    );
    expect(out.pruned).toBe(1);
    expect(Object.keys(out.files).sort()).toEqual([
      'local:/C--work-alpha/a.jsonl',
      'wsl:Fake:/-home-u-ws/w.jsonl',
    ]);
    // Input untouched.
    expect(Object.keys(files)).toHaveLength(3);
  });
  it('keeps entries of hosts that were not scanned this pass', () => {
    const files = {
      'local:/a.jsonl': entry,
      'wsl:Stopped:/-home-u-x/s.jsonl': entry,
    };
    const out = pruneFileCache(files, ['local'], ['local:/a.jsonl']);
    expect(out.pruned).toBe(0);
    expect(Object.keys(out.files)).toHaveLength(2);
  });
  it('a host id that prefixes another host id does not claim its keys', () => {
    const files = { 'wsl:Fake-2:/p/x.jsonl': entry };
    const out = pruneFileCache(files, ['wsl:Fake'], []);
    expect(out.pruned).toBe(0);
  });
});
