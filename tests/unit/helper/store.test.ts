import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeHandlers } from '../../../src/helper/store';
import { RpcError } from '../../../src/helper/params';
import { SESSION_A, SESSION_B, SESSION_C, copyClaudeHome, transcriptLines } from './fixtureHome';

let home: { dir: string; cleanup: () => void };
let prevConfig: string | undefined;

beforeEach(() => {
  home = copyClaudeHome();
  prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home.dir;
});
afterEach(() => {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  home.cleanup();
});

describe('helper store', () => {
  it('store.list returns fixture sessions', async () => {
    const h = storeHandlers(home.dir);
    const list = (await h['store.list']!({})) as Array<{ sessionId: string }>;
    const ids = list.map((s) => s.sessionId);
    expect(ids).toEqual(expect.arrayContaining([SESSION_A, SESSION_B, SESSION_C]));
  });

  it('store.messages pages until short page', async () => {
    const id = '22222222-0000-4000-8000-000000000001';
    const dir = join(home.dir, 'projects', '-home-u-work');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), transcriptLines(id, 7));
    const h = storeHandlers(home.dir);
    const seen: string[] = [];
    const pages: number[] = [];
    for (let offset = 0; ; ) {
      const page = (await h['store.messages']!({ sessionId: id, offset, limit: 3 })) as Array<{ uuid: string }>;
      pages.push(page.length);
      seen.push(...page.map((m) => m.uuid));
      offset += page.length;
      if (page.length < 3) break;
    }
    expect(pages).toEqual([3, 3, 1]);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `${id}-m${i}`));
  });

  it('store.messages rejects a limit over 500 and a missing sessionId', async () => {
    const h = storeHandlers(home.dir);
    await expect(async () => h['store.messages']!({ sessionId: SESSION_A, limit: 501 })).rejects.toMatchObject({
      code: 'bad-params',
    });
    await expect(async () => h['store.messages']!({})).rejects.toBeInstanceOf(RpcError);
  });

  it('store.transcriptPath finds the transcript, null when unknown', async () => {
    const h = storeHandlers(home.dir);
    const found = (await h['store.transcriptPath']!({ sessionId: SESSION_C })) as { path: string | null };
    expect(found.path).toBe(join(home.dir, 'projects', 'C--work-beta', `${SESSION_C}.jsonl`));
    expect(await h['store.transcriptPath']!({ sessionId: '99999999-0000-4000-8000-000000000000' })).toEqual({
      path: null,
    });
  });

  it('store.listSubagents / subagentMessages / rename / fork / delete wrap the SDK', async () => {
    const h = storeHandlers(home.dir);
    expect(await h['store.listSubagents']!({ sessionId: SESSION_A })).toContain('fixture01');
    const sub = (await h['store.subagentMessages']!({ sessionId: SESSION_A, agentId: 'fixture01' })) as unknown[];
    expect(sub.length).toBeGreaterThan(0);
    expect(await h['store.rename']!({ sessionId: SESSION_B, title: 'renamed' })).toBeNull();
    const fork = (await h['store.fork']!({ sessionId: SESSION_C })) as { sessionId: string };
    expect(fork.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await h['store.delete']!({ sessionId: fork.sessionId })).toBeNull();
    const ids = ((await h['store.list']!({})) as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(ids).not.toContain(fork.sessionId);
  });
});
