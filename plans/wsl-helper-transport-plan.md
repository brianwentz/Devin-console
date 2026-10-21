# WSL Helper Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app from crashing or hanging WSL by removing all Windows-side `\\wsl.localhost` (9P) filesystem access and the recurring `wsl.exe` churn.
- A P0 hotfix ships first.
- Then a single long-lived in-distro Node helper is reached over `wsl.exe` stdio, and later over `ssh.exe`.

**Architecture:** There are four PRs, P0 → P3.
- **P0** tunes the existing UNC code. It drops the re-list on every transcript change, replaces the poll with a cheap change check, and cuts the spawn cadence.
- **P1–P2** add `src/helper/`, an esbuild ESM bundle that embeds the Agent SDK.
  - It speaks NDJSON JSON-RPC defined in pure `src/core/hostRpc.ts`.
  - A per-host `HostChannel` (`src/main/hostChannel.ts`) drives it.
  - Every remote-host consumer moves onto the channel, and the UNC paths are deleted.
- **P3** adds an `ssh:<alias>` host kind over the same helper.

**Tech Stack:** TypeScript, Electron 44 main, esbuild, Node ≥ 18 inside the distro, `@anthropic-ai/claude-agent-sdk@0.3.296`, vitest, Playwright `_electron`.

**Spec:** `plans/wsl-helper-transport.md`. Phase 0 context: `docs/plans/wsl-ssh-transport/{exploration.md,research-wsl-bugs.md,institutional-context-brief.md}`.

## Global Constraints

- **Helper runtime:**
  - Node `>=18` in the distro, resolved from the interactive-login env.
  - No Node → `node-missing`, and **no UNC fallback**.
  - Bundle format `esm`, at most 3 MB.
- **Paths:**
  - The stored `\\wsl.localhost\<D>\…` paths stay the host identity. No migration.
  - Helper paths are absolute, built from the probed home. Never use `~`.
- **Distro lifecycle:** a stopped distro is never started implicitly.
- **Logging:**
  - Logs carry ids, counts and ms only. Never env values, paths, cwd, tokens or process output.
  - Every new event, env var and test hook goes into the AGENTS.md tables in the same PR.
- **Code boundaries:**
  - `src/core/` stays pure.
  - IPC is zod-validated in `src/shared/ipc.ts` and guarded with `ipcGuard`.
- **Settings:** changes go into the zod schema, `SETTINGS_PRESERVE_SPEC` and `tests/unit/storePreserve.test.ts`, then `npm run smoke:install`.
- **Packaging:** the 180 MB installer budget holds, and no SDK platform packages ship.
- **Docs:** AGENTS.md stays CRLF. README.md is updated with every user-visible change.
- **Every PR:** `npm run typecheck && npm run lint && npm run test:unit && npm run build && npm run test:e2e`.
- **Protocol constants:**

  | Constant | Value |
  |---|---|
  | `HELPER_PROTOCOL` | `1` |
  | `MAX_FRAME_BYTES` | 32 MB |
  | Silence before a `ping` | 15 s |
  | Kill after silence | 45 s |
  | Default request timeout | 10 s (`store.list` / `usage.scan`: 60 s) |
  | `hello` deadline | 20 s |
  | Exit within this long after `hello` = failed start | 60 s |
  | Failure-count reset | after 60 s stable `ready` |
  | `BACKOFF_MS` | `[60_000, 120_000]` |
  | Breaker | opens on the 3rd consecutive failure |
  | Helper watch debounce | 250 ms |
  | Old-helper cleanup age | 7 days (helper touches its own file at start and hourly) |
| Missing-helper exit code | `86` (launch line `test -f <file> \|\| exit 86`) → redeploy, not a failure |

## Review Focus

