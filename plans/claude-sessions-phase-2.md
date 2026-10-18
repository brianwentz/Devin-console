# Phase 2 — Chat view via the Agent SDK

Status: Done — merged as PR #60.

Technical plan for Phase 2 of `plans/claude-sessions.md`. Built as three concurrent streams over disjoint files (core / main / shell) against the contracts in §1, then one integration pass. Findings referenced are in `plans/claude-sessions-findings.md` (Spike A).

## 0. Decisions

| Question | Decision |
|---|---|
| Query lifetime | One **streaming-input** `query()` per live session (`prompt: AsyncIterable<SDKUserMessage>`), kept open across turns so `interrupt()` / `setPermissionMode()` / `setModel()` work. Started lazily on the first prompt (`resume: id` for sessions that exist on disk, `sessionId: id` for new ones). Closed after `claude.keepAliveMinutes` idle (default 15) or when more than `claude.maxLiveAgents` (default 3) are live (LRU). A closed query is transparent — the next prompt resumes. |
| Streaming vs full messages | `includePartialMessages: true`. Text/thinking come from `stream_event` deltas; the full `assistant` message is used **only** for `tool_use` blocks (never re-appends its text). History (`getSessionMessages`) has no stream events, so the translator takes `{ streaming: false }` and reads text/thinking from the full messages. |
| Settings sources | `settingSources: ['user', 'project', 'local']` — the user's own Claude settings (hooks, allow-lists, model) apply, unlike the probe's `[]`. |
| Permissions | `canUseTool` parks a promise; the UI shows the existing `PermissionCard` with options `allow` / `allow_always` (only when the SDK passed `suggestions`) / `reject`. `allow_always` returns `updatedPermissions: suggestions`. `signal` abort clears the pending card. Under machine default mode `auto` the card may never appear — the header shows the active mode so that is visible. |
| Cancel | `interrupt()`; the iterator then throws (Spike A) → `finishPrompt('cancelled')`. Any other throw → `finishPrompt('error', message)` and the live query is marked `stopped`. |
| New session | Needs a cwd. `claude:newSession {cwd: string \| null}` — `null` makes main show `dialog.showOpenDialog` (test mode: `DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD`). Creates the chat session in memory and selects it; it appears in the sidebar once the SDK writes the transcript on the first prompt. Entry points: `#claudeNewSession` in the sidebar header, the empty-state button in `ClaudeView`, Ctrl+N on the `claude` surface. |
| Fork from the chat | Not in Phase 2 (sidebar Fork exists). |
| Subagent rows / attribution | Rows stay deferred (Phase 3). Live subagent messages (`parent_tool_use_id !== null`) are folded into the parent tool call: each subagent `tool_use` appends `{ type: 'content', content: { type: 'text', text: '↳ <title>' } }` to the parent's `content`; subagent text/thinking are dropped. |
| Compaction | `compact_boundary` → one agent text chunk `_Context compacted_` with its own `messageId` so it renders as a separate message. |
| Selection persistence | `claude.lastSessionId` in settings; restored on start if the session is listed (deferred from Phase 1). |
| Version check | `claude --version` (once, at start and when `claude.path` changes) vs the SDK `manifest.json` CLI version → `ClaudeState.versions { cli, sdkTarget, mismatch }`; a warning badge in the `ClaudeView` header only. |
| Test double | `DEVIN_WORKSPACES_TEST_CLAUDE_SDK` (test mode only) = path to an ESM module that `loadSdk()` imports instead of the real SDK. `tests/fixtures/fakeClaudeSdk.ts` → `out/fixtures/fakeClaudeSdk.mjs` re-exports the real store API and replaces `query`; it **writes real-shaped jsonl lines** into `CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<id>.jsonl` so `listSessions`/`getSessionMessages`/the watcher all keep working. |

## 1. Contracts (land first — `src/shared/ipc.ts`, authored by the lead)

