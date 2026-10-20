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
  emptyClaudeUsageState,
  emptyTotals,
  gaugeArc,
  mergeBuckets,
  monthKey,
  parseUsageResponse,
  previousMonthKey,
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
