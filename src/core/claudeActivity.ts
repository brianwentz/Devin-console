// Phase 4 — per-session activity derived from Claude Code hook events
// (terminal / external sessions). Chat sessions report their own state and
// win in `activityFor`.

/** Structural shape of a hook POST body plus the receive timestamp main stamps on it. */
export type ClaudeHookEvent = {
  event: string;
  session_id: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  notification_type?: string;
  prompt_id?: string;
  receivedAt: number;
};

export type ClaudeActivity = 'running' | 'waiting';

export type ActivityState = Record<string, { activity: ClaudeActivity; since: number; lastEvent: number }>;

/** Two hours without an event clears a session's activity (a killed terminal never sends Stop). */
export const ACTIVITY_MAX_AGE_MS = 2 * 3600e3;

type Transition = 'running' | 'waiting' | 'clear' | 'touch';

function transitionFor(e: ClaudeHookEvent): Transition {
  switch (e.event) {
    case 'UserPromptSubmit':
      return 'running';
    case 'PermissionRequest':
      return 'waiting';
    case 'Stop':
    case 'SessionEnd':
      return 'clear';
    case 'Notification':
      if (e.notification_type === 'permission_prompt') return 'waiting';
      if (e.notification_type === 'idle_prompt') return 'clear';
      return 'touch';
    default:
      return 'touch';
  }
}

/**
 * Apply one hook event. UserPromptSubmit → running; PermissionRequest /
 * Notification{permission_prompt} → waiting; Stop / SessionEnd /
 * Notification{idle_prompt} → entry removed; anything else only refreshes
 * `lastEvent` of an existing entry. Returns `state` itself when nothing changed.
 */
export function applyHookEvent(state: ActivityState, e: ClaudeHookEvent): ActivityState {
  const id = e.session_id;
  if (!id) return state;
  const current = state[id];
  const t = transitionFor(e);
  if (t === 'clear') {
    if (!current) return state;
    const { [id]: _gone, ...rest } = state;
    return rest;
  }
  if (t === 'touch') {
    if (!current || current.lastEvent === e.receivedAt) return state;
    return { ...state, [id]: { ...current, lastEvent: e.receivedAt } };
  }
  const since = current?.activity === t ? current.since : e.receivedAt;
  if (current && current.activity === t && current.since === since && current.lastEvent === e.receivedAt) return state;
  return { ...state, [id]: { activity: t, since, lastEvent: e.receivedAt } };
}

/** Drop entries whose last event is older than `maxAgeMs`. Returns `state` itself when nothing expired. */
export function expireActivity(state: ActivityState, now: number, maxAgeMs = ACTIVITY_MAX_AGE_MS): ActivityState {
  const cutoff = now - maxAgeMs;
  const stale = Object.keys(state).filter((id) => state[id]!.lastEvent < cutoff);
  if (stale.length === 0) return state;
  const next = { ...state };
  for (const id of stale) delete next[id];
  return next;
}

/**
 * Activity for a sidebar row: a chat session's own state wins (pendingPermission
 * → waiting, running → running); otherwise the hook-derived entry, else null.
 */
export function activityFor(
  state: ActivityState,
  chat: { running: boolean; pendingPermission: boolean } | null,
  id: string,
): ClaudeActivity | null {
  if (chat) {
    if (chat.pendingPermission) return 'waiting';
    if (chat.running) return 'running';
  }
  return state[id]?.activity ?? null;
}