- `ChatSessionSchema` = today's `LocalSessionSchema` minus `workspace`; `LocalSessionSchema = ChatSessionSchema.extend({ workspace })`. `ClaudeChatSessionSchema = ChatSessionSchema.extend({ cwd: string, permissionMode: ClaudePermissionModeSchema, model: string | null, live: 'idle' | 'starting' | 'live' | 'stopped' })`. `ClaudeChatStateSchema = { sessions: Record<string, ClaudeChatSession> }`; types `ChatSessionPublic`, `ClaudeChatSessionPublic`, `ClaudeChatStatePublic`.
- `ClaudePermissionModeSchema = z.enum(['default','acceptEdits','bypassPermissions','plan','dontAsk','auto'])`.
- `ClaudeStateSchema` += `versions: { cli: string | null, sdkTarget: string | null, mismatch: boolean }`.
- Settings `claude` += `defaultPermissionMode` (default `'default'`), `model: string | null` (null = CLI default), `keepAliveMinutes` int 1..240 (15), `maxLiveAgents` int 1..10 (3), `lastSessionId: string | null`.
- Channels: `claudeChatState 'claude:chatState'` (invoke → state), `claudeChatUpdate 'claude:chatUpdate'` (main → shell push), `claudeNewSession 'claude:newSession'` (invoke → `LocalResult<string>`), `claudePrompt`, `claudeCancel`, `claudePermission`, `claudeSetPermissionMode`, `claudeSetModel`, `claudeLoadHistory` (all invoke → `LocalResult<null>`). Args: `ClaudeNewSessionArg { cwd: string | null }`, `ClaudePromptArg { sessionId, text 1..200k }`, `ClaudeCancelArg`, `ClaudePermissionArg { sessionId, requestId, optionId }`, `ClaudeSetPermissionModeArg { sessionId, mode }`, `ClaudeSetModelArg { sessionId, model: string | null }`, `ClaudeLoadHistoryArg { sessionId }`. `ClaudeSessionId` stays `uuid()`.
- Preload (shell stream adds): `getClaudeChatState()`, `onClaudeChatState(cb)`, `claudeNewSession(cwd)`, `claudePrompt(id, text)`, `claudeCancel(id)`, `claudePermission(id, requestId, optionId)`, `claudeSetPermissionMode(id, mode)`, `claudeSetModel(id, model)`, `claudeLoadHistory(id)` — signatures mirror the `local*` ones.

## 2. Core stream — `src/core/localModel.ts`, new `src/core/claudeTranslate.ts`, unit tests

### 2.1 Generic reducers
`ChatSession` = today's `LocalSession` without `workspace`; `LocalSession = ChatSession & { workspace: string }`. Every reducer that today takes `LocalState` and a session id becomes generic: `applyUpdate<S extends ChatStateLike>(state: S, sessionId, update): S` where `ChatStateLike = { sessions: Record<string, ChatSession> }` and the session type is preserved (`S['sessions'][string]`) by spreading, so extra fields (`workspace`, `cwd`, `live`…) survive. Covered: `applyUpdate`, `startPrompt`, `finishPrompt`, `setPermission`, `clearPermission`, `setTerminalOwned`, `resetHistory`, `removeSession`, `upsertSession`. `newSession` stays Local (needs `workspace`); add `newChatSession(input: Pick<ChatSession,'id'> & Partial<...>): ChatSession`. Local-only: `upsertAgent`, `removeWorkspace`, `sessionsFor`, `emptyLocalState`, `INSTALL_GUIDANCE`. Existing `localModel.test.ts` passes unchanged; add one generic case with an extended session type.

