import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentsJson } from '../../src/core/claudeAgents';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/claude-agents.json'), 'utf8'),
) as unknown;

describe('parseAgentsJson', () => {
  it('parses the probed shape (running / completed / stopped rows)', () => {
    const { agents, unknownKeys } = parseAgentsJson(JSON.stringify(fixture));
    expect(unknownKeys).toEqual([]);
    expect(agents).toHaveLength(3);
    expect(agents[0]).toMatchObject({
      id: '700e3fe1',
      sessionId: '700e3fe1-fdf7-4f40-9a68-5d5c78d771ba',
      name: 'reply with the single word pong',
      status: 'running',
      cwd: 'C:\\work\\probe',
      startedAt: 1792271626155,
    });
    expect(agents[1]).toMatchObject({ id: 'a1b2c3d4', status: 'completed' });
    expect(agents[2]).toMatchObject({ id: 'd4c3b2a1', status: 'completed' });
  });

  it('returns empty for an empty list, garbage, and non-array JSON', () => {
    for (const text of ['[]', 'not json', '{}', '42', 'null']) {
      expect(parseAgentsJson(text).agents).toEqual([]);
    }
  });

  it('keeps an {id}-only item and marks it unknown', () => {
    const { agents } = parseAgentsJson('[{"id":"abc123"}]');
    expect(agents).toEqual([
      { id: 'abc123', host: 'local', sessionId: null, name: null, status: 'unknown', cwd: null, startedAt: null },
    ]);
  });

  it('skips entries without an id and reports unmapped keys', () => {
    const { agents, unknownKeys } = parseAgentsJson(
      JSON.stringify([{ noId: true }, { id: 'x1', mystery: 1, otherKey: 'y' }]),
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe('x1');
    expect(unknownKeys.sort()).toEqual(['mystery', 'otherKey']);
  });

  it('maps alternative field spellings (session_id, started_at, description)', () => {
    const { agents } = parseAgentsJson(
      JSON.stringify([
        { id: 'z9', session_id: 'sess-1', description: 'desc', started_at: 5, state: 'working' },
      ]),
    );
    expect(agents[0]).toMatchObject({
      sessionId: 'sess-1',
      name: 'desc',
      startedAt: 5,
      status: 'running',
    });
  });
});
