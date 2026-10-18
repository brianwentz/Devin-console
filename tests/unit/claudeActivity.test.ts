import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MAX_AGE_MS,
  activityFor,
  applyHookEvent,
  expireActivity,
  type ActivityState,
  type ClaudeHookEvent,
} from '../../src/core/claudeActivity';

const ev = (event: string, over: Partial<ClaudeHookEvent> = {}): ClaudeHookEvent => ({
  event,
  session_id: 'A',
  receivedAt: 1000,
  ...over,
});

describe('applyHookEvent', () => {
  it('UserPromptSubmit → running with since = receivedAt', () => {
    const s = applyHookEvent({}, ev('UserPromptSubmit'));
    expect(s).toEqual({ A: { activity: 'running', since: 1000, lastEvent: 1000 } });
  });
  it('a second UserPromptSubmit keeps the original since and bumps lastEvent', () => {
    let s = applyHookEvent({}, ev('UserPromptSubmit'));
    s = applyHookEvent(s, ev('UserPromptSubmit', { receivedAt: 2000 }));
    expect(s.A).toEqual({ activity: 'running', since: 1000, lastEvent: 2000 });
  });
  it.each([
    ['PermissionRequest', ev('PermissionRequest', { receivedAt: 1500 })],
    ['Notification{permission_prompt}', ev('Notification', { notification_type: 'permission_prompt', receivedAt: 1500 })],
  ])('%s → waiting (since resets on the state change)', (_n, e) => {
    const s = applyHookEvent(applyHookEvent({}, ev('UserPromptSubmit')), e);
    expect(s.A).toEqual({ activity: 'waiting', since: 1500, lastEvent: 1500 });
  });
  it('UserPromptSubmit after waiting → running again (clears waiting)', () => {
    let s = applyHookEvent({}, ev('PermissionRequest'));
    s = applyHookEvent(s, ev('UserPromptSubmit', { receivedAt: 3000 }));
    expect(s.A).toEqual({ activity: 'running', since: 3000, lastEvent: 3000 });
  });
  it.each([
    ['Stop', ev('Stop', { receivedAt: 2000 })],
    ['SessionEnd', ev('SessionEnd', { receivedAt: 2000 })],
    ['Notification{idle_prompt}', ev('Notification', { notification_type: 'idle_prompt', receivedAt: 2000 })],
  ])('%s → entry deleted, other sessions untouched', (_n, e) => {
    const running = applyHookEvent(applyHookEvent({}, ev('UserPromptSubmit')), ev('UserPromptSubmit', { session_id: 'B' }));
    const s = applyHookEvent(running, e);
    expect(s).toEqual({ B: { activity: 'running', since: 1000, lastEvent: 1000 } });
  });
  it('clearing an unknown session returns the same object', () => {
    const s: ActivityState = {};
    expect(applyHookEvent(s, ev('Stop'))).toBe(s);
  });
  it('other events only refresh lastEvent of an existing entry', () => {
    const s0: ActivityState = {};
    expect(applyHookEvent(s0, ev('PostToolUse'))).toBe(s0);
    expect(applyHookEvent(s0, ev('Notification', { notification_type: 'other' }))).toBe(s0);
    const s1 = applyHookEvent({}, ev('UserPromptSubmit'));
    const s2 = applyHookEvent(s1, ev('PostToolUse', { receivedAt: 1700, tool_name: 'Bash' }));
    expect(s2.A).toEqual({ activity: 'running', since: 1000, lastEvent: 1700 });
    expect(applyHookEvent(s2, ev('PostToolUse', { receivedAt: 1700 }))).toBe(s2);
  });
  it('returns the same object when nothing changed', () => {
    const s = applyHookEvent({}, ev('UserPromptSubmit'));
    expect(applyHookEvent(s, ev('UserPromptSubmit'))).toBe(s);
  });
  it('ignores events without a session id', () => {
    const s: ActivityState = {};
    expect(applyHookEvent(s, ev('UserPromptSubmit', { session_id: '' }))).toBe(s);
  });
  it('does not mutate the input state', () => {
    const s = applyHookEvent({}, ev('UserPromptSubmit'));
    const snapshot = JSON.stringify(s);
    applyHookEvent(s, ev('PermissionRequest', { receivedAt: 2000 }));
    applyHookEvent(s, ev('Stop'));
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('expireActivity', () => {
  const state: ActivityState = {
    old: { activity: 'running', since: 0, lastEvent: 0 },
    fresh: { activity: 'waiting', since: 0, lastEvent: 5000 },
  };
  it('drops entries older than maxAgeMs (default 2 h)', () => {
    expect(ACTIVITY_MAX_AGE_MS).toBe(7_200_000);
    expect(expireActivity(state, ACTIVITY_MAX_AGE_MS + 1)).toEqual({ fresh: state.fresh });
    expect(expireActivity(state, 10_000, 5000)).toEqual({ fresh: state.fresh });
    // Boundary: lastEvent === now - maxAge is kept (strict <).
    expect(expireActivity(state, 10_000, 5000 + 0)).toEqual({ fresh: state.fresh });
    expect(expireActivity(state, 10_000, 10_000)).toBe(state);
  });
  it('returns the same object when nothing expired', () => {
    expect(expireActivity(state, 5000)).toBe(state);
    expect(expireActivity({}, 1e12)).toEqual({});
  });
});

describe('activityFor', () => {
  const state: ActivityState = { A: { activity: 'waiting', since: 0, lastEvent: 0 } };
  it.each([
    ['chat pendingPermission wins', { running: true, pendingPermission: true }, 'A', 'waiting'],
    ['chat running', { running: true, pendingPermission: false }, 'A', 'running'],
    ['chat idle falls through to hooks', { running: false, pendingPermission: false }, 'A', 'waiting'],
    ['chat idle, no hook entry', { running: false, pendingPermission: false }, 'Z', null],
    ['no chat → hook entry', null, 'A', 'waiting'],
    ['no chat, unknown id', null, 'Z', null],
  ] as const)('%s', (_n, chat, id, expected) => {
    expect(activityFor(state, chat, id)).toBe(expected);
  });
});
