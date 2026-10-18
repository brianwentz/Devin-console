// Pure parser for `claude agents --json --all` — probed in Phase 3 §0
// (docs/evidence/claude-agents-probe.json). The real shape (CLI 2.1.302):
//   { pid?, id, cwd, kind:'background', startedAt(ms), sessionId,
//     name, status:'busy'|'idle', state:'working'|'done' }
// After `stop` the item stays with state 'done' and no pid/status.
// Tolerant: only `id` is required; everything else is best-effort, and the
// set of unmapped keys is reported for the claude-agents-parse log.

import type { ClaudeAgent } from '../shared/ipc';

export type ParseAgentsResult = {
  agents: ClaudeAgent[];
  unknownKeys: string[];
};

const MAPPED_KEYS = new Set([
  'id',
  'sessionId',
  'session_id',
  'name',
  'description',
  'status',
  'state',
  'cwd',
  'startedAt',
  'started_at',
  'pid',
  'kind',
]);

function parseStatus(item: Record<string, unknown>): ClaudeAgent['status'] {
  const status = typeof item.status === 'string' ? item.status : '';
  const state = typeof item.state === 'string' ? item.state : '';
  if (status === 'busy' || state === 'working' || status === 'running') return 'running';
  if (status === 'stopped' || state === 'stopped' || state === 'killed') return 'stopped';
  if (state === 'done' || status === 'idle' || status === 'completed') return 'completed';
  return 'unknown';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function parseAgentsJson(text: string): ParseAgentsResult {
  const unknownKeys = new Set<string>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { agents: [], unknownKeys: [] };
  }
  const list = Array.isArray(raw) ? raw : [];
  const agents: ClaudeAgent[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = str(item.id);
    if (!id) continue;
    for (const key of Object.keys(item)) {
      if (!MAPPED_KEYS.has(key)) unknownKeys.add(key);
    }
    agents.push({
      id,
      sessionId: str(item.sessionId) ?? str(item.session_id),
      name: str(item.name) ?? str(item.description),
      status: parseStatus(item),
      cwd: str(item.cwd),
      startedAt: num(item.startedAt) ?? num(item.started_at),
    });
  }
  return { agents, unknownKeys: [...unknownKeys] };
}
