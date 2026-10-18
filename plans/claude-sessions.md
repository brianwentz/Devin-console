# Claude Code sessions in Devin Workspaces — build plan

Supersedes the standalone-app plan in `brianwentz/claude-workspace` (`PLAN.md`, `plans/phase-0-*`). That repo stays as a reference: its Phase 0 bootstrap proved the Electron/SDK/hooks/store designs, and its probe scripts and findings are reused here. Nothing else from it is needed — the window, GitHub pane, PR panel, notifications, terminal dock, settings and updater already exist in this app.

Findings this plan relies on (verified 2026-10-16 against Claude Code 2.1.296→2.1.302, SDK 0.3.296): `plans/claude-sessions-findings.md`.

---

## 1. Product definition

A fourth main surface, **Claude**, next to Cloud / Local / Analytics in the rail:

- **Sessions column** (same shell-rendered column the Cloud surface has) listing every local Claude Code conversation on this machine — including ones started in any terminal — organised into user folders, with pin, archive, rename, fork, search and "New session in folder". Organisation persists in the app's userData and survives reboots; conversations are Claude's own `~/.claude/projects/**/*.jsonl` transcripts and resume automatically.
- **Main column**: the selected session's chat (streamed through the Claude Agent SDK, with permission prompts, plan, tool calls, usage/cost) and a **Terminal** tab that resumes the same session in the interactive CLI (`claude -r <id>`), mirroring Devin Local.
- **GitHub pane** scoped per Claude session (`claude:<id>`), PR auto-open and PR panel entries from Claude output, exactly as for Devin sessions.
- **Notifications** for Claude sessions — waiting for permission, turn finished, needs your reply, errors — fed by Claude Code hooks and the SDK stream, landing in the existing notification center/badge/banner. Works for sessions running in external terminals when the user opts into the global hook.
- **Background agents** (`claude --bg`) shown as running with Attach/Stop.

Non-goals: claude.ai cloud sessions, Remote Control, teleport, replacing Devin Local (it stays as is).

## 2. Architecture decisions (settled)

1. **Agent integration: Claude Agent SDK in the main process** (`@anthropic-ai/claude-agent-sdk`, pinned ≥ 7 days old; currently 0.3.296), driving the user's installed `claude` binary via `pathToClaudeCodeExecutable` (resolved like `resolveDevinPath`: `local.claudePath` override else PATH). The SDK is ESM-only and **must stay external** to `out/main.cjs`: add to esbuild `external`, `build.files`, `asarUnpack` (same treatment as `node-pty`), loaded with dynamic `import()`. RunAsNode stays off. The ACP adapter route is retired.
2. **Session store = the SDK's store API.** `listSessions({ includeProgrammatic: true })`, `getSessionInfo`, `getSessionMessages`, `forkSession`, `renameSession`, `deleteSession`, `listSubagents`/`getSubagentMessages`. No transcript parser in this repo. Change detection: recursive `fs.watch` on `~/.claude/projects` → 250 ms debounce → re-list + diff (45 ms for 46 sessions here).
3. **Two sources of truth, one view.** Transcripts are Claude's; organisation (folder, pinned, archived, lastOpenedAt, status cache, PR urls seen) is ours in `userData/claude-sessions.json` keyed by Claude's session UUID. Title is the SDK `summary` (custom > ai > first prompt); rename goes through `renameSession` so the CLI's `/resume` sees it. Sessions whose transcript disappears are flagged, not dropped. Delete = two actions: *Remove from list* (ours) and *Delete transcript…* (`deleteSession`, confirmed).
4. **No per-session lock exists in Claude Code**, so the Devin Local "release/reclaim + agent restart" handoff is **not** replicated. One-writer policy instead: the composer is disabled while the session's pty is open; on pty exit the chat reloads history via `getSessionMessages`.
5. **Running-state model**: running = SDK turn in flight ∨ our pty open ∨ `claude agents --json` lists it ∨ hook `UserPromptSubmit` without a later `Stop`/`SessionEnd`; transcript activity in the last 30 s is a weak hint. Nothing persists as running across restarts.
6. **Hooks as the event bus for non-SDK sessions**: `type: "http"` hooks injected with `--settings` on ptys we spawn (events `UserPromptSubmit`, `Stop`, `SessionEnd`, `PermissionRequest`, `Notification`, `PostToolUse` with `matcher: "Bash"`), posting to a loopback listener in main; token via `headers` + `allowedEnvVars` from the pty env; `timeout: 2`; listener replies `{}` immediately. SDK sessions use the in-process `hooks` option. `SessionStart` and `idle_prompt` are not delivered → "needs your reply" is an app-side timer after `Stop`. Optional global install into `~/.claude/settings.json` (opt-in, with uninstall) covers sessions started elsewhere.
7. **Reuse the Local chat machinery, don't fork it.** `core/localModel.ts` reducers become generic over `{ sessions: Record<string, LocalSession> }` so a separate `ClaudeState` can use `applyUpdate`/`startPrompt`/`finishPrompt`/`setPermission`/… unchanged; the chat column of `LocalPanel.tsx` (messages, cards, composer, permission card, terminal tab, thinking indicator, usage footer) is extracted into a shared `ChatView` used by both Local and Claude. A thin translator turns SDK messages into the ACP-shaped `SessionUpdate`s the reducers already understand.
8. **Reuse the Cloud sidebar's presentation, not its data layer.** `core/sessionTree.ts` becomes generic over a `SidebarSession` interface (`CloudSession` already satisfies it structurally — done once in the claude-workspace repo, port that change). `SessionSidebar.tsx`'s row/tree/folder/PR-badge/search pieces are extracted into shared components; `ClaudeSidebar.tsx` composes them over `ShellState.claude` and `claude:*` IPC. The Cloud sidebar keeps its `cloud:*` wiring untouched.
9. **Security/logging unchanged**: zod on every new IPC channel, `ipcGuard`, ids/lengths/booleans only — never transcript text or hook bodies; the hook token never reaches renderers or logs; `--settings` JSON never contains the token.

