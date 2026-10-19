# Phase 0 — findings and verdicts

Evidence (git-ignored, local): `docs/evidence/sdk-probe-{node,electron}-2026-10-16T21-0*.jsonl`, `docs/evidence/hooks-probe-2026-10-16T21-31-08-322Z.jsonl`, `docs/evidence/store-probe-2026-10-16T21-33-52-744Z.json`. Versions: SDK `@anthropic-ai/claude-agent-sdk@0.3.296` (manifest CLI 2.1.296); installed CLI 2.1.296 at the start of the run, **2.1.302 by the hooks probe** (the CLI self-updated mid-session — see §4).

## 1. Spike A — Agent SDK inside Electron: **Option A confirmed**

All 11 steps passed with identical results under plain `node` and under `electron` (no window, `app.whenReady`).

| Finding | Consequence for Phase 2/3 |
|---|---|
| The SDK is ESM-only and calls `createRequire(import.meta.url)`; bundling it into the CJS main bundle builds but throws `ERR_INVALID_ARG_VALUE` at runtime. Loading it as an external via `await import('@anthropic-ai/claude-agent-sdk')` works under Electron. | Main bundle keeps the SDK **external** (like `node-pty`): add to `external` in `build.mjs`, to `build.files` and `asarUnpack` in package.json, load lazily with dynamic `import()`. Phase 2 PR 1 does the packaging change and re-runs `dist:win` + smoke. |
| `query()` with `sessionId` (new) / `resume` (existing) works; `system/init` echoes our id; partial `stream_event`s arrive; `result` carries `duration_ms`, `total_cost_usd`, `usage`. | Translation layer as planned. Passing an existing id as `sessionId` fails with `Session ID … is already in use` — host must branch new vs resume. |
| Permission round-trip: `PreToolUse` hook → `canUseTool` → `PermissionRequest` hook, in that order; a delayed `allow` executes the tool. | `canUseTool` is the permission seam for chat-mode sessions; in-process `hooks` give the same events without the HTTP transport. |
| `interrupt()` resolves, then the **async iterator throws** `Claude Code returned an error result: [ede_diagnostic] result_type=user …` instead of yielding an error `result`. | Host wraps the iterator; a throw after an interrupt maps to `stopReason: 'cancelled'`, any other throw to `'error'` (sanitised message, length-logged). |
| `resume` does not re-stream history (`system 2, assistant 1, result 1` for the follow-up); `getSessionMessages` returns the turns (tool_use/tool_result pairs intact). | History on open comes from `getSessionMessages`, not from the stream — as planned. |
| SDK-created sessions appear in `listSessions()` **with the default `includeProgrammatic`** and `claude -r <id>` resumes them (exit 0). | No "copy resume command" workaround needed; §8 risk retired. |
| **No per-session lock.** With the SDK query parked on `canUseTool`, a concurrent `claude -r <id> -p "say hi"` completed normally (exit 0, 8.2 s) and wrote into the same transcript; no new session file. | DW's terminal-handoff **agent restart dance is dropped**. Phase 3 keeps a *policy* gate (composer disabled while a pty owns the session) purely to avoid two writers interleaving turns in one transcript — nothing to release or reclaim. |
| `forkSession`, `renameSession`, `tagSession`, `deleteSession`, `getSessionInfo` all work; a fork is resumable and carries title/tag. | Phase 1 registry mutations map 1:1 onto SDK calls. |
| After `close()` the `claude.exe` child exits 2–7 s later; no orphan. | `shutdown()` must await child exit with a bounded wait (≈ 8 s) then taskkill, mirroring `terminalHost.dispose()`. |
| No `WT_SESSION`/`TERM_PROGRAM` shim needed for SDK-spawned processes. | Shim stays pty-only. |

## 2. Spike B — Hooks transport: **HTTP hooks confirmed; event set revised**