### 2.2 `claudeTranslate.ts` (pure, no SDK import — structural types only)
```ts
export type TranslateOptions = { streaming: boolean };
export type TranslateResult = {
  updates: SessionUpdate[];
  finish?: { stopReason: StopReason; error?: string; usage?: PromptUsage };
  init?: { model: string | null; permissionMode: string | null; cwd: string | null };
};
export function translateSdkMessage(msg: unknown, opts: TranslateOptions): TranslateResult;
export function toolCallTitle(name: string, input: Record<string, unknown>): string;   // Bash→command, Read/Edit/Write/MultiEdit→file_path basename, Grep/Glob→pattern, Task→description, WebFetch→url, else name
export function toolCallKind(name: string): string;  // ACP kinds: read | edit | execute | search | fetch | think | other
export function toolCallLocations(name, input): Array<{path, line?}> | undefined;
```
Mapping (unit-tested per row):
- `system/init` → `init`; also `session_info_update` is **not** emitted (titles come from the store).
- `stream_event` (streaming only, `parent_tool_use_id === null`): `content_block_delta` `text_delta` → `agent_message_chunk`; `thinking_delta` → `agent_thought_chunk`; `messageId = <assistant message uuid or event message id>` so a new API message starts a new chat message. `message_start/stop`, `input_json_delta`, pings → nothing.
- `assistant` (top-level): each `tool_use` block → `tool_call { toolCallId: block.id, title, kind, status: 'in_progress', rawInput: input, locations }`. With `streaming: false` additionally `text` → `agent_message_chunk`, `thinking` → `agent_thought_chunk` (messageId = message uuid). `error` set → nothing extra (the `result` carries it).
- `assistant` with `parent_tool_use_id` → `tool_call_update { toolCallId: parent, content: [{type:'content', content:{type:'text', text:'↳ <title>'}}] }` per `tool_use`; the reducer's `content` replace semantics mean the translator cannot append — so emit the item and let the **host** merge (host keeps `subagentNotes[parentId]` and sends the full array). Translator returns the single item; document this in the function doc.
- `user` with `tool_result` blocks → `tool_call_update { toolCallId: tool_use_id, status: is_error ? 'failed' : 'completed', rawOutput: content (string or blocks), content: [{type:'content', content:{type:'text', text: <first 2k chars of text content>}}] }`. Plain user text with `streaming: false` (history) → `user_message_chunk` (messageId = uuid); with `streaming: true` → nothing (the prompt is already in state from `startPrompt`). `isSynthetic` / `isMeta` → nothing.
- `result`: `success` → `finish { stopReason: 'end_turn', usage }`; `error_max_turns` → `max_turn_requests`; `error_max_budget_usd`/`error_max_structured_output_retries` → `refusal`? no — `error` with the subtype as message; `error_during_execution` → `error` with `errors[0]`-ish text (sanitised to 500 chars). `usage` from `result.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`→`cachedReadTokens`, `cache_creation_input_tokens`→`cachedWriteTokens`; `totalTokens = input+output`). Also emit `usage_update { used: input_tokens + cache_read + cache_creation (context in use), size: context window if `result.modelUsage[*].contextWindow` is present else 0 }` **only** when `size > 0`.
- `compact_boundary` → `agent_message_chunk` `_Context compacted_` with `messageId: 'compact-' + uuid`.
- Everything else (`status`, `tool_progress`, hooks, tasks, rate limits…) → `{ updates: [] }`.

## 3. Main stream — `src/main/claude/host.ts`, `chatState.ts`, `ipc.ts` additions, fake SDK, e2e

### 3.1 `chatState.ts`
Clone of `local/localState.ts` over `ClaudeChatState = { sessions: Record<string, ClaudeChatSession> }`: `getChatState/update/replace/publicChatState/publishChatState` (coalesced `setImmediate`, zod-validated via `ClaudeChatStateSchema`, `claude-chat-state-invalid` log).

### 3.2 `host.ts` — `ClaudeHost`
```ts
export class ClaudeHost {
  constructor(opts: { cliPath: () => string | null; configDir: string; onPullRequestUrl: (sessionId: string, url: string) => void });
  newSession(cwd: string): string;                  // randomUUID; newChatSession + { cwd, permissionMode: settings default, model: settings.model, live: 'idle' }; returns id
  ensureSession(id: string, info: { cwd: string | null }): void;  // creates the in-memory ChatSession for a listed transcript (loaded: false)
  async loadHistory(id: string): Promise<void>;     // getSessionMessages → translate {streaming:false} → resetHistory + applyUpdate…; loaded = true; `claude-history { sessionId, count, ms }`
  async prompt(id: string, text: string): Promise<void>;   // startPrompt; ensureLive; push SDKUserMessage
  async cancel(id: string): Promise<void>;          // mark cancelling; q.interrupt()
  respondPermission(id: string, requestId: string, optionId: string): void;
  async setPermissionMode(id, mode): Promise<void>; async setModel(id, model): Promise<void>;  // live → q.*; always update state
  isLive(id): boolean; liveCount(): number;
  async dispose(): Promise<void>;                   // close all; bounded 8 s wait on the consumer loops
}
```
- `ensureLive(id)`: `sdk.query({ prompt: pushable, options: { cwd, pathToClaudeCodeExecutable, permissionMode, model?, includePartialMessages: true, settingSources: ['user','project','local'], canUseTool, abortController, ...(onDisk ? { resume: id } : { sessionId: id }) } })`. `onDisk` = the sidebar's store list contains the id (passed in via a `isOnDisk(id)` callback from `sessions.ts`). Consumer loop → `translateSdkMessage` → `update(applyUpdate…)`; `finish` → `finishPrompt`; `init` → set `model`/`permissionMode` from the CLI; throws → cancelled/error as in §0; loop exit → `live: 'stopped'`.
- `canUseTool(toolName, input, { signal, suggestions, toolUseID })` → `setPermission` with `requestId = randomUUID()`, `toolCallId = toolUseID ?? ''`, `title = toolCallTitle(toolName, input)`, options `allow` / (`allow_always` iff suggestions?.length) / `reject`. Resolution: `allow` → `{ behavior:'allow', updatedInput: input }`; `allow_always` → `+ updatedPermissions: suggestions`; `reject` → `{ behavior:'deny', message:'Denied in Devin Workspaces' }`. `signal.onabort` → `clearPermission` + resolve deny.
- Idle timer per live query (`keepAliveMinutes`), reset on prompt start/finish; `maxLiveAgents` LRU eviction before starting a new query (never evict a running one; if all are running, allow the overflow).
- PR links: a `LinkScanner` per session fed with agent text chunks and `tool_result` text (never user prompts) → `onPullRequestUrl`.
- Logs (ids/counts/durations only): `claude-query { sessionId, mode: 'new'|'resume', ms }`, `claude-prompt { sessionId, length }`, `claude-turn { sessionId, stopReason, ms }`, `claude-permission { sessionId, tool, decision }`, `claude-live { live, evicted }`, `claude-query-error { sessionId, message }` (message ≤ 200 chars).