## 3. Integration points in the existing code (what changes where)

| Area | Change |
|---|---|
| `shared/ipc.ts` | `SurfaceSchema` + `'claude'`; `claude:*` channels (list/select/new/fork/rename/move/pin/archive/remove/deleteTranscript/folder ops/showArchived/prompt/cancel/permission/load/openLink/terminal/bgAttach/bgStop/hooksInstall); `ClaudeStateSchema` in `ShellState.claude`; settings `claude: { path, defaultPermissionMode, defaultModel, collapsedFolders, showArchived, hooksGlobal }` (`local.devinPath` stays); `TerminalOpenArg` kind `'claude'` alongside `'devin'`/`'shell'`. |
| `main/state.ts` | `claudeSessionId: string \| null` next to `localSessionId`. |
| `core/tabModel.ts` | `CLAUDE_SCOPE_PREFIX = 'claude:'`, `claudeScope(id)`; `effectiveScope(surface, cloudId, localId, claudeId)`. |
| `main/window.ts` | `layoutState().sessionsOpen` true on `cloud` **or** `claude`; `terminalVisible()` includes `claude`; `beginDrag('s')` allowed on `claude`; `syncScope` passes the Claude id; `publicState()` adds `claude`. `applyLayout` is otherwise unchanged — on `claude` no hosted main view is attached (same as `local`). |
| `App.tsx` / `Rail.tsx` | 5th rail button `#claudeButton`; on `claude`: `ClaudeSidebar` in `bounds.sessions`, `ClaudeView` in `bounds.devin`. |
| `main/local/terminalHost.ts` | pty kind `'claude'`: argv `['-r', id]` (or `['--session-id', id]` for brand-new), `--settings <hooks json>`, `--permission-mode <default>` from settings, env `CLAUDE_WORKSPACES_HOOK_TOKEN`; `bySession` map shared; `sessionGate` **not** used for claude-kind (policy only). Keep the Windows `WT_SESSION`/`TERM_PROGRAM` shim (needed for ptys, not for SDK children). |
| `main/local/prAutoOpen.ts` | accept a scope prefix (`local:`/`claude:`) — `pr-auto-open` detail `source: 'claude-chat' \| 'claude-terminal'`. |
| `main/routing.ts` / `core/linkRouter.ts` | `RouteSource` + `'claude'`, behaves like `'local'` (shell-rendered: new-window semantics). |
| `main/shortcuts.ts` | Ctrl+N on `claude` → new Claude session in the selected folder/last cwd; Ctrl+Shift+S toggles the column on `claude` too. |
| `main/notifications.ts` / `core/notificationModel.ts` | Entries gain `source: 'devin' \| 'claude'` (default `'devin'` on load); `openNotification` routes `claude` entries to the Claude surface + session. Existing kinds reused: `waiting` (permission), `finished` (Stop), `blocked` (error/auth), `pr-opened`. `NotificationStore.reconcile(userId)` must skip `claude` entries (they have no Devin owner). |
| `main/prs.ts` / PR panel | `openPullRequests` input gains Claude sessions' PRs (from the registry's seen-PR list) so the PR panel lists them; `openPr` for a claude PR switches to the Claude surface. |
| `main/index.ts` | create `ClaudeHost`/`ClaudeStore`/`HookServer`; shutdown: `claudeHost.dispose()` (await SDK child exit ≤ 8 s then taskkill) and `hookServer.close()` alongside `localHost()?.dispose()`. |
| `scripts/build.mjs`, `package.json` | SDK external + `asarUnpack` + `build.files`; probe scripts `claude:sdk-probe` / `claude:hooks-probe` / `claude:store-probe` (ported from claude-workspace `scripts/*-probe.ts`) as contract runs like `acp:contract`. |
| Tests | unit: generic reducers, `sessionTree` generic, registry reconcile, SDK→SessionUpdate translator, hook event derivation; e2e: fixture `~/.claude` tree via `DEVIN_WORKSPACES_TEST_CLAUDE_HOME`, fake SDK agent via `DEVIN_WORKSPACES_TEST_CLAUDE_CMD` (a stdio fake is not possible — the SDK is a library — so the host gets a test-mode in-process fake implementing the subset of `Query` we use), fake hook poster; smoke: `claude-sessions.json` in the userData list. |