| Finding | Consequence for Phase 4 |
|---|---|
| `type: "http"` hooks injected via `--settings` work on 2.1.296/2.1.302 with `Authorization: Bearer $CLAUDE_WORKSPACES_HOOK_TOKEN` + `allowedEnvVars`. No curl fallback needed. | Transport design stands. |
| **`SessionStart` never fired** via `--settings`, neither in `-p` nor interactive mode. | "Running" detection for terminal/external sessions uses **`UserPromptSubmit`** as the start-of-activity signal; `Stop` = turn finished; `SessionEnd` = process gone. `SessionStart` is dropped from the injected set (keep trying it later — may be a flag-settings ordering issue, not worth a workaround now). |
| Re-probe on **2.1.302** (Phase 6 #11): `SessionStart` still never fires via `--settings` (`gotSessionStart:false`; all other events received in both headless and interactive runs). | Keep `SessionStart` in `HOOK_EVENTS` anyway (harmless — simply never arrives); activity still keys on `UserPromptSubmit`. |
| Interactive run produced `UserPromptSubmit`, `PermissionRequest(Write)`, `Notification{permission_prompt}`, `PostToolUse(Write)`, `Stop`. **`idle_prompt` did not arrive within 90 s.** | Notifications: *waiting for permission* comes from `PermissionRequest` (and the `Notification` duplicate — de-dup by `session_id`+`prompt_id`); *needs your reply* is derived from `Stop` with no subsequent `UserPromptSubmit` after N seconds (app-side timer), not from `idle_prompt`. |
| The `if: "Bash(gh pr *)"` filter did **not** restrict the `PostToolUse` http hook (fired for `Write`). | Use `matcher: "Bash"` on `PostToolUse` and filter `tool_input.command` server-side in the listener; drop `if`. |
| The user's default permission mode is **`auto`**: nothing prompts, so `PermissionRequest` never fires unless the launch passes `--permission-mode default` or a tool is not auto-approvable. | The app's "waiting for permission" notification is best-effort under `auto`; document it. Default launch permission mode becomes a Settings field (`claude.defaultPermissionMode`) as already planned for Phase 6 — pull it into Phase 2. |
| An unreachable hook URL does not break the CLI, but `claude -p` exits only after the hook `timeout` (5 s). `SessionEnd` hooks log `Hook cancelled` on stderr yet still deliver. | Hook `timeout: 2`. Listener always replies `{}` immediately. |
| Project `.claude/settings.json` hooks and `--settings` hooks **both fire** (arrays concatenate). Project settings are trust-gated — a cwd that was never trusted prompts. | No clobbering. The trust prompt matters for Phase 3 ptys in new folders; chat-mode (SDK, non-TTY) skips it. |

## 3. Spike C — Session store: **Phase 1 reads through the SDK**

| Finding | Consequence for Phase 1 |
|---|---|
| `listSessions()` across all projects: 46 sessions in **45 ms**; `summary`, `firstPrompt`, `gitBranch`, `cwd`, `createdAt`, `lastModified`, `fileSize` present on every entry; `customTitle` on 25; `tag` on 0. `getSessionMessages` on the largest (536 KB) file: **8 ms**. | Bar met by two orders of magnitude. `core/claudeTranscript.ts` is **not written**; the registry's disk side is `listSessions` + `getSessionInfo`. |
| Directory walk found 47 files; the SDK omitted 1 whose first line is `type: "mode"` (no messages). `includeProgrammatic` made no difference on this store. | Omission is correct behaviour (nothing to show). Keep `includeProgrammatic: true` so app-created sessions are never hidden. |
| `fs.watch(~/.claude/projects, { recursive: true })` works on Windows: first event 667 ms after the prompt, ~4 events per turn, result at ~2 s. | Change detection = recursive `fs.watch` → 250 ms debounce → `listSessions()` (45 ms) diff. No tail-parser. Live "running" state for sessions we did not launch comes from hooks (§2) plus "file changed in the last 30 s" as a weak signal. |
| Subagent transcripts live in `<sessionId>/subagents/agent-<id>.jsonl`; `listSubagents`/`getSubagentMessages` return them. They are not sessions. | Decision 6 (nest sidechains) is implemented as **"Subagents" children under the session node**, read lazily on expand — not as a parent/child relation between top-level sessions. |
| `summary` precedence: `customTitle` > `aiTitle` > `firstPrompt`. `history.jsonl` adds nothing. | Sidebar title = `summary`; registry `customTitle` override is unnecessary — use `renameSession` (writes a `custom-title` line the CLI also honours). |

## 4. Cross-cutting
- **CLI self-update mid-run (2.1.296 → 2.1.302) while SDK 0.3.296 (manifest 2.1.296) kept working.** Phase 2 adds the version check as a *warning* only; the coupling is looser than feared.
- Pinned SDK stays `0.3.296` until Phase 2, when the newest ≥ 7-day-old version is re-evaluated.
- Side effects of the probes: `hasTrustDialogAccepted` entries for deleted temp dirs in `~/.claude.json`; three probe sessions in `~/.claude/projects` (temp cwds). Harmless; the registry will show them until archived.

## 5. Verdict summary
| Spike | Verdict |
|---|---|
| A | Option A (Agent SDK in main) **confirmed**; SDK external + dynamic import; no session lock → Phase 3 restart dance dropped |
| B | HTTP hooks **confirmed**; `SessionStart`/`idle_prompt` unavailable → activity model built on `UserPromptSubmit`/`Stop`/`SessionEnd`/`PermissionRequest` |
| C | **SDK store API** replaces the own-parser design; `fs.watch` + `listSessions` for change detection; subagents nest under their session |

## Phase 8 — Execution hosts (WSL)

Verdicts backing `plans/exec-hosts-wsl.md`. Probe evidence: `docs/evidence/hosts-probe.json` (enumeration/probe/env/UNC/watch/hooks, two distros), `docs/evidence/claude-sdk-probe-node-*.jsonl` (`--host wsl:Ubuntu-22.04`), `docs/evidence/p4-acp-contract-wsl.jsonl`.

### Facts 0.1-1…6 (from the plan; re-verified by `hosts:probe` on 2026-10-19)
| Fact | Result |
|---|---|
| 0.1-1 SDK → WSL claude via `spawnClaudeCodeProcess` | `wsl-new`: init, session id match, `plugins 4 / skills 19`; `wsl-resume-bash` resumed the transcript and the tool turn ran inside Linux (13.8 s) |
| 0.1-2 SDK store over UNC, `CLAUDE_CONFIG_DIR` read per call | `listSessions` → 233 sessions in 1625 ms over `\wsl.localhost\…\.claude` |
| 0.1-3 `fs.watch` over `\wsl.localhost` fails | `watchError: "EISDIR"` confirmed on this machine → the store's tiered poll for wsl hosts |
| 0.1-4 Hook reachability from inside the distro | `loopback: "ok"` (curl → Windows 127.0.0.1 server 200; mirrored networking); `veth: "no-veth"` on this box |
| 0.1-5 `wsl.exe` refuses a UNC process cwd | kept — spawns pass `--cd <linux cwd>` with a Windows-side `cwd` of the user home |
| 0.1-6 Distro facts | `Ubuntu-22.04` Running+default, `Ubuntu-24.04` Running, `wsl-vpnkit` Stopped (enumeration 97 ms); probe line 179 ms (`home`, user, `/bin/bash`); `inotifywait` absent in both distros → tiered poll |

### Q2 — Interactive `-ilc` env capture vs plain spawn (hosts-probe, Ubuntu-22.04)
| Launch | Vars | Delta |
|---|---|---|
| `wsl.exe -e env` (plain) | 17 | baseline |
| `bash -ilc` capture | 45 in 688 ms | adds `SSH_AUTH_SOCK`/`SSH_AGENT_PID`, `GITHUB_TOKEN`, `JAVA_HOME`, `NVM_*`, `SDKMAN_*`, `AWS_PROFILE`, `DATADOG_API_KEY`, `LAUNCHDARKLY_API_KEY`, `NPM_TOKEN`, `LS_COLORS`, `*_SERVICE_PATH` — PATH head `/home/brian/.local/bin:/opt/google/chrome:/home/brian/bin`; `ssh-add -l` exit 0 under it |

### Q4 — `system/init` inside the distro (`claude:sdk-probe --host`)
`plugins: 4`, `skills: 19`, `initFieldsPresent: true` — the distro user's `~/.claude` settings/skills/plugins load with `settingSources` on; the resumed Bash turn printed `SSH_AUTH_SOCK` (`sawSockPath`), `which node` (`sawNodePath`) and `pwd` = distro home (`pwdIsHome`).

### Lead-verified through the app on 2026-10-19
- `wsl:Ubuntu-22.04` reached `ready` in <10 s; env capture 45 vars in 668 ms incl. `SSH_AUTH_SOCK`/`GITHUB_TOKEN`/`JAVA_HOME`; hooks `ok`.
- Sidebar merged 231 WSL + 3 local rows; a new session under `\wsl.localhost\Ubuntu-22.04\home\brian` → `host: wsl:Ubuntu-22.04`, `cwd: /home/brian`.
- A live turn ran a Bash permission prompt → approved → tool output `/tmp/ssh-XXXXXXQzenLh/agent.579` (SSH_AUTH_SOCK), `/home/brian/.local/bin/node` (which node), `/home/brian` (pwd); cost $0.20.

### ACP contract in WSL (`DEVIN_WORKSPACES_HOST=wsl:Ubuntu-22.04`)
All 9 checks pass against the real `devin acp` inside the distro spawned via `spawnSpec` + captured env (initialize/new/prompt/cancel/list/load → `status: "pass"`).
