# Phase 4 — Notifications via Claude Code hooks

Technical plan for Phase 4 of `plans/claude-sessions.md`. Based on `main` after Phase 3. Three concurrent streams (core / main / shell) against the §1 contracts, then one integration pass. Spike B findings (`plans/claude-sessions-findings.md` §2) are the ground truth for hook behaviour.

## 0. Decisions

| Question | Decision |
|---|---|
| Two sources of truth | **Chat sessions** (SDK host) derive notifications from in-app state transitions (`setPermission` → waiting, `finishPrompt` → finished / blocked on error) — no hooks involved. **Terminal and external sessions** derive from hook events. The two never overlap: a terminal-owned session's live query is closed (Phase 3), and chat sessions do not get hooks injected. |
| Transport | Loopback `http.createServer` on `127.0.0.1`. **Stable per-profile port**: derived from a hash of `userData` into 49152–65535, probing +1 up to 20 times when busy (the chosen port is persisted in `userData/claude-hooks.json` so it stays stable across runs once found). Persistent random token (32 bytes hex) in the same file. Listener replies `{}` immediately; auth = `Authorization: Bearer <token>`; path `/devin-workspaces/hook/<Event>`; body ≤ 256 KB; events outside the allow-list are ignored (`claude-hook-ignored`). |
| Injection for our ptys | claude-kind ptys (Phase 3) get `--settings <json>` with the hook block and `DEVIN_WORKSPACES_CLAUDE_HOOK_TOKEN` in the env (`allowedEnvVars`, header `Bearer $DEVIN_WORKSPACES_CLAUDE_HOOK_TOKEN`). Mode `attach` gets none (the background agent already runs). `timeout: 2`. |
| Global opt-in | Setting `claude.hooksEnabled` (default **false**). On → merge our hook block into `<configDir>/settings.json` (`~/.claude/settings.json`) with the token **literal** (external terminals have no env var; both files are user-private); off → remove exactly our entries (identified by URL prefix `http://127.0.0.1:<any>/devin-workspaces/`), leaving everything else byte-for-byte except formatting of the `hooks` object. Before the first write a one-time backup `settings.json.devin-workspaces.bak` is made. Unparseable file → no write, `claude.hooks.error` shown in Settings. Re-applied on every start while enabled (port/token may have changed). |
| Event set | `UserPromptSubmit` (activity → running; clears waiting), `PermissionRequest` (→ `waiting`), `Notification` (`permission_prompt` de-duped against a `PermissionRequest` for the same session in the last 5 s; `idle_prompt` → treated like `Stop`), `Stop` (→ `finished`, activity → idle), `SessionEnd` (activity → gone), `PostToolUse` with `matcher: "Bash"` (server-side filter: `tool_input.command` matches `/\bgh\s+pr\b/` → scan `tool_response` text for PR URLs → `pr-opened` + `autoOpenLocalPr(url, claudeScope(id), 'claude-hook')`). `SessionStart` is **not** injected (never fires via flag settings). |
| "Needs your reply" timer | **Dropped.** `Stop` already produces `finished`; a second entry for the same condition would be noise. |
| `blocked` | Chat only: SDK `result` with an error subtype / query throw → `blocked`. Hooks have no error event. |
| Notification shape | `AppNotification.source?: 'devin' \| 'claude'` (absent = devin). Claude entries: `sessionId` = Claude session uuid, `ownerUserId: null`, `sessionTitle` = sidebar title (or cwd basename when unlisted). `itemKey` for session kinds becomes `session:<source>:<id>` so a Claude uuid can never supersede a Devin entry. `pruneForeign`/`reconcile` keep every `source === 'claude'` entry. |
| Opening a Claude notification | `openNotification`: `source === 'claude'` → `state.surface = 'claude'`, `claudeSessions().open(sessionId)`; with `prUrl` → the PR opens in the `claude:<id>` scope (`handleLink(url, 'claude')` after switching). Window restore/focus as today. |
| Sidebar activity | `ClaudeSession.activity: 'running' \| 'waiting' \| null`, from the activity model (hooks) **or** the chat session (`running` / `pendingPermission`). Rows show a dot (blue running / amber waiting) like Cloud's status dot; the Claude rail button shows the existing badge style when any session is `waiting`. Activity for a session with no event for 2 h is cleared (`running` can be lost when a terminal is killed). |
| Per-kind toggles | Reuse `notifications.kinds.*` and `notifications.collect`/`banner` unchanged. One new checkbox in Settings → Notifications: "Report Claude Code sessions started from other terminals (writes a hook into ~/.claude/settings.json)". |

