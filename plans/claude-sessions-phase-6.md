# Phase 6 — Limitations and deferrals

Status: In progress.

Technical plan to close every item deferred during Phases 1–5 and every entry in the README "Known limitations" list. Based on `main` after Phase 5. Three concurrent streams (core / main / shell) against the §1 contracts, then one integration pass (full e2e + isolated smoke — the settings schema changes).

## 0. Inventory → decision

| # | Deferral / limitation (where it came from) | Decision |
|---|---|---|
| 1 | **Subagent transcripts not shown** (Phase 1 §0 "subagent rows deferred", Phase 2 §0, README) | Nest **Subagents** under a session row in the sidebar, loaded lazily on expand (`listSubagents`), and open a subagent in the chat column read-only (`getSubagentMessages` → the translator with `{streaming:false}`). Live attribution stays as it is (folded `↳` notes on the parent tool call) **plus** a live "N subagents" chip on the parent card when `parent_tool_use_id` messages arrive. |
| 2 | **Fork only from the sidebar menu** (Phase 2 §0, README) | Header **Fork** button in `ClaudeView` → existing `claude:fork` → the new session is selected (already what the controller does). |
| 3 | **Consecutive assistant messages in one turn render as one bubble** (Phase 2 §2.2 stateless translator; README) | Host tracks the current API message id from `stream_event` `message_start` (`event.message.id`) per session and passes `messageId` into `translateSdkMessage(msg, { streaming: true, messageId })`; deltas carry it, so the reducer starts a new message per API message. History already carries ids. |
| 4 | **`auto` permission mode → best-effort permission notifications for terminal/external sessions** (Spike B, Phase 4 §0, README) | App-launched ptys get `--permission-mode <claude.defaultPermissionMode>` (resume/new only), so our default applies to the Terminal tab as it does to chat. External terminals remain the user's own default — the README states that precisely instead of "best-effort". |
| 5 | **PR state only when the GitHub session can load the page** (Phase 5 §0, README) | Fallback: when the page fetch yields no state **and** `gh` is on PATH, `gh pr view <url> --json state,isDraft,title` (3 s timeout, same concurrency cap) fills title+state. No `gh` → unchanged. Setting-free; logged `pr-title { via: 'page' \| 'gh' }`. |
| 6 | **One writer at a time — composer disabled while the Terminal tab is open** (Phase 3 §0, README) | By design (no multi-writer in Claude Code), but make it painless: while a session is `terminalOwned`, the store watcher's change events for **that transcript** trigger a debounced `loadHistory` (1 s), so terminal turns appear in the chat column live, and the banner says so ("Live from the terminal — close it to chat here"). |
| 7 | **`app.exit(0)` quit hazard** (Phase 3 report: can block / return without exiting after a vetoed `app.quit()`; watchdog only) | Restructure quit to the normal Electron lifecycle: the window `close` handler vetoes once, runs `shutdown()`, then **destroys the window and calls `app.quit()`** (not `app.exit`); `shutdown()` sets `state.shutdownComplete` so the second `close`/`before-quit` passes through. The 5 s `process.exit` watchdog stays as the last resort. e2e: `shutdown.spec.ts` gains "quit while a Claude turn is mid-stream exits within 10 s" (the fake SDK with `FAKE_CLAUDE_DELAY_MS=20000`) — the exact scenario that blocked. |
| 8 | **Cost display** (Phase 2 §5 "not in Phase 2") | `result.total_cost_usd` → `SessionUsage.costUsd` (cumulative per session) shown in the usage pill tooltip and as `$0.12` in the pill when > 0. |
| 9 | **Selection persistence of the Claude *view*** (Phase 3 shell note: Chat/Terminal tab choice is component state) | Remember the last view per session in shell memory (`viewRequests`-style store) so switching sessions returns to the tab you were on; not persisted across launches. |
| 10 | **Background-agents section collapsed state is component-local** (Phase 3) | Persist in `claude.collapsedFolders` under the reserved name `__agents__` (already a `string[]` setting; `sessionTree` never sees it because the agents section is rendered separately). |
| 11 | **Hook listener `SessionStart` never fires via `--settings`** (Spike B) | Re-probe once on the current CLI (`claude:hooks-probe` already records it). If it now fires, add it to `HOOK_EVENTS` (activity → running at session start, `title` from `cwd`). If not, leave it out; either way record the result in `plans/claude-sessions-findings.md`. |
| 12 | **TerminalView exit label** | Done in Phase 3 — verify only. |

Explicitly **not** in Phase 6: multi-writer chat+terminal, OS toasts, Cloud ↔ Claude drag between surfaces, subagent *live* streaming view (read-only history only).

## 1. Contracts (lead-authored, land first)

- `src/shared/ipc.ts`:
  - `ClaudeSubagentSchema = { agentId: string, parentSessionId: string, title: string, messageCount: number | null }`; `ClaudeSessionSchema.subagents: ClaudeSubagent[] | null` (null = not loaded yet; `[]` = loaded, none).
  - `ChatSessionSchema.usage` += `costUsd: z.number().nullable()`; `SessionUsage.costUsd` in `localModel.ts` (core).
  - Channels: `claudeSubagents 'claude:subagents'` (invoke `{ sessionId }` → `LocalResult<ClaudeSubagent[]>`, loads + caches on the row), `claudeOpenSubagent 'claude:openSubagent'` (invoke `{ sessionId, agentId }` → `LocalResult<null>`; sets `state.claudeSubagentId`), `ClaudeState.selectedSubagentId: string | null` (cleared on `claude:open`).
  - `ClaudeChatStateSchema.subagentSessions: Record<'<sessionId>/<agentId>', ClaudeChatSession>` — read-only chat sessions keyed by composite id (`live: 'idle'`, `loaded`, `cwd` from the parent).
  - `TranslateOptions` (core): `{ streaming: boolean; messageId?: string | null }`.
  - Shortcut: none new.

