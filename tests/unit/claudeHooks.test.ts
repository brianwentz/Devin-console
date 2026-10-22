import { describe, expect, it } from 'vitest';
import {
  buildHooksBlock,
  globalHooksEnabledFor,
  HOOK_EVENTS,
  HOOK_PATH_PREFIX,
  LEGACY_HOOK_PATH_PREFIXES,
  hookUrl,
  isOurHook,
  mergeHooksIntoSettings,
  removeHooksFromSettings,
  settingsFlagJson,
} from '../../src/core/claudeHooks';

type Group = { matcher?: string; hooks: Record<string, unknown>[] };
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

const parse = (json: string): Settings => JSON.parse(json);
const ENV_BLOCK = buildHooksBlock({ port: 51234, auth: { kind: 'env', envVar: 'AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN' } });
const TOKEN_BLOCK = buildHooksBlock({ port: 51234, auth: { kind: 'token', token: 'abc123' } });
const FOREIGN = { type: 'command', command: 'echo hi' };
const FOREIGN_HTTP = { type: 'http', url: 'http://127.0.0.1:9999/other/path' };

describe('hookUrl / isOurHook', () => {
  it('builds loopback URLs under the hook prefix', () => {
    expect(hookUrl(51234, 'Stop')).toBe('http://127.0.0.1:51234/agent-workspace/hook/Stop');
    expect(HOOK_PATH_PREFIX).toBe('/agent-workspace/hook/');
  });
  it.each([
    ['ours (any port)', { type: 'http', url: hookUrl(1, 'Stop') }, true],
    ['ours (other port)', { type: 'http', url: hookUrl(65535, 'PostToolUse') }, true],
    ['http on loopback, other path', FOREIGN_HTTP, false],
    ['our path, other host', { type: 'http', url: `http://localhost:5${HOOK_PATH_PREFIX}Stop` }, false],
    ['command hook', FOREIGN, false],
    ['command hook with our url in command', { type: 'command', command: hookUrl(1, 'Stop') }, false],
    ['null', null, false],
    ['string', hookUrl(1, 'Stop'), false],
  ])('%s → %s', (_name, entry, expected) => {
    expect(isOurHook(entry)).toBe(expected);
  });
});

describe('hookUrl / isOurHook non-loopback addr', () => {
  it('hookUrl accepts an explicit IPv4 address', () => {
    expect(hookUrl(1, 'Stop', '172.20.0.1')).toBe(
      `http://172.20.0.1:1${HOOK_PATH_PREFIX}Stop`,
    );
  });
  it('isOurHook accepts any IPv4 host with our path', () => {
    expect(isOurHook({ type: 'http', url: hookUrl(9, 'Stop', '172.20.0.1') })).toBe(true);
    expect(isOurHook({ type: 'http', url: 'http://localhost:5/agent-workspace/hook/Stop' })).toBe(false);
    expect(isOurHook({ type: 'http', url: 'http://172.20.0.1:5/other' })).toBe(false);
  });
  it('buildHooksBlock threads the addr through every event', () => {
    const block = buildHooksBlock({ port: 7, auth: { kind: 'token', token: 't' }, addr: '172.20.0.1' });
    const urls = Object.values(
      (block as { hooks: Record<string, { hooks: { url: string }[] }[]> }).hooks,
    ).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.url)));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain('172.20.0.1:7');
  });
});

describe('buildHooksBlock', () => {
  it('has one group per event with a single http hook; matcher only on PostToolUse', () => {
    const hooks = (ENV_BLOCK as Settings).hooks!;
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(HOOK_EVENTS).toHaveLength(7);
    expect(HOOK_EVENTS[0]).toBe('SessionStart');
    expect(Object.keys(hooks)[0]).toBe('SessionStart');
    expect(hooks.SessionStart).toEqual([{ hooks: [expect.objectContaining({ type: 'http', url: hookUrl(51234, 'SessionStart') })] }]);
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event]!;
      expect(groups).toHaveLength(1);
      const group = groups[0]!;
      if (event === 'PostToolUse') expect(group.matcher).toBe('Bash');
      else expect('matcher' in group).toBe(false);
      expect(group.hooks).toHaveLength(1);
      expect(group.hooks[0]).toMatchObject({ type: 'http', url: hookUrl(51234, event), timeout: 2 });
      expect(isOurHook(group.hooks[0])).toBe(true);
    }
  });
  it('env auth uses a $VAR header plus allowedEnvVars', () => {
    const hook = (ENV_BLOCK as Settings).hooks!.Stop![0]!.hooks[0]!;
    expect(hook.headers).toEqual({ Authorization: 'Bearer $AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN' });
    expect(hook.allowedEnvVars).toEqual(['AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN']);
  });
  it('token auth embeds the literal token and no allowedEnvVars', () => {
    const hook = (TOKEN_BLOCK as Settings).hooks!.Stop![0]!.hooks[0]!;
    expect(hook.headers).toEqual({ Authorization: 'Bearer abc123' });
    expect('allowedEnvVars' in hook).toBe(false);
  });
  it('settingsFlagJson is the compact env block', () => {
    const json = settingsFlagJson(51234, 'AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN');
    expect(json).not.toContain('\n');
    expect(JSON.parse(json)).toEqual(ENV_BLOCK);
  });
});