1. **rc-file noise.** A helper whose rc files print junk before `hello` must be ignored without crashing. Pinned in Task 5, `ignores noise before hello`.
2. **The distro stops or `wsl --shutdown` runs while the channel is live.** Expect `reconnecting` and no respawn while enumeration says `Stopped`. Pinned in Task 8, `stopped distro is not respawned`.
3. **Very large data.** A history over 32 MB, or a 716-transcript list, must page and fit the timeouts. Pinned in Task 7, `store.messages pages until short page`, and Task 5, `oversize frame → too-large, decoder resyncs`.
4. **Two app instances or helper versions in one distro.** Neither may delete the other's helper file. Pinned in Task 7, `cleanup keeps files touched within 7 days`.
5. **A wedged VM (#41830).** The helper process is alive but silent, or says `hello` and dies at once. It must be killed after 45 s of silence and must not respawn in a loop. Pinned in Task 8 (`FAKE_WSL_HELPER_HANG`) and Task 5 (`exit within 60 s of hello counts as a failed start`).

---

## Phase P0 — Hotfix on the current code (PR 1)

### Task 1: Stop watch-driven full re-lists; cheap WSL change check

**Files:**
- Create: `src/core/claudeWatchPolicy.ts`.
- Modify: `src/main/claude/sessions.ts:116-135` (`storeForHost` `onChange`).
- Modify: `src/main/claude/store.ts`:
  - `:16-21` constants
  - `:222-234` `startTieredPoll`
  - `:238-278` `hotTick`
  - `:283-314` `recomputeHotPaths`, to be deleted
  - `:373-395` `startPoll`
- Test: `tests/unit/claudeWatchPolicy.test.ts`, `tests/e2e/hosts.spec.ts`.

**Interfaces:**
- Produces, in `src/core/claudeWatchPolicy.ts`:
  - `watchAction(host: ExecHost, files: string[]): 'history-only' | 'refresh'`. It returns `'history-only'` for a WSL host with a non-empty `files` list, else `'refresh'`.
  - `dirsChanged(prev: Map<string, number> | null, next: Map<string, number>): boolean`. It returns true when a dir was added, removed, or has a changed mtime. A `null` prev counts as changed.
- Produces: `WSL_CHANGE_CHECK_MS = 300_000` in `store.ts`.

- [ ] **Step 1: Write the failing unit tests.**
  - `watchAction(wslHost('D'), ['p/x.jsonl']) === 'history-only'`
  - `watchAction(wslHost('D'), []) === 'refresh'`
  - `watchAction(LOCAL_HOST, ['p/x.jsonl']) === 'refresh'`
  - `dirsChanged(null, m) === true`
  - `dirsChanged(m, new Map(m)) === false`
  - A changed mtime returns true. An added or removed key returns true.
- [ ] **Step 2: Run** `npx vitest run tests/unit/claudeWatchPolicy.test.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement both functions.** In the `onChange` handler, call `refresh('watch')` only on `'refresh'`, and always call `onTranscriptFiles(files)`.
- [ ] **Step 4: Change the WSL watch path in `store.ts`.**
  - Every `WSL_CHANGE_CHECK_MS`, `startPoll` builds `Map<projectDir, mtimeMs>` with `readdir(projects)` plus `stat` of each project directory. It calls `onChange([])` only when `dirsChanged` is true.
  - `hotTick` stats only the transcripts of `hotIds()`. Each is resolved once via `transcriptFor` and cached.
  - Delete `recomputeHotPaths` and the recent-20 set.
  - Log `claude-watch {mode:'poll-wsl', host, events}`.
- [ ] **Step 5: Add the e2e test** `a WSL transcript change does not trigger a full claude-list` in `tests/e2e/hosts.spec.ts`.
  - Append to a fixture transcript that is not terminal-owned, then wait 5 s.
  - Assert no new `claude-list` event has `source:'watch'`.
  - The existing `terminal-owned WSL session reloads history on a transcript change` test must still pass.
- [ ] **Step 6: Run** `npm run test:unit && npm run build && npx playwright test tests/e2e/hosts.spec.ts`. Expected: PASS.
- [ ] **Step 7: Commit** with the message `fix(hosts): no watch-driven re-lists over UNC; cheap WSL change check`.

### Task 2: Cut UNC usage scans, gate hook writes, count and cut wsl.exe

**Files:**
- Modify: `src/main/claude/usage.ts:566-719` (`runScan` / `scanAll` host list) and `ClaudeAnalyticsPanel.tsx` (find it with `rg -l ClaudeAnalyticsPanel src/shell`).
- Modify: `src/main/claude/hooksInstall.ts:11-65` and `src/main/claude/hooks.ts:78-108`.
- Modify: `src/main/hosts.ts`:
  - `:38-39` `ENV_CACHE_MS`
  - `:153-198` `runWsl`/`execWsl`
  - `:205-250` `enumerate`/`enabledDistros`
  - `:321` `statuses`
  - `:656-695` `spawnOn`/`execOn`
  - the `onStatusChange` sites at `:235` and `:484`
- Modify: `src/main/claude/backgroundAgents.ts:17-25`.
- Test:
  - `tests/unit/hooksGate.test.ts` (new)
  - `tests/unit/hostStatusDiff.test.ts` (new)
  - `tests/e2e/claudeUsage.spec.ts`
  - the hooks e2e spec (`rg -l claudeHooksSettingsPath tests/e2e`)

**Interfaces:**
- Produces, in `src/core/claudeHooks.ts`: `hooksApplyKey(hostId: HostId, enabled: boolean, block: unknown): string`.
- Produces, in `src/core/execHost.ts`: `statusesChanged(prev: HostStatus[] | null, next: HostStatus[]): boolean`. It compares structure and ignores timestamps.
- Changes: `applyGlobalHooks(...)` keeps its parameters and becomes async, returning `Promise<{installed: boolean; error: string | null}>`. It uses `fs/promises`.
- Changes: `HooksController.applyHooks(): void` keeps its signature. Internally it is coalesced: one run in flight plus one dirty follow-up. `lastApplied: Map<HostId, string>` is written **only on success**, so an error retries on the next trigger.
- Produces: log `host-exec {host, kind: 'enum'|'probe'|'env'|'exec'|'spawn'}` from every `wsl.exe` call site.
- Produces: `ClaudeUsageState.wslTotalsPaused: boolean`.

- [ ] **Step 1: Write the failing unit tests.**
  - `hooksApplyKey` is stable for equal input and changes when `enabled` or a block URL changes.
  - `statusesChanged(null, x)` is true. `statusesChanged(x, clone(x))` is false.
  - A changed `state`, `env.ok` or `claude.path` returns true.
- [ ] **Step 2: Run** `npm run test:unit`. Expected: FAIL.
- [ ] **Step 3: Implement the helpers and the gating.**
  - `onStatusChange` fires only when `statusesChanged` is true.
  - `statuses()`, `list()` and `enabledDistros()` read the cached rows and never call `enumerate()`.
  - Enumeration runs on:
    - a 5-minute `setInterval`;
    - window focus, when the cache is older than `ENUM_CACHE_MS`;
    - `refresh()`;
    - once at start.
  - `ENV_CACHE_MS = 10 * 60_000`.
  - `backgroundAgents` uses 120 s focused / 300 s blurred for WSL hosts, and keeps 15 s / 60 s for local.
  - Add `host-exec` logging at every `wsl.exe` call site.
  - Extend the existing probe line with `command -v node >/dev/null && node -p process.versions.node || echo NONODE`. Record it as `HostStatus.node: string | null`. Don't add a spawn; this tells us before P1 whether each distro has Node.
- [ ] **Step 4: Skip WSL hosts in `runScan`/`scanAll`.**
  - Set `wslTotalsPaused` when any WSL host is ready.
  - The panel shows `#claudeWslTotalsPaused`, reading "Token totals for WSL distros are paused".
  - Leave `readAccounts` and the `/usage` fetch unchanged.
- [ ] **Step 5: Update the e2e tests.**
  - `claudeUsage.spec.ts:243`: the WSL byHost bucket is absent and `#claudeWslTotalsPaused` is visible.
  - Keep `:304` (the scan racing a swap). Re-target it to assert that the **local** bucket is not polluted while a `withConfigDirHold` is held, since `store.list` still swaps until P2.
  - Hooks spec: two `hostRefresh()` calls with unchanged settings leave the `settings.json` mtime unchanged. A failed apply (read-only file) retries on the next refresh.
- [ ] **Step 6: Run** `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e`. Expected: PASS.
- [ ] **Step 7: Update the docs.**
  - AGENTS.md (CRLF):
    - the cadence notes in Execution hosts and Analytics;
    - `claude-watch mode:'poll-wsl'`;
    - `host-exec` in the log table;
    - `wslTotalsPaused`.
  - README Analytics: add one sentence on paused WSL totals.
- [ ] **Step 8: Commit** with the message `fix(hosts): stop UNC usage scans, gate hook writes, count and cut wsl.exe`.

### Task 3: P0 soak evidence

**Files:**
- Modify: `scripts/hosts-probe.ts` to add a `--soak <minutes>` mode.

- [ ] **Step 1: Implement `--soak`.**
  - Copy the real userData into a temp dir.
  - Launch the built app with `AGENT_WORKSPACE_USER_DATA=<copy>` and `AGENT_WORKSPACE_LOG=<tmp>`.
  - After N minutes, count `host-exec` events (total and by kind), WSL `claude-list` events, and the WSL file counts from `usage-scan`.
  - Write the result as `soak` into `docs/evidence/hosts-probe.json`.
- [ ] **Step 2: Run the soak on the user's machine.** Use 2 distros and one active WSL Claude chat: `npm run hosts:probe -- --soak 30`. Run it on the pre-P0 build and on the P0 build.
  - Expected on P0:
    - `host-exec` ≤ 2.0/min total, excluding the chat's own long-lived spawn;
    - WSL `claude-list` ≤ 0.4/min;
    - WSL usage-scan files = 0.
  - Put both sets of numbers in the PR body.
- [ ] **Step 3: The user re-runs the workload that crashed before.** Record the result in the PR body.
  - The PR body also states that rows of sessions started outside the app update within 5 minutes, or on entering the Claude surface.
- [ ] **Step 4: Commit** with the message `chore(probe): soak mode for wsl exec/list cadence`, then open PR 1.

---

## Phase P1 — Helper + WSL channel: store, history, hooks, agents and env over RPC (PR 2)

### Task 4: Bundling spike (throwaway result, kept as a build check)

**Files:**
- Create: `scripts/helper-bundle-check.mjs`.

- [ ] **Step 1: Write a script that builds a minimal ESM bundle.**
  - Use `platform:'node'`, `target:'node18'`, `format:'esm'`, `bundle:true`.
  - The entry imports the SDK's `listSessions`, `getSessionInfo` (exported, `sdk.d.ts:876`), `getSessionMessages`, `listSubagents`, `getSubagentMessages`, `renameSession`, `forkSession` and `deleteSession`.
  - Run the bundle with `node bundle.mjs <claude-home-copy>` and call each function against a temp copy of `tests/fixtures/claude-home`.
- [ ] **Step 2: Run the bundle under each Node major:**
  - Node 24 (local);
  - Node 18 and 20 (`npx -y node@18 bundle.mjs …`, `npx -y node@20 …`);
  - Node 22 inside the user's real WSL distro (`wsl.exe -d Ubuntu-22.04 -e node …`).
  - Expected: every call succeeds and the bundle is < 3 MB.
  - If `getSessionInfo` is not exported in 0.3.296, record that. Task 7 then falls back to `listSessions` filtered to the changed ids, done in the helper natively.
- [ ] **Step 3: Record the results** (size, Node versions, the export list) in the PR 2 body. Keep the script as `npm run helper:check`, which CI runs after `build`.
- [ ] **Step 4: Commit** with the message `chore(helper): ESM bundle feasibility check`.

### Task 5: Protocol core (`src/core/hostRpc.ts`)

**Files:**
- Create: `src/core/hostRpc.ts`.
- Test: `tests/unit/hostRpc.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export const HELPER_PROTOCOL = 1;
  export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
  export const BACKOFF_MS = [60_000, 120_000] as const;
  export const STABLE_MS = 60_000;
  export type RpcRequest = { id: number; method: string; params: unknown };
  export type RpcResponse = { id: number; result?: unknown; error?: { code: string; message: string } };
  export type RpcNotification = { method: string; params: unknown };
  export type Hello = { protocol: number; hash: string; node: string; pid: number; home: string; watchMode: 'watch' | 'poll' };
  export class LineDecoder { push(chunk: Buffer | string): Array<unknown | FrameTooLarge> }  // skips non-JSON lines; oversize → FrameTooLarge item, then resyncs at next '\n'
  export function encodeFrame(msg: RpcRequest | RpcResponse | RpcNotification): string;
  export type BreakerState = { failures: number; open: boolean; nextAttemptAt: number | null; readySince: number | null };
  export function onStartFailed(s: BreakerState, now: number): BreakerState;  // failures+1; open when failures === BACKOFF_MS.length + 1 (3); else nextAttemptAt = now + BACKOFF_MS[failures-1]
  export function onReady(s: BreakerState, now: number): BreakerState;        // readySince = now
  export function onExit(s: BreakerState, now: number): BreakerState;         // readySince && now-readySince < STABLE_MS → onStartFailed; else failures=0
  export function onTick(s: BreakerState, now: number): BreakerState;         // readySince && now-readySince >= STABLE_MS → failures=0
  export function resetBreaker(): BreakerState;
  ```
- [ ] **Step 1: Write the failing tests.**
  - `decodes split chunks`
  - `ignores noise before hello`
  - `oversize frame → too-large, decoder resyncs`
  - `encodeFrame round-trips`
  - `breaker opens on 3rd failure with 60/120 s spacing (both BACKOFF_MS steps used)`
  - `exit within 60 s of hello counts as a failed start`
  - `reset only after 60 s ready`
- [ ] **Step 2: Run** `npx vitest run tests/unit/hostRpc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(core): host helper RPC framing and breaker`.

### Task 6: Launch spec, probe extension and deploy

**Files:**
- Modify:
  - `src/core/execHost.ts` (`helperSpec`, `helperDeploySpec`)
  - `src/main/hosts.ts:392-450` (the probe line, deploy)
  - the `HostStatus` type
- Modify: `tests/fixtures/fakeWsl.ts`.
- Test: `tests/unit/execHost.test.ts`.

**Interfaces:**
- Consumes: `out/helper/helper-hash.json`. Task 7 builds it. Until it exists, main treats the helper as unavailable: no deploy, no channel, and the UNC paths are unchanged. Existing WSL e2e specs stay green between Tasks 6 and 7.
- Produces:
  - `helperSpec(host: ExecHost, home: string, shell: string, hash: string): HostSpawnSpec`
    - argv: `['-d', D, '--cd', home, '-e', shell, '-ilc', 'test -f "$0" || exit 86; exec node "$0" --stdio', `${home}/.agent-workspace/helper-${hash}.mjs`]`
    - fish uses `'test -f $argv[1]; or exit 86; exec node $argv'`.
  - `helperDeploySpec(host, home, hash): HostSpawnSpec`, per spec §2.1.
  - `HostStatus.helper: { state: 'absent'|'starting'|'ready'|'reconnecting'|'degraded'|'node-missing'|'unsupported-node'; node: string | null; watchMode: 'watch'|'poll'|null }`.
- [ ] **Step 1: Write the failing tests.**
  - `helperSpec` for bash, zsh and fish is byte-exact.
  - It contains no `~` and no UNC.
  - `/home/a b` is passed as one argv element.
  - With no `out/helper/helper-hash.json`, `helperAvailable()` is false and no deploy is attempted.
  - `helperDeploySpec` passes the dir and the name as `$1` and `$2`.
- [ ] **Step 2: Implement** both specs.
- [ ] **Step 3: Extend the existing probe line** with the `NONODE` / `HELPER_PRESENT` checks from spec §2.1. Do not add a spawn.
  - Parse the result into `status.helper`: `node-missing`, or `unsupported-node` when the major is < 18, else `absent` or present.
  - When the helper is absent, deploy it with `spawnOn(helperDeploySpec)` and the bundle on stdin.
  - Log `host-helper-deploy {host, ok, bytes, ms}`.
- [ ] **Step 4: Extend `fakeWsl.ts`.**
  - Emulate the new probe tokens: `FAKE_WSL_NO_NODE=1` → `NONODE`, `FAKE_WSL_NODE_VERSION` (default `22.0.0`).
  - Emulate the deploy line in JS: write stdin to `<ROOT>/<dir>/<name>`.
  - Run the helper launch with `spawn(FAKE_WSL_NODE ?? 'node', [mappedPath, '--stdio'], {stdio:'pipe'})`. Set `HOME` and `CLAUDE_CONFIG_DIR=<ROOT><FAKE_WSL_HOME>/.claude`, and pipe stdin/stdout/stderr through.
  - `FAKE_WSL_HELPER_HANG=1` stops forwarding the child's stdout after the first line.
  - Update the header comment.
- [ ] **Step 5: Run** `npm run test:unit`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(hosts): helper launch spec, node probe, stdin deploy`.

### Task 7: The helper (`src/helper/`)

**Files:**
- Create:
  - `src/helper/main.ts`: the stdio loop, `hello`, dispatch, exit on stdin EOF/SIGTERM/SIGHUP, touch-self, and cleanup of files older than 7 days
  - `src/helper/store.ts`
  - `src/helper/watch.ts`
  - `src/helper/hooks.ts`
  - `src/helper/agents.ts`
- Modify: `scripts/build.mjs` (the helper entry, hash file, 3 MB assert).
- Test:
  - `tests/unit/helper/store.test.ts`
  - `tests/unit/helper/watch.test.ts`
  - `tests/unit/helper/main.test.ts`
  - `tests/unit/helper/hooks.test.ts`

**Interfaces:**
- Consumes: `LineDecoder`, `encodeFrame`, `HELPER_PROTOCOL` (Task 5); `mergeHooksIntoSettings` / `removeHooksFromSettings` (`src/core/claudeHooks.ts`).
- Produces these RPC methods, per spec §2.3:

  | Method | Returns |
  |---|---|
  | `ping` | — |
  | `env.get` | `{env, watchMode}` |
  | `store.list` | — |
  | `store.rename` / `store.fork` / `store.delete` | — |
  | `store.listSubagents` | — |
  | `store.messages {sessionId, offset, limit≤500}` | `SDKMessage[]` |
  | `store.subagentMessages` | — |
  | `store.transcriptPath` | — |
  | `watch.subscribe` | then `store.changed {files, sessions, removed}` notifications |
  | `hooks.apply {enabled, port, token, addr?}` | `{installed, error, changed}` |
  | `agents.list` | `{stdout}` |

- Produces: `out/helper/agent-workspace-helper.mjs` and `out/helper/helper-hash.json` (`{hash}`).
- [ ] **Step 1: Write the failing tests.** They run the helper modules on Windows Node with `CLAUDE_CONFIG_DIR` pointed at a temp copy of `tests/fixtures/claude-home`.
  - `store.list returns fixture sessions`
  - `store.messages pages until short page`
  - `watch emits {files, sessions} within 1 s of an append, debounced`
  - `deleted transcript → removed`
  - `new project dir is watched`
  - `main replies hello first and exits on stdin EOF`
  - `touches its own file hourly` (fake timers)
  - `unknown method → unknown-method`
  - `cleanup keeps files touched within 7 days`
  - `hooks.apply is idempotent, backs up once, off removes only ours`
- [ ] **Step 2: Implement.**
  - Watching uses non-recursive `fs.watch` on `projects/`, on each project dir, and on each `subagents/`.
  - On a watch error it falls back to a 5 s local stat poll of the newest 50, with `watchMode:'poll'`.
  - `agents.list` runs `claude agents --json --all` with `execFile` and a 5 s timeout.
- [ ] **Step 3: Add the esbuild entry** in `scripts/build.mjs`: `format:'esm'`, `target:'node18'`, `platform:'node'`, `bundle:true`.
  - Write the sha256-12 hash file.
  - Fail the build if the bundle is ≥ 3 MB.
- [ ] **Step 4: Run** `npm run test:unit && npm run build && npm run helper:check`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(helper): in-distro store/watch/hooks/agents helper`.

### Task 8: `HostChannel` and lifecycle

**Files:**
- Create: `src/main/hostChannel.ts`.
- Modify:
  - `src/main/hosts.ts`: `channel(host)`; `fsReady` = channel ready for WSL; `shellEnv` for WSL = `env.get`, cached for the channel's lifetime.
  - `src/main/testHooks.ts`: `hostHelperKill(id)`, `hostChannelState(id)`.
  - The Settings `#hostsBlock` row: helper state plus the `#hostHelperHint-<id>` Node hint.
- Test: `tests/e2e/hostsHelper.spec.ts` (new).

**Interfaces:**
- Consumes: `helperSpec` (Task 6) and the breaker functions (Task 5).
- Produces:
  ```ts
  export class HostChannel {
    constructor(host: ExecHost, spawn: () => ChildProcess, opts?: { silenceMs?: number; killMs?: number });
    readonly state: HostStatus['helper']['state'];
    start(): void; stop(): void; reset(): void;
    request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
    onNotification(method: string, fn: (params: unknown) => void): () => void;
    onState(fn: (s: HostStatus['helper']) => void): () => void;
  }
  // hosts.ts
  channel(host: ExecHost): HostChannel | null;
  ```
- **Start condition:** start only when enumeration reports the distro `Running` and the helper state is not `node-missing` or `unsupported-node`.
- **Stop and reset:**
  - An enumeration that reports `Stopped` → `stop()`, with no respawn.
  - `hosts:refresh` → `reset()`.
- **Liveness:** per the constants table.
- **Logs:**
  - `host-helper {host, state, reason?}`
  - `host-rpc-timeout {host, method, ms}`
  - `host-rpc-error {host, method, code}`
- **Test-only env vars:** `AGENT_WORKSPACE_TEST_HELPER_SILENCE_MS` and `AGENT_WORKSPACE_TEST_HELPER_BACKOFF_MS` (test mode only).
- [ ] **Step 1: Write the failing e2e tests.**
  - `deploy then hello → helper ready`
  - `killed helper reconnects` (via `hostHelperKill`)
  - `FAKE_WSL_HELPER_HANG → killed after silence → reconnect`
  - `three failed starts → degraded, no further spawns`: set `FAKE_WSL_NODE=/nonexistent` and count spawns with `FAKE_WSL_SPAWN_LOG`.
  - `helper file deleted while ready → exit 86 on respawn → redeploy → ready` (does not count toward the breaker).
  - `stopped distro is not respawned`
  - `FAKE_WSL_NO_NODE → node-missing + #hostHelperHint`
  - `env.get feeds spawnOn — no -ilc env-capture spawn after ready`, asserted with `FAKE_WSL_SPAWN_LOG`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run build && npx playwright test tests/e2e/hostsHelper.spec.ts tests/e2e/hostsStartup.spec.ts`. Expected: PASS.
- [ ] **Step 4: Commit** with the message `feat(hosts): per-host helper channel with silence watchdog and breaker`.

### Task 9: Claude store, history, hooks and agents over the channel

**Files:**
- Modify:
  - `src/main/claude/store.ts` (`StoreBackend`)
  - `src/main/claude/sessions.ts`: `:116-135`, `:335-376` (agents), `:424-470` (refresh), `:949-953` (`revealTranscript`)
  - `src/main/claude/host.ts:276,324`
  - `src/main/claude/hooksInstall.ts`, `src/main/claude/hooks.ts`
  - `src/main/claude/backgroundAgents.ts`
- Modify: `src/core/claudeRegistry.ts` (`patchSessions`).
- Test:
  - `tests/unit/sessionPatch.test.ts`
  - `tests/e2e/hostsHelper.spec.ts`
  - `tests/e2e/hosts.spec.ts`
  - the hooks e2e spec

**Interfaces:**
- Produces:
  ```ts
  interface StoreBackend {
    list(): Promise<SDKSessionInfo[]>;
    rename(id: string, title: string): Promise<void>; fork(id: string): Promise<string>; delete(id: string): Promise<void>;
    listSubagents(id: string): Promise<SubagentInfo[]>; messages(id: string): Promise<SDKMessage[]>;
    subagentMessages(id: string, agentId: string): Promise<SDKMessage[]>; transcriptPath(id: string): Promise<string | null>;
    watch(onChange: (ev: { files: string[]; sessions: SDKSessionInfo[]; removed: string[] }) => void): () => void;
  }
  // src/core/claudeRegistry.ts
  export function patchSessions(prev: SDKSessionInfo[], hostId: HostId, updated: SDKSessionInfo[], removed: string[]): SDKSessionInfo[];
  type SettingsFileIo = { read(): Promise<string | null>; writeAtomic(text: string): Promise<void>; backupOnce(): Promise<void> };
  applyGlobalHooks(io: SettingsFileIo, enabled: boolean, port: number, token: string, addr?: string): Promise<{installed: boolean; error: string | null}>;
  ```
  - `LocalBackend` wraps today's code, with `sessions: []` (a local change triggers a full refresh).
  - `ChannelBackend` uses RPC. `messages` pages until a page comes back shorter than requested.
  - WSL hooks call `hooks.apply` directly, not through the `SettingsFileIo` seam.
- [ ] **Step 1: Write the failing unit tests** for `patchSessions`: replace, insert, remove, and leave other hosts untouched.
- [ ] **Step 2: Write the failing e2e tests.**
  - `WSL sessions list via the channel`
  - `transcript append patches one row — no full claude-list`
  - `deleted WSL transcript removes its row`
  - `WSL history loads via store.messages`
  - `rename/delete via the channel`
  - `hooks install into the WSL settings.json via the channel`: assert the file under `FAKE_WSL_ROOT`.
  - `background agents list for WSL via the channel`
  - `Reveal transcript on a WSL session calls showItemInFolder with the \\wsl.localhost path`: record it in test mode and do not open Explorer.
- [ ] **Step 3: Implement.**
  - Delete the P0 change check, `hotTick` and the `inotifywait` path for WSL hosts.
  - Delete the fakeWsl `inotifywait` branch and `FAKE_WSL_INOTIFY`.
  - A full `list` runs only on start, channel `ready`, a mutation, or an explicit refresh.
- [ ] **Step 4: Extend `scripts/hosts-probe.ts`** with helper deploy ms, `hello` ms and `store.list` ms per distro.
  - Run it with `--soak 30` on the user's machine.
  - Expected:
    - Ubuntu-24.04 `store.list` < 1.5 s;
    - `host-exec` after startup ≤ 0.3/min, excluding chats and ptys;
    - the stopped `wsl-vpnkit` stays stopped.
- [ ] **Step 5: Run** `npm run test:unit && npm run test:e2e`. Expected: PASS, including `claudeSessions.spec.ts:469`.
- [ ] **Step 6: Update the docs.**
  - AGENTS.md:
    - the Execution hosts channel rule;
    - the new log events;
    - the env vars `AGENT_WORKSPACE_TEST_HELPER_*`, `FAKE_WSL_NODE*`, `FAKE_WSL_NO_NODE`, `FAKE_WSL_HELPER_HANG`; remove `FAKE_WSL_INOTIFY`;
    - the test hooks `hostHelperKill`, `hostChannelState`.
  - README, new section "Running sessions in WSL": Node ≥ 18, the `~/.agent-workspace/` folder, the `node-missing` status.
- [ ] **Step 7: Run** `npm run smoke:install`.
- [ ] **Step 8: Commit** with the message `feat(claude): WSL store, history, hooks, agents over the helper channel`, then open PR 2. Include the Task 4 and Task 9 evidence.

---

## Phase P2 — Usage over RPC; delete UNC; guard (PR 3)

### Task 10: Usage over the channel and the remaining UNC call sites

**Remote-path fs inventory.** Each row's disposition is implemented in this task unless marked otherwise.

| Call site | Today | Disposition |
|---|---|---|
| `usage.ts:225-275` `credsForHost`/`accountForHost` | `readFile` over UNC | → `usage.accounts` |
| `usage.ts:337-348` `staleBody` | `stat`+`readFile` `.usage-cache` | → `usage.accounts.usageCache` |
| `usage.ts:520-719` `walkJsonl`/`runScan` | walk + stream over UNC (paused in P0) | → `usage.scan` |
| `store.ts` / `host.ts` SDK calls | UNC via `withConfigDir` | → RPC (done in Task 9) |
| `hooksInstall.ts` | sync UNC writes | → `hooks.apply` (done in Task 9) |
| `sessions.ts:775-787` `pickerDefaultPath` + `core/pickerFolder.ts` `pickerStartPath(configured, distroHome, exists)` | `existsSync(windowsPath(home))` | drop the check for WSL homes; `exists` becomes `(p: string) => Promise<boolean>` (local: `fs/promises.access`; UNC `pickerFolder` → channel `fs.stat`); `pickerStartPath` becomes async and its unit tests are updated |
| `local/ipc.ts:109-121` `localWorkspacePick` | the same | the same |
| `sessions.ts:949-953` `revealTranscript` | `transcriptPath` readdir over UNC | → `store.transcriptPath` (done in Task 9) |
| `local/terminalHost.ts:184-192` `wslDistros` | sync `spawnSync(wsl -l -q)` | → `hosts().list()` |
| `local/terminalHost.ts:385` `existsSync(cwd)` | local branch only; WSL takes the linux cwd verbatim | none (verified local-only) |
| `local/acpHost.ts:271,436` `resolve(workspace)` | string only | none |
| native folder dialog | Explorer browses UNC on the user's click | documented exception until P3 |

**Files:**
- Create: `src/helper/usage.ts`, plus `fs.stat` in `src/helper/main.ts`.
- Modify: `src/main/claude/usage.ts`, `src/main/claude/sessions.ts:775-787`, `src/main/local/ipc.ts:109-121`, `src/main/local/terminalHost.ts:184-192`, `src/core/pickerFolder.ts` (+ `tests/unit/pickerFolder.test.ts`).
- Test: `tests/unit/helper/usage.test.ts`, `tests/e2e/claudeUsage.spec.ts`, `tests/e2e/hosts.spec.ts`.

**Interfaces:**
- Produces these RPC methods:
  - `usage.scan {months: string[]}` → `{buckets: UsageBuckets}`
  - `usage.accounts {}` → `{accessToken: string|null, expiresAt: number|null, email: string|null, org: string|null, usageCache: {body: string, mtimeMs: number}|null}`
  - `fs.stat {path}` → `{exists: boolean, dir: boolean}`
- [ ] **Step 1: Write the failing tests.**
  - Helper unit tests:
    - `usage.scan buckets equal aggregateUsageLines over the same fixture files`
    - `second scan reads only appended bytes` (spy on the bytes read)
  - e2e:
    - `WSL usage totals return via the channel`: the byHost bucket is present, and `#claudeWslTotalsPaused` is gone.
    - `WSL picker default path needs no Windows-side fs`
- [ ] **Step 2: Implement the inventory dispositions.**
  - The `accessToken` is held only in `UsageService` memory and is never logged.
  - Remove `wslTotalsPaused` and the panel note.
- [ ] **Step 3: Run** `npm run test:unit && npm run test:e2e`. Expected: PASS.
- [ ] **Step 4: Commit** with the message `feat(hosts): usage and remaining WSL fs over the helper channel`.

### Task 11: Delete the UNC paths, install the guard

**Files:**
- Modify:
  - `src/main/hosts.ts:742-765`: delete `withConfigDir`, `configMutex` and the remote branch of `configDir`; `captureEnv` stays local-only.
  - `src/main/testHooks.ts:132`: delete `withConfigDirHold`.
  - `tests/e2e/claudeUsage.spec.ts:304`: delete it, since the swap no longer exists.
- Create: `src/main/remoteFsGuard.ts`, installed in `index.ts` right after `bootstrap`.
- Modify: the e2e `launchApp` fixture (afterEach assertion).
- Test: `tests/unit/remoteFsGuard.test.ts`.

**Interfaces:**
- Produces: `installRemoteFsGuard(opts: { throwOnViolation: boolean; extraPrefixes: string[] }): void`.
  - It covers the prefixes and entry points from spec §3.3.
  - In test mode it throws `RemoteFsViolation`. In production it logs `remote-fs-violation {op}` once per op and passes the call through.
- Produces: the test hook `remoteFsViolations(): number`.
- [ ] **Step 1: Write the failing unit tests.**
  - `throws in test mode for each prefix`
  - `local paths pass`
  - `production logs once per op and passes through`
- [ ] **Step 2: Implement and delete.**
  - Specs write WSL fixtures under `FAKE_WSL_ROOT`, which the helper reads.
  - `AGENT_WORKSPACE_TEST_WSL_UNC_ROOT` remains only for path mapping and as a guard prefix.
- [ ] **Step 3: Assert in `launchApp` teardown:** `expect(await hook('remoteFsViolations')).toBe(0)`.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e`. Expected: PASS with zero violations.
- [ ] **Step 5: Run the real-machine soak:** `npm run hosts:probe -- --soak 30`.
  - Expected:
    - `host-exec` ≤ 0.3/min after startup, excluding chats and ptys;
    - `remote-fs-violation` = 0 in the log.
  - Put the numbers in the PR body.
- [ ] **Step 6: Update the docs.**
  - AGENTS.md:
    - remove the `withConfigDir` / S7 notes and the `withConfigDirHold` row;
    - add `remote-fs-violation` and the `remoteFsViolations` hook;
    - restate the native-dialog exception.
- [ ] **Step 7: Commit** with the message `refactor(hosts): remove UNC store access; guard against regressions`, then open PR 3.

---

## Phase P3 — `ssh:<alias>` host kind (PR 4)

### Task 12: SSH path form, quoting and specs (core)

**Files:**
- Modify:
  - `src/core/execHost.ts`: `HostId` gains `` `ssh:${string}` ``; update `hostIdForPath`, `toHostPath`, `displayPath`, `workspaceLabel`.
  - `src/core/workspaceTree.ts`: `workspaceFor`.
- Test: `tests/unit/execHost.test.ts`, `tests/unit/workspaceTree.test.ts`.

**Interfaces:**
- Produces:
  - `isSshHost(h)`
  - `sshHost(alias)`
  - `posixQuote(arg: string): string`, which single-quotes and escapes `'` as `'\''`
  - `sshSpawnSpec(alias, cwd, env, cmd, args)` → `ssh.exe -o BatchMode=yes -o ServerAliveInterval=15 -T <alias> -- cd <q cwd> && exec /usr/bin/env <q K=V>… <q cmd> <q args>…`
  - `sshPtySpec(...)`: the same with `-t` and `<shell> -ilc`
  - `sshHelperSpec(alias, home, shell, hash, reversePort?)`, which adds `-R <port>:127.0.0.1:<port>` when the port is set
  - `sshHelperDeploySpec(...)`
- Path form: `ssh://<alias>/<abs>`, where the alias matches `^[A-Za-z0-9._-]+$`.
- [ ] **Step 1: Write the failing tests.**
  - `ssh://box/home/u/x` round-trips to and from `{host:'ssh:box', path:'/home/u/x'}`.
  - `posixQuote` handles `a'b`, spaces, `$`, newlines and the Phase 8 7-argument round-trip set.
  - `workspaceFor` matches `ssh:box` cwds on segment boundaries.
  - An invalid alias is rejected.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run test:unit`. Expected: PASS.
- [ ] **Step 4: Commit** with the message `feat(core): ssh host kind path form and quoting`.

### Task 13: SSH hosts in main, settings and the remote folder input

**Files:**
- Modify:
  - `src/core/settings.ts`: `hosts.ssh: {alias, enabled}[]`, with a preserve spec of array-by-`alias`.
  - `src/main/hosts.ts`: ssh hosts in `list()`; probe, deploy and channel through `ssh.exe`; `spawnOn`/`ptySpawnSpec` dispatch.
  - Settings `#hostsBlock`: "Add SSH host…" (`#sshHostAdd`) and rows `[data-host-id="ssh:<alias>"]`.
- Create:
  - `src/shell/components/RemoteFolderInput.tsx`: a path field with directory autocomplete.
  - IPC `hosts:readdir` (`HostReaddirSchema {hostId, path}`) → `fs.readdir` RPC (directories only).
- Modify: `src/main/local/ipc.ts:109-121` and `src/main/claude/sessions.ts:775-787`, so non-local hosts use `RemoteFolderInput` (WSL included). This retires the native-dialog UNC exception.
- Create: `tests/fixtures/fakeSsh.ts` (`AGENT_WORKSPACE_TEST_SSH_CMD`), which reuses the fakeWsl runner after `--`.
- Test: `tests/unit/storePreserve.test.ts`, `tests/unit/settings.test.ts`, `tests/e2e/hostsSsh.spec.ts`.

**Interfaces:**
- Consumes: the Task 12 specs, `HostChannel` (Task 8), and the helper (Tasks 7 and 10).
- Produces: the log event `host-ssh {aliasHash, op}`, where `aliasHash` is sha256-8 of the alias. The alias itself is never logged.
- [ ] **Step 1: Write the failing tests.**
  - Unit:
    - the `hosts.ssh` schema;
    - unknown fields in an entry survive a save;
    - an invalid alias is repaired at leaf level.
  - e2e:
    - `add ssh host → helper ready → sessions listed with host chip`
    - `claude chat on an ssh workspace spawns via ssh -T with the quoted cwd`
    - `terminal uses ssh -t`
    - `RemoteFolderInput autocompletes via the channel and returns ssh://box/<path>`
    - `WSL workspace add uses RemoteFolderInput — no native dialog`
    - `hooks reach the listener through -R`
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e && npm run smoke:install`. Expected: PASS.
- [ ] **Step 4: Real-machine check.**
  - Add the user's WSL sshd alias.
  - Run `npm run hosts:probe -- --host ssh:<alias>`, after extending the probe to accept `--host ssh:`.
  - Expected: helper ready, the `store.list` time is recorded, and the argv round-trip is ok.
- [ ] **Step 5: Update the docs.**
  - README, new section "SSH hosts":
    - adding an alias;
    - BatchMode, meaning key or agent auth only;
    - Node ≥ 18 is required on the remote.
  - AGENTS.md: the settings key, env var, log event and DOM ids.
- [ ] **Step 6: Commit** with the message `feat(hosts): ssh host kind over the helper channel`, then open PR 4.
