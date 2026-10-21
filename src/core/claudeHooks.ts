// Claude Code hook block builder and the pure settings.json merge /
// remove used for both the `--settings` flag (env-var auth, our ptys) and the
// global opt-in (`~/.claude/settings.json`, literal token). Our entries are
// identified purely by URL (loopback + HOOK_PATH_PREFIX) so a port or token
// change still finds the old ones.

/** Path prefix of every hook URL we register; the event name follows it. */
export const HOOK_PATH_PREFIX = '/agent-workspace/hook/';

/**
 * Prefixes written by pre-rename releases. Still recognised by isOurHook (so
 * a legacy settings.json block is stripped and rewritten) and by the hook
 * server (so terminals started before the upgrade keep reporting). Drop in a
 * later release.
 */
export const LEGACY_HOOK_PATH_PREFIXES = ['/devin-workspaces/hook/'] as const;

/**
 * Events we inject. `SessionStart` is first: older CLIs never fired it via
 * `--settings` (Spike B) — registering it is free when it doesn't fire and
 * marks the session running at start when it does.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
  'PostToolUse',
] as const;


type HookAuth = { kind: 'env'; envVar: string } | { kind: 'token'; token: string };

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `http://<addr>:<port>/devin-workspaces/hook/<event>` — addr is the
 * loopback normally, a vEthernet (WSL) IPv4 in NAT networking mode. */
export function hookUrl(port: number, event: string, addr = '127.0.0.1'): string {
  return `http://${addr}:${port}${HOOK_PATH_PREFIX}${event}`;
}

/** True for an inner hook entry (`{type:'http', url}`) pointing at our
 * listener on any port: loopback or any IPv4 (vEthernet in NAT mode). */
export function isOurHook(entry: unknown): boolean {
  if (!isObject(entry) || entry.type !== 'http' || typeof entry.url !== 'string') return false;
  const url = entry.url;
  const prefixes: readonly string[] = [HOOK_PATH_PREFIX, ...LEGACY_HOOK_PATH_PREFIXES];
  return (
    (url.startsWith('http://127.0.0.1:') || /^http:\/\/\d+\.\d+\.\d+\.\d+:/.test(url)) &&
    prefixes.some((prefix) => url.includes(prefix))
  );
}

/**
 * The `{ hooks: { <Event>: [group] } }` block Claude Code expects. One group
 * per event with a single http hook; `PostToolUse` carries `matcher: 'Bash'`.
 */
export function buildHooksBlock(opts: { port: number; auth: HookAuth; addr?: string }): Record<string, unknown> {
  const hooks: JsonObject = {};
  for (const event of HOOK_EVENTS) {
    const hook: JsonObject = {
      type: 'http',
      url: hookUrl(opts.port, event, opts.addr),
      headers: {
        Authorization: opts.auth.kind === 'env' ? `Bearer $${opts.auth.envVar}` : `Bearer ${opts.auth.token}`,
      },
    };
    if (opts.auth.kind === 'env') hook.allowedEnvVars = [opts.auth.envVar];
    hook.timeout = 2;
    const group: JsonObject = event === 'PostToolUse' ? { matcher: 'Bash', hooks: [hook] } : { hooks: [hook] };
    hooks[event] = [group];
  }
  return { hooks };
}

/** Compact JSON for `claude --settings <json>` with env-var auth. */
export function settingsFlagJson(port: number, envVar: string, addr?: string): string {
  return JSON.stringify(
    buildHooksBlock({ port, auth: { kind: 'env', envVar }, ...(addr ? { addr } : {}) }),
  );
}

/** Identity of one host's hooks write: an unchanged key means settings.json is already in the desired state, so the UNC round-trip is skipped. */
export function hooksApplyKey(hostId: string, enabled: boolean, block: unknown): string {
  return JSON.stringify([hostId, enabled, block]);
}

const serialise = (obj: unknown): string => `${JSON.stringify(obj, null, 2)}\n`;

function parseSettings(settingsJson: string | null): { settings: JsonObject } | { error: string } {
  if (settingsJson === null || settingsJson.trim() === '') return { settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch (err) {
    return { error: `settings.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObject(parsed)) return { error: 'settings.json must contain a JSON object' };
  return { settings: parsed };
}

// Remove our inner hooks from every group under `hooks[event]`; drop groups
// that end up empty. Returns the surviving groups (possibly []).
function withoutOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurHook(h));
    if (kept.length === group.hooks.length) out.push(group);
    else if (kept.length > 0) out.push({ ...group, hooks: kept });
  }
  return out;
}

// Strip our entries from every event under `hooks`, deleting empty arrays and
// the `hooks` key itself when nothing remains. Mutates a shallow copy.
function stripOurs(settings: JsonObject): JsonObject {
  if (!isObject(settings.hooks)) return settings;
  const hooks: JsonObject = { ...settings.hooks };
  for (const event of Object.keys(hooks)) {
    const kept = withoutOurs(hooks[event]);
    if (kept.length === 0 && Array.isArray(hooks[event])) delete hooks[event];
    else if (Array.isArray(hooks[event])) hooks[event] = kept;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

/**
 * Merge `block` (from buildHooksBlock) into a settings file: our previous
 * entries are replaced, foreign hooks and every other key are preserved.
 * `changed` is false when the result equals the normalised input. Never throws.
 */
export function mergeHooksIntoSettings(
  settingsJson: string | null,
  block: Record<string, unknown>,
): { json: string; changed: boolean } | { error: string } {
  const parsed = parseSettings(settingsJson);
  if ('error' in parsed) return parsed;
  const before = serialise(parsed.settings);
  const stripped = stripOurs(parsed.settings);
  const existing: JsonObject = isObject(stripped.hooks) ? { ...stripped.hooks } : {};
  const ours = isObject(block.hooks) ? block.hooks : {};
  for (const event of Object.keys(ours)) {
    const groups = ours[event];
    if (!Array.isArray(groups)) continue;
    const current = Array.isArray(existing[event]) ? (existing[event] as unknown[]) : [];
    existing[event] = [...current, ...groups];
  }
  const json = serialise({ ...stripped, hooks: existing });
  return { json, changed: json !== before };
}

/**
 * Remove exactly our hook entries; foreign hooks stay. Empty event arrays and
 * an empty `hooks` object are deleted. Never throws.
 */
export function removeHooksFromSettings(
  settingsJson: string | null,
): { json: string; changed: boolean } | { error: string } {
  const parsed = parseSettings(settingsJson);
  if ('error' in parsed) return parsed;
  const before = serialise(parsed.settings);
  const json = serialise(stripOurs(parsed.settings));
  return { json, changed: json !== before };
}