## 1. Contracts (lead-authored, land first)

- `src/core/notificationModel.ts`: `AppNotification.source?: 'devin' | 'claude' | undefined`; `NewNotification` inherits.
- `src/shared/ipc.ts`: `ClaudeSessionSchema.activity: z.enum(['running','waiting']).nullable()`; `ClaudeStateSchema.hooks: { port: number | null, enabled: boolean, installed: boolean, error: string | null }`; settings `claude.hooksEnabled: boolean (false)`.
- Hook payload type (core, structural): `ClaudeHookEvent = { event: string; session_id: string; cwd?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; notification_type?: string; prompt_id?: string; receivedAt: number }`.
- Test hooks (main): `claudeHookInfo(): { port, tokenLength, enabled, installed }`, `claudeActivity(): Record<sessionId, 'running'|'waiting'>`, `claudePostHook(event, body)` (posts to the live listener with the real token — spares specs the port/token dance), `claudeHooksSettingsPath()`.

## 2. Core stream — pure modules + unit tests

### 2.1 `src/core/claudeHooks.ts`
```ts
export const HOOK_PATH_PREFIX = '/devin-workspaces/hook/';
export const HOOK_EVENTS = ['UserPromptSubmit','PermissionRequest','Notification','Stop','SessionEnd','PostToolUse'] as const;
export function hookUrl(port: number, event: string): string;                       // http://127.0.0.1:<port>/devin-workspaces/hook/<event>
export function buildHooksBlock(opts: { port: number; auth: { kind: 'env'; envVar: string } | { kind: 'token'; token: string } }): Record<string, unknown>;
  // { hooks: { <Event>: [ { matcher?: 'Bash' (PostToolUse only), hooks: [ { type:'http', url, headers:{Authorization:'Bearer …'}, allowedEnvVars?:[envVar], timeout:2 } ] } ] } }
export function mergeHooksIntoSettings(settingsJson: string | null, block: Record<string, unknown>): { json: string; changed: boolean } | { error: string };
  // parse (null → {}); remove existing ours (isOurHook); append ours per event; keep all other keys and other hooks; 2-space JSON + trailing newline
export function removeHooksFromSettings(settingsJson: string | null): { json: string; changed: boolean } | { error: string };
export function isOurHook(entry: unknown): boolean;                                  // type http && url startsWith http://127.0.0.1: && includes HOOK_PATH_PREFIX
export function settingsFlagJson(port: number, envVar: string): string;              // JSON.stringify(buildHooksBlock(env)) for --settings
```
Unit tests: block shape per event (matcher only on PostToolUse), env vs token auth, merge into empty / into a file with foreign hooks on the same event (ours appended, theirs intact) / idempotent re-merge (no duplicates, `changed:false` second time), remove leaves foreign hooks and drops empty arrays/`hooks` key when nothing remains, invalid JSON → error, non-object → error.

### 2.2 `src/core/claudeActivity.ts`
```ts
export type ClaudeActivity = 'running' | 'waiting';
export type ActivityState = Record<string, { activity: ClaudeActivity; since: number; lastEvent: number }>;
export function applyHookEvent(state: ActivityState, e: ClaudeHookEvent): ActivityState;   // UserPromptSubmit→running; PermissionRequest/Notification{permission_prompt}→waiting; Stop/Notification{idle_prompt}/SessionEnd→delete
export function expireActivity(state: ActivityState, now: number, maxAgeMs = 2*3600e3): ActivityState;
export function activityFor(state: ActivityState, chat: { running: boolean; pendingPermission: boolean } | null, id: string): ClaudeActivity | null;  // chat wins when provided
```

