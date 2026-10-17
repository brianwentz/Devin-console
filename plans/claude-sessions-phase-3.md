# Phase 3 — Terminal tab + background agents

Technical plan for Phase 3 of `plans/claude-sessions.md`. Stacked on Phase 2 (`claude/phase2`). Two concurrent streams (main / shell) against the §1 contracts, then one integration pass.

## 0. Decisions

| Question | Decision |
|---|---|
| Terminal command | `claude -r <id>` when the transcript is on disk (or the chat host has started a query for it); `claude --session-id <id>` for an in-memory new session; `claude attach <agentId>` for a background agent. cwd = the session's `cwd`; falls back to the user's home when empty. Same env treatment as devin-kind ptys (`WT_SESSION`/`TERM_PROGRAM` on Windows). |
| One-writer policy | No Claude lock exists (Spike A), so no release/reclaim dance. Opening the Terminal tab **closes the live SDK query** for that session (`host.closeLive`) and marks the chat session `terminalOwned` (composer disabled with the existing banner). The pty's exit clears `terminalOwned`, re-lists the store and reloads history (`loadHistory`) so terminal turns show in the chat. |
| Refusal | Opening the terminal while a chat prompt is running is refused with `'Cancel the running prompt first'` (mirrors Local's `TerminalHandoffRefused`). |
| Background agents | `claude agents --json --all` polled by `main/claude/backgroundAgents.ts`: 15 s while the window is focused, 60 s otherwise (test override `DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_POLL_MS`), plus an immediate poll on focus and after Attach/Stop. The item shape is **confirmed by a probe during implementation** (one `claude -p "Reply pong" --bg` in a temp cwd, output captured to `docs/evidence/claude-agents-probe.json`, then `claude rm <id>`); the parser is a tolerant zod `passthrough` that requires only `id` (short id) and reads `sessionId`/`session_id`, `name`/`description`, `status`/`state`, `cwd`, `startedAt`/`started_at`, `pid` when present. Unknown shape → log `claude-agents-parse { count, unknownKeys }` and show the raw id. |
| Agent → session mapping | By `sessionId`; agents without a known session show in a "Background agents" section at the top of the sidebar (collapsible like a folder, section kind `'agents'`, only rendered when non-empty). |
| Attach / Stop | Attach opens the Terminal tab (`kind: 'claude', mode: 'attach', agentId`) — for agents with a session it is that session's terminal; for orphan agents a synthetic selection is not created: the terminal opens in the **dock** instead (`shell`-kind pty with `command: ['claude','attach',<id>]`, new `command` option on shell-kind). Stop runs `claude stop <id>` (3 s timeout) then re-polls. |
| Hooks `--settings` injection | Deferred to Phase 4 (no stub — nothing consumes it yet). |
| Subagent rows | Still deferred (Phase 4/5; needs a chat view for subagent transcripts). |

## 1. Contracts (`src/shared/ipc.ts`, lead-authored)

- `TerminalOpenArg` += `{ kind: 'claude', sessionId: uuid, mode: 'resume' | 'new' | 'attach', agentId?: string }`; shell-kind gains `command?: string[]` (1..8 non-empty strings, test/attach use only — the dock UI never sets it). `TerminalSummarySchema.kind` += `'claude'`.
- `ClaudeAgentSchema = { id, sessionId: string|null, name: string|null, status: 'running' | 'completed' | 'stopped' | 'unknown', cwd: string|null, startedAt: number|null }`; `ClaudeStateSchema.agents: ClaudeAgent[]`; `ClaudeSessionSchema.agentStatus: ClaudeAgent['status'] | null` (set when an agent maps to the row).
- `ClaudeChatSessionSchema` already carries `terminalOwned?` via `ChatSessionSchema`.
- Channels: `claudeAgentStop 'claude:agentStop'` (invoke, `ClaudeAgentStopArg { agentId: string 1..64 }` → `LocalResult<null>`), `claudeAgentsRefresh 'claude:agentsRefresh'` (send). Context-menu `MenuAction` += `'open-terminal'` (session items) and agent rows get a menu: *Attach*, *Stop* (`ClaudeContextMenuArg.kind` += `'agent'`, `agentId?`).
- `TerminalOpenOptions` (main): `| { kind: 'claude'; sessionId: string; mode: 'resume' | 'new' | 'attach'; agentId?: string; cwd: string | null }` — the IPC handler fills `cwd` from the chat session.

## 2. Main stream (sidekick) — `terminalHost`, `host` hooks, `backgroundAgents.ts`, IPC, e2e

### 2.1 `src/main/local/terminalHost.ts`
- `TerminalKind` += `'claude'`. Command resolution: `resolveClaudePath(settings.claude.path)` → `{ file, args }` where args = `['-r', id]` / `['--session-id', id]` / `['attach', agentId]`; missing CLI → `{ error: INSTALL_GUIDANCE }` (from `claude/claudePath.ts`). `DEVIN_WORKSPACES_TEST_TERMINAL_CMD` replaces the command for claude-kind too (the fake pty echoes its args so e2e can assert `-r <id>`).
- `bySession` and `closeForSession` work for claude-kind too (keyed by sessionId; one pty per session; a second open returns the existing id). No `sessionGate` (no reclaim); `reclaimOnExit: false`. Env: same `WT_SESSION`/`TERM_PROGRAM` fill as devin-kind. `LinkScanner` on output → `autoOpenLocalPr(url, claudeScope(id), 'claude-terminal')` (`source` union += `'claude-terminal'`).
- New `onExit` hook: `terminalHost.onSessionExit(kind, cb)` or simpler — `TerminalHost` gets an optional `claudeGate: { onOpen(id): Promise<void>; onExit(id): void }` set by `setupClaude()` (mirrors `sessionGate`). `onOpen` = `claudeSessions().beginTerminal(id)` (refuses when running; closes the live query; sets `terminalOwned`); `onExit` = `claudeSessions().endTerminal(id)`.
- Shell-kind `command?: string[]`: when set, spawn `command[0]` with `command.slice(1)` instead of the profile shell (title = `command.join(' ')` truncated to 40).

### 2.2 `src/main/claude/host.ts` / `sessions.ts`
- `host.closeLive(id)` becomes public (`async closeLiveQuery(id)`), `host.setTerminalOwned(id, owned)` → `setTerminalOwned` reducer.
- `sessions.beginTerminal(id)`: `running` → throw `'Cancel the running prompt first'`; `await host.closeLiveQuery(id)`; `host.setTerminalOwned(id, true)`; log `claude-terminal { sessionId, op: 'open' }`. `endTerminal(id)`: `setTerminalOwned(false)`; `refresh('terminal')`; `host.loadHistory(id)` (ids/counts only in logs).
- `forget(id)` → `terminalHost.closeForSession(id)` too.
- Context menu: session items gain *Open in terminal* (`action: 'open-terminal'`) after *Fork*; `kind: 'agent'` menus: *Attach* (`action: 'attach-agent'`), *Stop* (runs `agentStop`).

### 2.3 `src/main/claude/backgroundAgents.ts`
```ts
export class ClaudeBackgroundAgents {
  constructor(opts: { cliPath: () => string | null; onChange: (agents: ClaudeAgent[]) => void });
  start(): void; dispose(): void;
  refresh(source: 'timer'|'focus'|'manual'|'mutate'): Promise<void>;   // coalesced; execFile(cli, ['agents','--json','--all'], { timeout: 5_000, windowsHide: true })
  async stop(agentId: string): Promise<void>;                            // execFile(cli, ['stop', agentId], { timeout: 3_000 }) then refresh('mutate')
  list(): ClaudeAgent[];
}
```
Parse via `src/core/claudeAgents.ts` (pure): `parseAgentsJson(text: string): { agents: ClaudeAgent[]; unknownKeys: string[] }` with the tolerant mapping from §0; unit-tested with the probe's captured JSON (committed as `tests/fixtures/claude-agents.json`, scrubbed) plus `[]`, garbage, and a minimal `{id}`-only item. Test override `DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD` (test mode, e.g. `node out/fixtures/fakeClaudeAgents.cjs`) replaces the spawn; the fake prints the file at `FAKE_CLAUDE_AGENTS` (JSON) and records `stop` calls to `FAKE_CLAUDE_AGENTS_LOG`. Cadence: focus-aware per §0 using `BaseWindow` focus/blur like `notifier`. Logs: `claude-agents { count, running, ms, source }`, `claude-agents-error { message<=200 }`, `claude-agent-stop { agentId, ok }`.
- `sessions.ts` holds the agents list; `snapshot()` exposes `agents` and sets `agentStatus` on matching rows; `start()` starts the poller; `dispose()` stops it.

### 2.4 IPC + hooks
- `terminal:open` handler (`src/main/ipc.ts` or wherever `terminalOpen` is handled): for `kind: 'claude'` look up the chat session's `cwd` and pass `cwd`; `mode: 'new'` only when the session is not on disk and the host never started it.
- `claude:agentStop`, `claude:agentsRefresh`. Test hooks: `claudeAgents()`, `claudeAgentsRefresh()`, `claudeTerminalOpen(id)` (returns the pty id), `claudeBeginTerminalRefusal()` helper not needed — e2e drives through the UI.
- Shortcuts: none new.

### 2.5 e2e — `tests/e2e/claudeTerminal.spec.ts`
Fixture tree + fake SDK + `DEVIN_WORKSPACES_TEST_TERMINAL_CMD=node out/fixtures/fakePty.cjs` + `DEVIN_WORKSPACES_TEST_CLAUDE_AGENTS_CMD`: (1) select a fixture session → Terminal tab → `[data-session-terminal="<id>"]` mounted, xterm shows the fake pty banner incl. `-r <id>`; `#composer` disabled with `#terminalOwnedBanner`; `claudeLiveCount()` is 0. (2) switch to Chat and back → same pty (no second spawn; `terminalPid` unchanged). (3) `#terminalOwnedClose` → pty closed → composer enabled → `claude-history` event logged. (4) prompt via chat, then open Terminal while running → inline error `'Cancel the running prompt first'`. (5) context menu *Open in terminal* on a sidebar row → selected + terminal view active. (6) agents: `FAKE_CLAUDE_AGENTS` lists one running agent bound to fixture session A and one orphan → row A shows `[data-agent-status="running"]`, the "Background agents" section lists the orphan; menu *Stop* on the orphan → fake log contains `stop <id>` → after the fake file is rewritten to `[]` and `claudeAgentsRefresh()`, the section disappears. (7) Local regression: `local*.spec.ts` unchanged and green.

## 3. Shell stream (subagent) — `ClaudeView` tabs, terminal pane, sidebar agents

### 3.1 `ClaudeView.tsx`
- Header gains `#claudeViewTabs` with `#view-chat` / `#view-terminal` (same ids as Local — only one surface renders at a time; `TerminalView` moves to `src/shell/chat/TerminalView.tsx` and Local imports it from there).
- Terminal pane `#terminalPane` with `[data-session-terminal="<id>"]` per opened session, lazily opened via `window.devinworkspaces.terminalOpen({ kind: 'claude', sessionId, mode: 'resume' })` (the main handler decides resume vs new); all mounted, `display:none` for inactive — copy Local's pattern (`terminalIds` map, `terminalError`, `onRestart`). Error from `terminalOpen` (`{ok:false,error}`) shows in `#claudeError`.
- ChatView gets `disabledReason={session.terminalOwned ? 'Close the terminal to chat here' : null}` and the `banner` with `#terminalOwnedBanner` + `#terminalOwnedClose` (closes the pty via `terminalClose(id)` or switches to the terminal view when no id is known) — same markup as Local.
- Attach for a mapped agent: menu action `'attach-agent'` with a `sessionId` → select the session and open the terminal with `mode: 'attach', agentId`.

### 3.2 `ClaudeSidebar.tsx`
- Handle `action === 'open-terminal'` → `claudeOpen(id)` then signal the view: a tiny shell-side store `src/shell/claude/viewRequests.ts` (`requestTerminal(sessionId)` + `useTerminalRequest()`), consumed by `ClaudeView` to switch to the terminal tab and open the pty. Same path for `'attach-agent'` (with `agentId`).
- Rows: `data-agent-status` attribute + a small running dot (`.agent-dot`, title "Background agent running") when `agentStatus === 'running'`.
- "Background agents" section (kind `'agents'`, `data-section-kind="agents"`) above Pinned, only when `state.claude.agents` has entries without a matching session row: rows `[data-agent-id]` showing `name ?? id`, status, cwd basename; right-click → `claudeContextMenu({ kind: 'agent', agentId, x, y })`; Attach for orphans → `terminalOpen({ kind: 'shell', command: ['claude', 'attach', id] })` via the dock (`setTerminalOpen(true)` first — check the existing dock-open seam the Rail uses).

### 3.3 Settings/docs
No new settings. README: Terminal tab, one-writer banner, background agents (section, badges, Attach/Stop). AGENTS.md: claude pty kind, `claudeGate`, `backgroundAgents.ts`, env vars, hooks, log events, `TerminalOpenArg` changes.

## 4. Integration
`typecheck`, `test:unit`, `build`, full `test:e2e`; no smoke needed unless the settings schema changes (it doesn't). Not in Phase 3: hooks/notifications, subagent rows, fork-from-chat, `claude logs`.