### 3.3 Wiring
- `sessions.ts`: after every reconcile, `host.ensureSession(id, { cwd })` for listed sessions not yet in chat state (cheap; `loaded: false`); `open(id)` → `loadHistory` when `!loaded`; `forget(id)` → `host.dropSession(id)` (close live query). `newSession(cwd|null)` → dialog (or `DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD`) → `host.newSession` → `open(id)`. Persist `claude.lastSessionId` on `open`; restore in `start()` once the first list lands. Versions: `claude --version` via `execFile` (3 s timeout) vs SDK manifest (`node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`, read next to the resolved entry like the version) → `versions`.
- `ipc.ts`: the §1 channels via `handleResult`; `claude:chatState` invoke; `publishChatState` on every update. `shortcuts.ts`: Ctrl+N on `claude` → `claudeSessions().newSession(null)`.
- `prAutoOpen.ts`: `autoOpenLocalPr(url, scope: string, source)` — scope is now passed in (`localScope(id)` from Local callers, `claudeScope(id)` here); `source: 'claude-chat'`.
- `sdk.ts`: in test mode, `DEVIN_WORKSPACES_TEST_CLAUDE_SDK` → `import(pathToFileURL(path).href)`.
- Test hooks: `claudeChatState()`, `claudeNewSession(cwd)`, `claudePrompt(id, text)`, `claudeCancel(id)`, `claudePermission(id, requestId, optionId)`, `claudeLiveCount()`.
- `shutdown()`: `await claudeHost().dispose()` before `claudeSessions().dispose()`.

### 3.4 Fake SDK — `tests/fixtures/fakeClaudeSdk.ts` → `out/fixtures/fakeClaudeSdk.mjs` (esbuild `format: 'esm'`, external `@anthropic-ai/claude-agent-sdk`)
`export * from '@anthropic-ai/claude-agent-sdk'` + `export function query({ prompt, options })`: an async generator that yields `system/init` (`session_id`, `model: 'fake-model'`, `permissionMode: options.permissionMode`), then for each user message from `prompt`: appends the user line to the jsonl, yields `stream_event` text deltas spelling `Echo: <text>` (3 chunks, `FAKE_CLAUDE_DELAY_MS` between), the full `assistant` message, appends the assistant line, and a `result success` with `usage {input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}`. `FAKE_CLAUDE_TOOL=1`: before the text, yields an `assistant` with a `Bash` `tool_use` (`echo hi`), awaits `options.canUseTool('Bash', {command:'echo hi'}, { signal, suggestions: [{type:'addRules', rules:[{toolName:'Bash'}], behavior:'allow', destination:'session'}], toolUseID })`; `allow` → yields the `user` `tool_result`; `deny` → `tool_result` with `is_error: true`. `interrupt()` → the generator throws `Error('Claude Code returned an error result: interrupted')` (mirrors Spike A). `setPermissionMode`/`setModel` record into `globalThis.__fakeClaude` and are no-ops. `close()` ends the generator. The jsonl line shapes copy `tests/fixtures/claude-home` (`type`, `uuid`, `parentUuid`, `sessionId`, `cwd`, `timestamp`, `message`).