### 2.3 `src/core/claudeNotify.ts`
```ts
export type ClaudeNotifyContext = { titleFor(sessionId: string, cwd: string | undefined): string; enabled: { waiting: boolean; finished: boolean; prOpened: boolean }; now: number; recentPermission: Map<string, number> /* sessionId → ts */ };
export function notificationsForHookEvent(e: ClaudeHookEvent, ctx: ClaudeNotifyContext): { notifications: NewNotification[]; prUrls: string[] };
```
Rules: `PermissionRequest` → `waiting` (title `Waiting for permission`, body `<tool_name> in <title>`), records `recentPermission`; `Notification{permission_prompt}` → `waiting` unless `recentPermission` within 5 s; `Stop` / `Notification{idle_prompt}` → `finished` (`Finished a turn`); `PostToolUse` Bash with `/\bgh\s+pr\b/` → PR URLs via `extractPullRequestUrls(stripAnsi(text))` from `tool_response` (string, or `{stdout}`/`{output}` fields) → one `pr-opened` each (`prUrl`, `sessionTitle`) and the URLs returned for auto-open; everything else → empty. Every notification: `source: 'claude'`, `ownerUserId: null`, `sessionId`, `createdAt: now`. Disabled kinds → none. Unit tests per rule incl. de-dup window and non-gh Bash.

### 2.4 `src/core/notificationModel.ts`
`itemKey`: session kinds → `session:${source ?? 'devin'}:${sessionId}`; `pruneForeign` keeps `source === 'claude'`. Tests: Claude entries survive `pruneForeign(list, 'u1')` and `pruneForeign(list, null)`; a Claude `finished` does not supersede a Devin `finished` for the same id.

## 3. Main stream (sidekick) — listener, wiring, settings install, chat-derived notifications, e2e

### 3.1 `src/main/claude/hookServer.ts` — `ClaudeHookServer`
`constructor({ userData, onEvent(e: ClaudeHookEvent) })`; `start(): Promise<{ port } | { error }>` (load/create `claude-hooks.json` `{version:1, port, token}` — 0o600 where supported; bind preferred port, probe on EADDRINUSE, persist the final port); `info()`; `dispose()`. Request handling per §0 (auth, path, size cap, JSON parse, immediate `{}` reply; reply `401`/`404` without body otherwise). Logs: `claude-hooks-listen { port, probed }`, `claude-hook { event, hasSession }` (never cwd/tool input), `claude-hook-rejected { reason: auth|path|size|json }`, `claude-hooks-error`.

### 3.2 `src/main/claude/hooksInstall.ts`
`applyGlobalHooks(configDir, enabled, port, token): { installed: boolean; error: string | null }` — reads `<configDir>/settings.json`, backup once, `mergeHooksIntoSettings`/`removeHooksFromSettings`, atomic write (tmp + rename). Called from `sessions.start()` after the listener is up and on `claude.hooksEnabled` change; result → `ClaudeState.hooks`. Log `claude-hooks-install { enabled, changed, ok }`.

