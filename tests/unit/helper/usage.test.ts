import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateUsageLines, mergeBuckets, type UsageBuckets } from '../../../src/core/claudeUsage';
import { RpcError } from '../../../src/helper/params';
import { UsageScanner, readUsageAccounts, usageHandlers } from '../../../src/helper/usage';
import { statPath } from '../../../src/helper/main';
import { copyClaudeHome } from './fixtureHome';

const MONTHS = ['2026-10', '2026-09'];

let home: { dir: string; cleanup: () => void };

beforeEach(() => {
  home = copyClaudeHome();
});
afterEach(() => home.cleanup());

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonlFiles(path));
    else if (entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** The app's local path: one aggregateUsageLines per file, merged. */
function expected(projects: string): UsageBuckets {
  let out: UsageBuckets = {};
  for (const file of jsonlFiles(projects)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    out = mergeBuckets(out, aggregateUsageLines(lines, { months: new Set(MONTHS) }));
  }
  return out;
}

const usageLine = (requestId: string, input: number, timestamp = '2026-10-12T10:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    requestId,
    uuid: `${requestId}-u`,
    timestamp,
    message: {
      role: 'assistant',
      model: 'helper-test-model',
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) + '\n';

describe('helper usage.scan', () => {
  it('usage.scan buckets equal aggregateUsageLines over the same fixture files', async () => {
    const projects = join(home.dir, 'projects');
    const scanner = new UsageScanner(projects);
    const result = await scanner.scan(MONTHS);
    expect(result.buckets).toEqual(expected(projects));
    expect(result.buckets['2026-10']).toBeDefined();
    expect(result.files).toBe(jsonlFiles(projects).length);
    // Through the RPC handler too.
    const viaRpc = (await usageHandlers(home.dir)['usage.scan']!({ months: MONTHS })) as { buckets: UsageBuckets };
    expect(viaRpc.buckets).toEqual(expected(projects));
  });

  it('second scan reads only appended bytes', async () => {
    const projects = join(home.dir, 'projects');
    const dir = join(projects, '-home-u-inc');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'inc.jsonl');
    writeFileSync(file, usageLine('req-1', 5));
    const scanner = new UsageScanner(projects);
    await scanner.scan(MONTHS);
    const firstBytes = scanner.bytesRead;
    expect(firstBytes).toBeGreaterThan(0);

    // Nothing changed → nothing read.
    await scanner.scan(MONTHS);
    expect(scanner.bytesRead).toBe(firstBytes);

    const appended = usageLine('req-2', 7);
    appendFileSync(file, appended);
    const result = await scanner.scan(MONTHS);
    expect(scanner.bytesRead - firstBytes).toBe(Buffer.byteLength(appended));
    expect(result.changed).toBe(1);
    expect(result.buckets).toEqual(expected(projects));
    expect(result.buckets['2026-10']!.byModel['helper-test-model']!.input).toBe(12);
  });

  it('a rewritten (shrunk) file is re-read in full; a removed file drops out', async () => {
    const projects = join(home.dir, 'projects');
    const dir = join(projects, '-home-u-rw');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rw.jsonl');
    writeFileSync(file, usageLine('req-a', 50) + usageLine('req-b', 50));
    const scanner = new UsageScanner(projects);
    await scanner.scan(MONTHS);
    writeFileSync(file, usageLine('req-c', 3));
    expect((await scanner.scan(MONTHS)).buckets).toEqual(expected(projects));
    rmSync(file);
    expect((await scanner.scan(MONTHS)).buckets).toEqual(expected(projects));
  });

  it('a missing projects dir scans nothing', async () => {
    const scanner = new UsageScanner(join(home.dir, 'nope'));
    expect(await scanner.scan(MONTHS)).toMatchObject({ buckets: {}, files: 0 });
  });

  it('rejects malformed months', async () => {
    const h = usageHandlers(home.dir);
    await expect(async () => h['usage.scan']!({ months: 'x' })).rejects.toBeInstanceOf(RpcError);
    await expect(async () => h['usage.scan']!({ months: ['2026/10'] })).rejects.toMatchObject({ code: 'bad-params' });
    await expect(async () => h['usage.scan']!({})).rejects.toMatchObject({ code: 'bad-params' });
  });
});

describe('helper usage.accounts', () => {
  it('reads credentials, the account file next to the config dir and the CLI usage cache', async () => {
    // configDir = <home>/claude, account file = <home>/.claude.json
    const configDir = join(home.dir, 'claude');
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 123, subscriptionType: 'max' } }),
    );
    writeFileSync(
      join(home.dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } }),
    );
    writeFileSync(join(configDir, '.usage-cache'), '{"limits":[]}');
    const r = await readUsageAccounts(configDir);
    expect(r).toEqual({
      accessToken: 'tok',
      expiresAt: 123,
      plan: 'max',
      email: 'a@b.c',
      org: 'Org',
      usageCache: { body: '{"limits":[]}', mtimeMs: statSync(join(configDir, '.usage-cache')).mtimeMs },
    });
  });

  it('missing files → nulls', async () => {
    const r = await readUsageAccounts(join(home.dir, 'missing'));
    expect(r).toEqual({ accessToken: null, expiresAt: null, plan: null, email: null, org: null, usageCache: null });
  });
});