describe('mergeHooksIntoSettings', () => {
  it.each([null, '', '   \n'])('into empty input %j → just our block, changed', (input) => {
    const res = mergeHooksIntoSettings(input, TOKEN_BLOCK);
    if ('error' in res) throw new Error(res.error);
    expect(res.changed).toBe(true);
    expect(JSON.parse(res.json)).toEqual(TOKEN_BLOCK);
    expect(res.json.endsWith('}\n')).toBe(true);
    expect(res.json).toBe(`${JSON.stringify(TOKEN_BLOCK, null, 2)}\n`);
  });
  it('keeps other keys and foreign hooks on the same event; ours appended after theirs', () => {
    const input = JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash'] },
      hooks: {
        Stop: [{ hooks: [FOREIGN] }],
        PreToolUse: [{ matcher: 'Write', hooks: [FOREIGN] }],
      },
    });
    const res = mergeHooksIntoSettings(input, TOKEN_BLOCK);
    if ('error' in res) throw new Error(res.error);
    const out = parse(res.json);
    expect(out.model).toBe('opus');
    expect(out.permissions).toEqual({ allow: ['Bash'] });
    expect(out.hooks!.PreToolUse).toEqual([{ matcher: 'Write', hooks: [FOREIGN] }]);
    expect(out.hooks!.Stop).toHaveLength(2);
    expect(out.hooks!.Stop![0]).toEqual({ hooks: [FOREIGN] });
    expect(out.hooks!.Stop![1]!.hooks[0]!.url).toBe(hookUrl(51234, 'Stop'));
    for (const event of HOOK_EVENTS) expect(out.hooks![event]!.some((g) => g.hooks.some(isOurHook))).toBe(true);
  });
  it('re-merging is idempotent: no duplicates and changed:false', () => {
    const first = mergeHooksIntoSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [FOREIGN] }] } }), TOKEN_BLOCK);
    if ('error' in first) throw new Error(first.error);
    const second = mergeHooksIntoSettings(first.json, TOKEN_BLOCK);
    if ('error' in second) throw new Error(second.error);
    expect(second.changed).toBe(false);
    expect(second.json).toBe(first.json);
    expect(parse(second.json).hooks!.Stop).toHaveLength(2);
  });
  it('replaces a stale entry (old port / token) instead of adding a second one', () => {
    const old = mergeHooksIntoSettings(null, buildHooksBlock({ port: 40000, auth: { kind: 'token', token: 'old' } }));
    if ('error' in old) throw new Error(old.error);
    const res = mergeHooksIntoSettings(old.json, TOKEN_BLOCK);
    if ('error' in res) throw new Error(res.error);
    expect(res.changed).toBe(true);
    const out = parse(res.json);
    for (const event of HOOK_EVENTS) {
      expect(out.hooks![event]).toHaveLength(1);
      expect(out.hooks![event]![0]!.hooks[0]!.url).toBe(hookUrl(51234, event));
      expect(res.json).not.toContain('Bearer old');
    }
  });
  it('SessionStart: a foreign hook survives, a stale entry of ours is replaced, remove leaves the foreign one', () => {
    const input = JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [FOREIGN] }, { hooks: [{ type: 'http', url: hookUrl(1, 'SessionStart') }] }] },
    });
    const res = mergeHooksIntoSettings(input, TOKEN_BLOCK);
    if ('error' in res) throw new Error(res.error);
    const start = parse(res.json).hooks!.SessionStart!;
    expect(start).toHaveLength(2);
    expect(start[0]).toEqual({ matcher: 'startup', hooks: [FOREIGN] });
    expect(start[1]).toEqual({ hooks: [expect.objectContaining({ url: hookUrl(51234, 'SessionStart') })] });
    const removed = removeHooksFromSettings(res.json);
    if ('error' in removed) throw new Error(removed.error);
    expect(removed.changed).toBe(true);
    expect(parse(removed.json)).toEqual({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [FOREIGN] }] } });
  });
  it('removes only our inner hook from a mixed group, keeping the foreign sibling', () => {
    const mixed = { hooks: { Stop: [{ hooks: [FOREIGN, { type: 'http', url: hookUrl(1, 'Stop') }] }] } };
    const res = mergeHooksIntoSettings(JSON.stringify(mixed), TOKEN_BLOCK);
    if ('error' in res) throw new Error(res.error);
    const stop = parse(res.json).hooks!.Stop!;
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual({ hooks: [FOREIGN] });
    expect(stop[1]!.hooks[0]!.url).toBe(hookUrl(51234, 'Stop'));
  });
  it.each([
    ['invalid JSON', '{ not json', /not valid JSON/],
    ['array', '[]', /JSON object/],
    ['string', '"x"', /JSON object/],
    ['null literal', 'null', /JSON object/],
  ])('%s → error', (_name, input, re) => {
    const res = mergeHooksIntoSettings(input, TOKEN_BLOCK);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(re);
  });
});