### 3.3 `sessions.ts` wiring
- Owns `ActivityState` (+ `expireActivity` on each refresh/every 10 min); `snapshot()` sets `activity` per row via `activityFor` with the chat session's `running`/`pendingPermission`; emit on every activity change.
- Hook events → `applyHookEvent` + `notificationsForHookEvent` → `notificationStore().add(n)` for each (respecting `notifications.collect`); `prUrls` → `autoOpenLocalPr(url, claudeScope(id), 'claude-hook')` (`source` union += `'claude-hook'`). `titleFor` = sidebar row title else cwd basename else `Claude session`.
- Chat-derived notifications in `host.ts` via an injected `onEvent(sessionId, kind: 'waiting'|'finished'|'blocked', detail)` callback: `canUseTool` park → `waiting`; `finishPrompt` end_turn → `finished`; error stop reasons → `blocked` (body = sanitised error, ≤ 200 chars). Not for `cancelled`. The chat view being visible does not suppress entries (Devin doesn't suppress either).
- `claudeGate.onOpen` (Phase 3): pass `--settings settingsFlagJson(port, 'DEVIN_WORKSPACES_CLAUDE_HOOK_TOKEN')` + env token into the pty spawn for modes `resume`/`new` — extend `TerminalOpenOptions` claude variant with `extraArgs?: string[]; extraEnv?: Record<string,string>` filled by `terminalIpc.ts` from `claudeSessions().hookInjection()` (null when the listener failed → no injection).
- Rail badge data: `ClaudeState` already has `sessions[].activity`; nothing else.

### 3.4 `openNotification` (`notifier.ts`) per §0; `NotificationStore.reconcile` unchanged (pure fix in `pruneForeign`).

### 3.5 e2e — `tests/e2e/claudeHooks.spec.ts`
Fixture tree + fake SDK + fake pty: (1) `claudeHookInfo().port > 0`; `claudePostHook('PermissionRequest', { session_id: A, tool_name: 'Write', cwd })` → notification panel row `[data-kind="waiting"]` with the fixture title, rail badge, sidebar row A `[data-activity="waiting"]`; `UserPromptSubmit` → `running`; `Stop` → `finished` entry only when `kinds.finished` on (toggle via settings), activity cleared. (2) `Notification{permission_prompt}` right after `PermissionRequest` → still one entry. (3) `PostToolUse` Bash `gh pr create` with a fixture PR URL in `tool_response` → `pr-opened` entry + `pr-auto-open {source:'claude-hook'}` log + hidden tab in `claude:<A>`. (4) Bad token → 401 + `claude-hook-rejected`. (5) Open the waiting entry → surface `claude`, `claudeSessionId === A`. (6) `claude.hooksEnabled` on → fixture `settings.json` contains our block (and a pre-seeded foreign hook survives), `hooks.installed === true`; off → removed, foreign intact; backup file exists. (7) claude-kind pty open → fake pty argv contains `--settings` with `/devin-workspaces/hook/` and env `DEVIN_WORKSPACES_CLAUDE_HOOK_TOKEN` set (fake pty prints env var presence — extend it if needed). (8) chat: `FAKE_CLAUDE_TOOL=1` prompt → `waiting` entry appears while the permission card is up; Allow → turn ends → `finished` when enabled.

## 4. Shell stream — sidebar/rail activity, notification panel source, Settings checkbox

- `ClaudeSidebar`/`SessionRow` usage: `data-activity` attr + dot (`.activity-dot` blue `#83b6ff` running / amber `#e0a03c` waiting) in the row's leading slot (Cloud DOM untouched). `Rail.tsx`: `#claudeButton` gets a small amber badge `#claudeWaitingBadge` when any `state.claude.sessions[].activity === 'waiting'`.
- `NotificationPanel.tsx` rows: `data-source="claude"|"devin"` and a tiny source glyph (sparkle for Claude) before the title; `NotificationBanner.tsx` same glyph. No layout change otherwise.
- `NotificationSettings.tsx`: `#claudeHooksToggle` checkbox bound to `claude.hooksEnabled` (instant-save via `settings:set` like the other toggles there), helper text with the settings path from `state.claude.configDir`, inline `#claudeHooksError` from `state.claude.hooks.error`, status line "Hook installed · port N" when `installed`.
- Preload: nothing new (settings:set covers the toggle).

## 5. Integration + docs
`typecheck`, `test:unit`, `build`, full `test:e2e`; **isolated smoke** (settings schema changed). README: "Notifications" paragraph under Claude sessions (what fires when, the global opt-in and exactly what it writes, the `auto` permission-mode caveat, `claude-hooks.json`); AGENTS.md: hook server, port/token policy, event set, activity model, `source` on notifications, env/hooks/log events, `--settings` injection. Not in Phase 4: `blocked` from hooks, subagent rows, OS toasts.