## 4. Phases

Each phase gets its own technical-planning session; each ends green on `typecheck`, `test:unit`, `test:e2e`, and the README/AGENTS.md updated per the existing docs rule.

### Phase 1 — Surface skeleton, SDK packaging, registry + sidebar
- SDK dependency + packaging (external/asarUnpack/files); `dist:win` + `smoke:install` re-run as the gate.
- `claude` surface: rail button, empty main placeholder, sessions column shown on `claude`, settings `claude.path` (General tab, same not-found guidance pattern as `devinPath`).
- `main/claude/store.ts` (SDK wrapper + `fs.watch` re-list), `core/claudeRegistry.ts` (pure reconcile/folder ops) + `main/claude/registry.ts` (`claude-sessions.json`, atomic write like `cloudCache.ts`), `ShellState.claude` snapshot.
- `sessionTree.ts` generic; sidebar presentation components extracted; `ClaudeSidebar.tsx` with sections Pinned / folders / per-cwd Recent, search, show-archived, context menu (open / open in terminal / fork / move / pin / archive / rename / reveal transcript / remove from list / delete transcript… / new session here), native menus via a `claude:contextMenu` channel mirroring `cloud:contextMenu` (test mode returns item lists like the Cloud one). Subagents nest under a session, loaded on expand.
- Selecting a session sets `state.claudeSessionId` → tab scope `claude:<id>`; the GitHub pane follows.
- Port the three probe scripts as contract runs.
Done when: sessions created from an external terminal appear in ≤ 1 s; folder/pin/archive survive restart; unit + e2e (fixture `~/.claude`); smoke green with the SDK unpacked.
Open questions for its planning session: auto-archive after N idle days; surfacing the SDK `tag`; whether the Recent section groups by cwd or is flat.

### Phase 2 — Chat view via the SDK
- `core/localModel.ts` reducers generic over a sessions record; `ClaudeState` = `{ cliPath, sessions, versions }`.
- `main/claude/host.ts`: one `query` per active session; `new(cwd, {model, permissionMode})` with `sessionId`, `resume(id)`, `prompt`, `cancel` (`interrupt()`; the iterator then throws — map to `cancelled`; other throws → `error`), `respondPermission` (via `canUseTool`), `setPermissionMode`/`setModel`; lazy start on first prompt; idle stop after N minutes (`claude.maxLiveAgents`/`keepAliveMinutes` or reuse the Local pattern); `dispose()` with bounded wait + taskkill.
- `main/claude/translate.ts`: SDK `SDKMessage` → `SessionUpdate` (text/thinking chunks, tool_use → `tool_call`, tool_result → `tool_call_update`, `result` → finish + usage/cost, compaction boundary, `parent_tool_use_id` subagent attribution).
- History on open from `getSessionMessages` (no re-stream on resume); `ChatView` extracted from `LocalPanel.tsx` and used by both; `ClaudeView.tsx` = ChatView + composer extras (permission-mode picker, model picker) + Terminal tab placeholder.
- Version check `claude --version` vs SDK `manifest.json` → warning badge only.
- PR links in chat output → `autoOpenLocalPr` with `claude:` scope (`source: 'claude-chat'`).
Done when: new/resume/fork/cancel/permission all work from the UI; kill mid-turn + relaunch shows the persisted transcript; e2e with the in-process fake agent.