## 2. Core stream
- `localModel.ts`: `SessionUsage.costUsd` (+ `emptyUsage`), `finishPrompt` merges `usage.costUsd` when numeric; `PromptUsage.costUsd?`.
- `claudeTranslate.ts`: honour `opts.messageId` for stream deltas; `result` → `usage.costUsd = total_cost_usd` (cumulative per the SDK). Export `messageIdFromStreamEvent(msg): string | null` (`message_start` → `event.message.id`, else null) for the host. Tests for both.
- `sessionTree.ts`: no change (subagents are children rendered by the Claude sidebar from `session.subagents`, not tree nodes — keeps Cloud untouched).
- `claudeHooks.ts`: `HOOK_EVENTS` gains `SessionStart` **only if** #11's probe says it fires (the main stream reports; core applies).

## 3. Main stream (sidekick)
- **#1 subagents**: `store.listSubagents(id)` (exists) + `store.subagentMessages(id, agentId)` (SDK `getSubagentMessages`); `sessions.loadSubagents(id)` → row `subagents` (title = first user text ≤ 60 chars via `titleFromPrompt`, else `agent-<id>`); `openSubagent(id, agentId)` → `host.ensureSubagentSession(key, { cwd })` + `loadSubagentHistory` (translator `{streaming:false}`), `state.claudeSubagentId`, scope stays the parent's `claude:<id>`. Live chip: host counts distinct `parent_tool_use_id` per turn → `tool_call_update` `content` note `↳ N subagents` already exists as notes; additionally invalidate the row's `subagents` cache (`null`) at turn end so expand re-lists.
- **#3**: host keeps `currentMessageId` per session from `messageIdFromStreamEvent`, passes `messageId` to the translator; reset at `result`.
- **#4**: `hookInjection` → also `['--permission-mode', settings.claude.defaultPermissionMode]` for resume/new; fake pty argv assertion.
- **#5**: `prTitles.ts` `gh` fallback (`resolveGhPath` via `where`/`which` once, cached 10 min; `execFile(gh, ['pr','view', url, '--json','state,isDraft,title'])`; map `MERGED|CLOSED|OPEN` + `isDraft`); `pr-title { via }`.
- **#6**: `store.ts` watch callback passes the changed path; `sessions.ts` maps `<id>.jsonl` changes for `terminalOwned` sessions to a debounced (1 s) `host.loadHistory(id)` (skip while a load is in flight); banner text change is shell.
- **#7**: quit restructure in `index.ts` per §0 (`state.shutdownComplete`; `close` handler: `if (state.shutdownComplete) return;` else veto + `void shutdown()`; end of `shutdown()`: destroy window → `app.quit()`; keep `quitAndInstall` branch; keep the watchdog). e2e in `shutdown.spec.ts` with the mid-stream fake turn; also re-run `terminal.spec` quit cases.
- **#8**: nothing beyond passing `usage` through (core does the mapping) — verify the pill tooltip shows cost (shell).
- **#11**: run `npm run claude:hooks-probe` on the current CLI; report whether `SessionStart` fires; if yes, add it (core) and handle `SessionStart` → activity running in `claudeActivity.ts` (core) and e2e.
- Test hooks: `claudeSubagents(id)`, `claudeOpenSubagent(id, agentId)`, `claudeChatMessageIds(id)` (list of `messageId`s in the chat session — proves #3), `shutdownState()`.
- e2e `tests/e2e/claudeDeferrals.spec.ts`: subagent expand/open (fixture gets `projects/C--work-alpha/<uuid-a>/subagents/agent-x.jsonl` — scrubbed real shape, verified with `getSubagentMessages` via the store probe), fork from header, two API messages in one fake turn → two agent bubbles (fake SDK emits two `message_start` ids under `FAKE_CLAUDE_TWO_MESSAGES=1`), pty argv has `--permission-mode`, terminal-owned live history (append a line to the jsonl while owned → chat shows it ≤ 2 s), cost in pill, quit mid-turn exits.

## 4. Shell stream
- `ClaudeSidebar`: expandable **Subagents** under a row (chevron appears when `subagents === null || subagents.length > 0`; expand → `claudeSubagents(id)`; children `[data-subagent-id]` with title + count; click → `claudeOpenSubagent`); selected subagent highlighted when `state.claude.selectedSubagentId` matches.
- `ClaudeView`: when `selectedSubagentId` is set render the read-only subagent chat (`chat.subagentSessions[key]`, composer hidden, header "Subagent of <parent title>" + Back button `#claudeSubagentBack` → `claudeOpen(parent)`); header **Fork** button `#claudeFork`; remember Chat/Terminal per session (#9); banner text for terminal-owned per #6; usage pill shows `costUsd` (`UsagePill` + tooltip line `Cost: $x.xx`).
- Agents section collapsed state persisted via `claude.collapsedFolders` `__agents__` (#10) — use the same `settings:set` path the folder collapse uses.
- `TerminalView` label — verify only (#12).

## 5. Integration + docs
`typecheck`, `test:unit`, `build`, full `test:e2e`, isolated `smoke:install` (schema changed). README: remove each resolved item from "Known limitations" (leave only the by-design one-writer note, reworded), document subagents, Fork button, cost, `--permission-mode` on app ptys, `gh` fallback. AGENTS.md: a "Claude deferrals (Phase 6)" bullet + the quit-lifecycle change replaces the Phase 3 `app.exit` gotcha text. `plans/claude-sessions-findings.md`: #11 result.