describe('removeHooksFromSettings', () => {
  it('leaves foreign hooks, drops empty event arrays and the hooks key when nothing remains', () => {
    const merged = mergeHooksIntoSettings(
      JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [FOREIGN] }], Notification: [{ hooks: [FOREIGN_HTTP] }] } }),
      TOKEN_BLOCK,
    );
    if ('error' in merged) throw new Error(merged.error);
    const res = removeHooksFromSettings(merged.json);
    if ('error' in res) throw new Error(res.error);
    expect(res.changed).toBe(true);
    expect(parse(res.json)).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [FOREIGN] }], Notification: [{ hooks: [FOREIGN_HTTP] }] },
    });
    // Only ours → `hooks` disappears entirely, other keys stay.
    const onlyOurs = mergeHooksIntoSettings(JSON.stringify({ model: 'opus' }), TOKEN_BLOCK);
    if ('error' in onlyOurs) throw new Error(onlyOurs.error);
    const gone = removeHooksFromSettings(onlyOurs.json);
    if ('error' in gone) throw new Error(gone.error);
    expect(gone.changed).toBe(true);
    expect(gone.json).toBe('{\n  "model": "opus"\n}\n');
  });
  it('is a no-op (changed:false) when nothing of ours is present', () => {
    for (const input of [null, '', '{}', JSON.stringify({ hooks: { Stop: [{ hooks: [FOREIGN] }] } })]) {
      const res = removeHooksFromSettings(input);
      if ('error' in res) throw new Error(res.error);
      expect(res.changed).toBe(false);
      expect(JSON.parse(res.json)).toEqual(input ? JSON.parse(input) : {});
    }
  });
  it('tolerates a malformed hooks value without throwing', () => {
    const res = removeHooksFromSettings(JSON.stringify({ hooks: { Stop: 'nope', Other: [1, { hooks: 'x' }] } }));
    if ('error' in res) throw new Error(res.error);
    expect(res.changed).toBe(false);
    expect(parse(res.json).hooks).toEqual({ Stop: 'nope', Other: [1, { hooks: 'x' }] });
  });
  it('invalid JSON → error', () => {
    expect(removeHooksFromSettings('{')).toHaveProperty('error');
    expect(removeHooksFromSettings('42')).toHaveProperty('error');
  });
});

describe('legacy hook prefix (pre-rename)', () => {
  const legacyUrl = (event: string) => `http://127.0.0.1:51234${LEGACY_HOOK_PATH_PREFIXES[0]}${event}`;

  it('isOurHook recognises a legacy /devin-workspaces/hook/ URL', () => {
    expect(isOurHook({ type: 'http', url: legacyUrl('Stop') })).toBe(true);
    expect(isOurHook({ type: 'http', url: `http://172.20.0.1:9/devin-workspaces/hook/Stop` })).toBe(true);
  });

  it('mergeHooksIntoSettings replaces a legacy block with the new URLs', () => {
    const legacyBlock = buildHooksBlock({ port: 51234, auth: { kind: 'token', token: 'old' } });
    // Rewrite the current block's URLs onto the legacy prefix, as a 1.x
    // install would have written them.
    const legacyJson = JSON.stringify(legacyBlock).replaceAll(HOOK_PATH_PREFIX, LEGACY_HOOK_PATH_PREFIXES[0]);
    const merged = mergeHooksIntoSettings(legacyJson, TOKEN_BLOCK);
    expect(merged).toHaveProperty('json');
    if ('error' in merged) throw new Error(merged.error);
    expect(merged.json).toContain(HOOK_PATH_PREFIX);
    expect(merged.json).not.toContain('/devin-workspaces/hook/');
    // One group per event — the legacy groups were replaced, not appended.
    const settings = parse(merged.json);
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks?.[event]).toHaveLength(1);
    }
  });

  it('removeHooksFromSettings strips a legacy block', () => {
    const legacyJson = JSON.stringify(TOKEN_BLOCK).replaceAll(HOOK_PATH_PREFIX, LEGACY_HOOK_PATH_PREFIXES[0]);
    const removed = removeHooksFromSettings(legacyJson);
    if ('error' in removed) throw new Error(removed.error);
    expect(removed.json).not.toContain('/devin-workspaces/hook/');
    expect(removed.json).not.toContain('"hooks"');
  });
});

describe('globalHooksEnabledFor (R39 #1)', () => {
  it('never installs the global (literal-token) block on an ssh host', () => {
    expect(globalHooksEnabledFor(true, 'ssh')).toBe(false);
    expect(globalHooksEnabledFor(false, 'ssh')).toBe(false);
  });
  it('follows the opt-in on this PC and WSL', () => {
    expect(globalHooksEnabledFor(true, 'local')).toBe(true);
    expect(globalHooksEnabledFor(true, 'wsl')).toBe(true);
    expect(globalHooksEnabledFor(false, 'local')).toBe(false);
    expect(globalHooksEnabledFor(false, 'wsl')).toBe(false);
  });
});
