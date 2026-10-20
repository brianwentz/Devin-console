// Devin usage metric — parseUsageLimit. Fixture is a recorded
// GET /api/personal-analytics/usage-limit body.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmt, parseUsageLimit, shortDate } from '../../src/core/devinUsage';

const BODY = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'devin-usage-limit.json'), 'utf8'),
) as Record<string, unknown>;

describe('parseUsageLimit', () => {
  it('parses the recorded body', () => {
    const snap = parseUsageLimit(BODY);
    expect(snap).not.toBeNull();
    expect(snap!.cycleUsage).toBeCloseTo(1404.88, 2);
    expect(snap!.cycleLimit).toBe(12000);
    expect(snap!.percent).toBeCloseTo(11.7, 1);
    expect(snap!.tierName).toBe('Power');
    expect(snap!.estimatedCycleUsage).toBeCloseTo(3939.36, 2);
    expect(snap!.cycleStart).toBe('2026-10-14T00:00:00-08:00');
    expect(snap!.cycleEnd).toBe('2026-11-01T00:00:00-08:00');
  });

  it('returns null for {} and for a non-numeric cycle_usage', () => {
    expect(parseUsageLimit({})).toBeNull();
    expect(parseUsageLimit({ cycle_usage: 'x' })).toBeNull();
    expect(parseUsageLimit(null)).toBeNull();
  });

  it('limit 0 → cycleLimit null and percent null', () => {
    const snap = parseUsageLimit({ ...BODY, cycle_usage_limit: 0 });
    expect(snap!.cycleLimit).toBeNull();
    expect(snap!.percent).toBeNull();
  });

  it('usage over limit → percent > 100 (not clamped)', () => {
    const snap = parseUsageLimit({ ...BODY, cycle_usage: 15000 });
    expect(snap!.percent).toBeCloseTo(125, 0);
  });
});

describe('fmt', () => {
  it('rounds and groups', () => {
    expect(fmt(1404.8785719676328)).toBe('1,405');
    expect(fmt(12000)).toBe('12,000');
    expect(fmt(0)).toBe('0');
  });
});

describe('shortDate', () => {
  it('formats the local date part of an ISO timestamp', () => {
    expect(shortDate('2026-11-01T00:00:00-08:00')).toBe('Nov 1');
    expect(shortDate('2026-10-14T00:00:00-08:00')).toBe('Oct 14');
    expect(shortDate('garbage')).toBe('garbage');
  });
});