describe('helper fs.stat', () => {
  it('reports existence and directory-ness; relative paths are refused', async () => {
    expect(await statPath(home.dir)).toEqual({ exists: true, dir: true });
    expect(await statPath(join(home.dir, '.credentials.json'))).toEqual({ exists: true, dir: false });
    expect(await statPath(join(home.dir, 'gone'))).toEqual({ exists: false, dir: false });
    await expect(statPath('relative/x')).rejects.toMatchObject({ code: 'bad-params' });
  });
});

describe('helper usage.scan time zone + coalescing (R28)', () => {
  it("the helper's scan honours the timeZone param", async () => {
    const projects = join(home.dir, 'projects');
    const dir = join(projects, '-home-u-tz');
    mkdirSync(dir, { recursive: true });
    // Oct 31 13:00 in Los Angeles, Nov 1 05:00 in Tokyo.
    writeFileSync(join(dir, 'tz.jsonl'), usageLine('req-tz', 9, '2026-10-31T20:00:00.000Z'));
    const h = usageHandlers(home.dir);
    const months = ['2026-11', '2026-10'];
    const tokyo = (await h['usage.scan']!({ months, timeZone: 'Asia/Tokyo' })) as { buckets: UsageBuckets };
    expect(tokyo.buckets['2026-11']?.byDay['2026-11-01']?.['helper-test-model']).toBe(10);
    // A zone change re-keys the cached buckets (not reused from the Tokyo pass).
    const la = (await h['usage.scan']!({ months, timeZone: 'America/Los_Angeles' })) as { buckets: UsageBuckets };
    expect(la.buckets['2026-11']).toBeUndefined();
    expect(la.buckets['2026-10']?.byDay['2026-10-31']?.['helper-test-model']).toBe(10);
    await expect(async () => h['usage.scan']!({ months, timeZone: 'Nowhere/Zone' })).rejects.toMatchObject({
      code: 'bad-params',
    });
  });

  it('overlapping scans join the running walk', async () => {
    const projects = join(home.dir, 'projects');
    const once = new UsageScanner(projects);
    await once.scan(MONTHS);
    const scanner = new UsageScanner(projects);
    const [a, b] = await Promise.all([scanner.scan(MONTHS), scanner.scan(MONTHS)]);
    expect(scanner.bytesRead).toBe(once.bytesRead);
    expect(b).toEqual(a);
    // Once settled, a new scan runs again (incremental: nothing to read).
    await scanner.scan(MONTHS);
    expect(scanner.bytesRead).toBe(once.bytesRead);
  });
});