### Phase 3 — Terminal tab + background agents
- claude-kind pty (`terminalHost`), Terminal tab in `ClaudeView` (lazily opened, stays mounted like Local), one-writer policy (composer disabled while the pty is open; reload history on exit), trust-prompt note for new folders, hooks `--settings` injection (listener from Phase 4 can land first as a stub that only logs counts).
- `main/claude/backgroundAgents.ts`: `claude agents --json --all` polled with the notifier's focus-aware cadence; registry entries marked running/completed; sidebar Attach (dock terminal `claude attach <id>`) / Stop.
Done when: terminal resume → close → chat shows the terminal turns; bg agents show state.

### Phase 4 — Notifications via hooks
- `main/claude/hookServer.ts` (loopback + token file `userData/claude-hooks.json`), hook block builder (pure, unit-tested), global opt-in install/uninstall into `~/.claude/settings.json` (Settings → Notifications → "Report Claude sessions started from other terminals").
- Event derivation → existing store: `waiting` (`PermissionRequest`, de-duped against `Notification{permission_prompt}`; best-effort under permission mode `auto`), `finished` (`Stop`), *needs your reply* (timer after `Stop` without `UserPromptSubmit` — reuse `waiting` with a distinct `detail`), `blocked` (SDK error result / auth expired), `pr-opened` (`PostToolUse` Bash filtered to `gh pr` + LinkScanner). Per-kind toggles reuse the existing Settings checkboxes; one new toggle for the global hook.
- Sidebar running/waiting badges from the same events.
Done when: a permission prompt in a terminal-launched session raises badge + entry within 1 s; e2e with a fake hook poster.

### Phase 5 — PR panel, polish, docs
- Claude PRs in the PR panel (registry seen-PRs → `openPullRequests` input), `openPr` routing to the Claude surface, PR titles via the existing cache.
- README (intro bullet, First run, a "Claude sessions" section, Settings reference rows, shortcuts, Where things live: `claude-sessions.json`, `claude-hooks.json`), AGENTS.md (env vars, test hooks, log events, conventions), smoke spec update.

### Phase 6 — Limitations and deferrals (`plans/claude-sessions-phase-6.md`)
Closes every item deferred in Phases 1–5 and the README "Known limitations": subagent transcripts (nested rows + read-only view), Fork from the chat header, per-API-message ids for stream deltas, `--permission-mode` on app-launched ptys, `gh pr view` fallback for PR state, live history while terminal-owned, the `app.exit` quit hazard (normal `app.quit()` lifecycle), cost display, per-session view memory, persisted agents-section collapse, `SessionStart` re-probe.

### Phase 7 — Cleanup (`plans/claude-sessions-phase-7-cleanup.md`)
Code hygiene (phase breadcrumbs, `sessions.ts` split, reducer `appendContent`, pushed-store dedupe, lint), docs consolidation (AGENTS.md restructure, README, `plans/README.md` index), SDK bump policy + installer budget, and repository hygiene (merged branches, the reference `claude-workspace` repo — user-confirmed).

## 5. Phase 0 (already done) — what carries over from `claude-workspace`
- `plans/claude-sessions-findings.md` (this repo) — the verdicts.
- `scripts/sdk-probe.ts`, `scripts/hooks-probe.ts`, `scripts/store-probe.ts` — port verbatim with env/name changes (`CLAUDE_WORKSPACES_HOOK_TOKEN` → `DEVIN_WORKSPACES_CLAUDE_HOOK_TOKEN`), wired like `acp:contract`.
- `src/core/sessionTree.ts` generic `SidebarSession` refactor and its tests.
- `src/main/terminal/claudePath.ts` (`resolveClaudePath`).
- The e2e harness changes are **not** needed (this app keeps its Cloud fixtures).

## 6. Risks
- **SDK ↔ CLI coupling**: loose in practice (CLI self-updated 2.1.296→2.1.302 under SDK 0.3.296 without breakage) — warning only.
- **Permission mode `auto`** is the machine default: permission notifications are best-effort unless the app launches with `default`; make `claude.defaultPermissionMode` visible in the composer.
- **Two writers**: nothing stops an external terminal from resuming a session the app is chatting in; detect via hooks/file activity and show a "also open elsewhere" marker rather than blocking.
- **Hook timeouts at exit**: unreachable hook URLs delay CLI exit by the hook timeout — keep `timeout: 2` and always answer.
- **Shared sessions column settings**: `sessions.open`/`sessions.width` are shared between Cloud and Claude by design; `collapsedFolders`/`showArchived` are per surface.