### 3.5 e2e — `tests/e2e/claudeChat.spec.ts` (hook-driven + DOM; shell stream provides the DOM)
Launch with the fixture tree + `DEVIN_WORKSPACES_TEST_CLAUDE_SDK=out/fixtures/fakeClaudeSdk.mjs` + `DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD=<tmp cwd>`: (1) `claudeNewSession(null)` → selected, `live: 'idle'`; `claudePrompt` → `#messageList` shows the user message then `Echo: …`, `#turnSummary` with `data-stop-reason="end_turn"`, `#tokenUsage` visible; the sidebar lists the new session within 2 s (fake wrote the transcript). (2) Relaunch same profile → `claude.lastSessionId` restored, history loaded from the jsonl (`loaded: true`, same messages). (3) `FAKE_CLAUDE_TOOL=1`: tool card appears `in_progress`, `PermissionCard` with 3 options; click Allow → card `completed`, turn ends. (4) `FAKE_CLAUDE_DELAY_MS=5000`: Cancel → `data-stop-reason="cancelled"`, composer re-enabled. (5) open a fixture session → history messages render, `#composer` enabled; `claudeLiveCount()` is 0 until a prompt. (6) `claudeSetPermissionMode('plan')` → header shows `plan`.

## 4. Shell stream — `src/shell/chat/`, `ClaudeView.tsx`, preload, settings

### 4.1 `ChatView` extraction (`src/shell/chat/ChatView.tsx`, `Cards.tsx` moved from `local/` with `PermissionCard` taking `onRespond(requestId, optionId)`)
```ts
export function ChatView(props: {
  session: ChatSessionPublic | null;      // any extension type is accepted
  draftKey: string | null;                // drafts store key (session id)
  emptyText: string;                      // shown when session === null
  composerPlaceholder: string;
  footerHint: ReactNode;
  disabledReason?: string | null;         // e.g. terminal-owned → composer disabled with this placeholder
  error: string | null;                   // inline error line
  errorId?: string;                       // default 'localError' (Local e2e contract)
  onSend(text: string): void; onCancel(): void; onPermission(requestId: string, optionId: string): void;
  banner?: ReactNode;                     // Local's terminal-owned banner
}): JSX.Element
```
DOM ids unchanged: `#messageList`, `#turnSummary`, `#stopReason`, `#composer`, `#sendButton`, `#cancelButton`. `LocalPanel.tsx` keeps its workspace column, header, tabs and terminal pane and renders `<ChatView>` inside `#chatPane`. **Gate:** `local.spec.ts`, `localScope.spec.ts`, `localPr.spec.ts`, `localTerminal.spec.ts` (whatever exists under `tests/e2e/local*.spec.ts`) pass unmodified.

### 4.2 `ClaudeView.tsx`
`useClaudeChatState()` (`src/shell/claude/store.ts`, clone of `local/store.ts` over `claude:chatState`/`claude:chatUpdate`). Selected session = `shell.claudeSessionId` → `chat.sessions[id]`; sidebar metadata from `shell.claude.sessions`. Header: title, cwd (mono), branch, `live` dot (`data-live`), permission-mode `<select id="claudePermissionMode">`, model `<input id="claudeModel">` (blur/Enter commits; blank = default), version badge `#claudeVersionWarning` when `versions.mismatch`, id copy. Body: `<ChatView emptyText="Select a session or start a new one." composerPlaceholder="Message Claude…" footerHint="Enter sends · Shift+Enter newline" errorId="claudeError" …>`. No selection: empty state with `#claudeNewSession` button → `claudeNewSession(null)`. `data-claude-view` root stays.

### 4.3 Sidebar + settings
`ClaudeSidebar` header gains `#claudeNewSession` (Plus icon, "New session") → `claudeNewSession(null)`. Settings → General: `#claudePermissionModeDefault` select, `#claudeModelInput` (blank = default) via `settingsDraft` (+ unit case). `settings.test.ts` defaults for the new fields.

### 4.4 e2e
`claudeSessions.spec.ts` += settings round-trip for the two new fields and `#claudeNewSession` present. The chat flows are in §3.5 (main stream writes the spec against these ids).

## 5. Integration + docs (after all three land)
`npm run typecheck && npm run test:unit && npm run build && npm run test:e2e` once; README "Claude sessions" (chat, new session, permissions, model/mode, keep-alive) + AGENTS.md (channels, env `DEVIN_WORKSPACES_TEST_CLAUDE_SDK`/`_NEW_CWD`, `FAKE_CLAUDE_*`, hooks, log events, settings). Not in Phase 2: terminal tab, hooks/notifications, subagent rows, fork from chat, cost display.
