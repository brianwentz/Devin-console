# Phase 9 — In-distro helper transport for WSL (and SSH) hosts

Status: Plan reviewed 2026-10-21 (rounds 1–2) — P0 in progress; revised after plan-review rounds 1–2 (breaker, ESM bundle, launch path, RPC trims, UNC inventory, spec/plan alignment).

Phase 8 (`exec-hosts-wsl.md`) chose option A: `wsl.exe` for processes, `\\wsl.localhost\<distro>` UNC (the 9P redirector) for every file the Windows side reads. Option C — a server in the distro, the VS Code Remote-WSL model — was rejected because it "would need Node in every distro and an update story", and §5 put "running the SDK or a helper inside the distro" out of scope. This phase reverses that decision on new evidence: with WSL hosts enabled, the user's whole WSL VM crashes or hard-hangs (new sessions fail, `\\wsl.localhost` stops answering, only `wsl --shutdown` or a reboot recovers).

## 0. Evidence

### 0.1 What the app does to 9P today (code audit, 2026-10-21)

Measured on the user's machine (`docs/evidence/hosts-probe.json`, 2026-10-19): Ubuntu-22.04 has 234 transcripts (UNC `listSessions` 1625 ms), Ubuntu-24.04 has 716 (UNC `listSessions` **9815 ms**, readdir scan 1847 ms). Neither has `inotifywait`, and `fs.watch` over UNC fails with `EISDIR`, so both run the tiered poll.

| Source | What it does over UNC | Cadence |
|---|---|---|
| `claude/store.ts` hot tick | `stat` of the recent-20 ∪ hot transcripts | every 2 s while the Claude surface is visible |
| → `sessions.ts` `onChange` | **every** changed transcript → `refresh('watch')` → SDK `listSessions` (reads every transcript head of every host) under the `withConfigDir` mutex | each hot-tick hit — continuous while any WSL session is writing |
| `store.ts` `startPoll` | `recomputeHotPaths` (readdir every project + stat every transcript) then `onChange([])` → another full `listSessions` | every 30 s per host |
| `claude/usage.ts` scan | full `projects/**` walk, 6 workers: stat + 1-byte read + incremental `createReadStream` | every 60 s while Analytics is visible, on start, on every `hosts` poke |
| `usage.ts` accounts | `readFile` `.credentials.json` + `.claude.json` | every usage fetch (60 s visible / 10 min hidden + pokes) |
| `claude/hooksInstall.ts` | **synchronous** `existsSync`/`readFileSync`/`copyFileSync`/`writeFileSync`/`renameSync` on `settings.json` | hook start, toggle, and every `onStatusChange` (incl. each 5-min re-enumeration) |
| `claude/host.ts` history | SDK `getSessionMessages`/`getSubagentMessages` (whole jsonl) | open; 1 s after each change of a terminal-owned transcript |
| pickers | `existsSync` of the distro home; the native dialog browses UNC | user-initiated |

`wsl.exe` churn per enabled distro, on top of the long-lived chat/acp/pty processes: `claude agents --json --all` every 15 s focused, an interactive-login env recapture (`$SHELL -ilc env -0`, ~0.7 s) whenever the 60 s cache is stale, `wsl -l -v` every 5 min, and a 10-spawn probe chain at start. There is no global cap.

### 0.2 Known WSL failure modes (research, 2026-10-21)

- microsoft/WSL **#41830** (opened 2026-10-07, open; WSL 2.7.3, Windows 10.0.26300 — the user's build) and dup **#41777**: `\\wsl.localhost` hangs until timeout and new sessions fail with `Wsl/Service/0x8007274c` while `wsl -l -v` and existing sessions keep working; only `wsl --shutdown` recovers. Kernel worker stuck in `hvs_probe → __vmbus_open`. Each new `wsl.exe` session and each 9P connection opens hvsocket channels.
- #41936 (2026-10-15, open): VM-requiring commands hang after sleep (mini_init soft lockup). #8824 complete freeze triggered by IDE indexing over WSL. #4144 all `wsl.exe` commands hang. #7479/#8170 Windows apps/Explorer hang on `\\wsl$`. #7883 interop + `\\wsl$` hang (fixed in 0.58, re-reported later). Release notes 0.70.5 (plan9 server race), 1.0.1 (wslservice hang launching a new session). CVE-2026-21237 (p9rdr.sys create-path race).
- Windsurf/Devin WSL troubleshooting doc: "aggressive file watching and indexing over the WSL filesystem" saturates 9P → disconnects, `P9 Reply_Rlerror`, VM memory growth.
- Microsoft: "We recommend against working across operating systems with your files" (learn.microsoft.com/windows/wsl/filesystems).
- Every IDE that works well with WSL does the same thing: one long-lived server inside the distro (VS Code Server, JetBrains backend), file watching with Linux inotify, one channel to Windows.

Inference (not proven): the continuous `listSessions`-over-9P loop plus the spawn churn is what drives the user's VM into #41830-class wedges. P0 tests this cheaply; P1–P2 remove the mechanism entirely.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | One long-lived **helper** per enabled host, running inside Linux, reached over **stdio of one `wsl.exe`** for WSL hosts | One channel per distro instead of hundreds of sessions/9P opens; no dependence on NAT/mirrored networking, the Hyper-V firewall, VPNs or `::1` (all of which break localhost forwarding in open WSL issues) |
| D2 | Same helper and protocol over **`ssh.exe`** for a new `ssh:<alias>` host kind (P3) | The user already reaches WSL over sshd (Gateway, VS Code Remote-SSH); it is also Phase 8's planned extension point for remote Linux boxes |
| D3 | Helper runtime = **Node ≥ 18** in the host, resolved from the interactive-login env (nvm works); the helper is an esbuild single-file bundle | The Agent SDK's store functions read `process.env.CLAUDE_CONFIG_DIR` directly and can't be pointed at a remote fs — they must run in Linux. Node lets the helper import the SDK (`>=18`) instead of re-implementing session parsing. Bundle ≈ 1.5 MB (`sdk.mjs` is 1.2 MB) — fine against the 180 MB budget |
| D4 | No Node → host status `node-missing`, WSL Claude features off for that host; **no UNC fallback** | A fallback keeps the crash path alive |
| D5 | Protocol is **domain-level** (`store.list`, `usage.scan`, `hooks.apply`, …), not a remote fs | See D3; also keeps payloads small (aggregates, not files) |
| D6 | Stored `\\wsl.localhost\<D>\…` paths stay the host identity | No migration of `settings.workspaces`, `claude.workspaces` or registry cwds (gotcha 6) |
| D7 | Ship a **P0 hotfix** on the current code first | The helper is several PRs; the user is crashing now |
| D8 | Long-lived spawns that already run inside Linux (SDK `query()` claude, `devin acp`, ptys, `gh`) stay on `spawnOn`/`ptySpawnSpec` | They are not 9P load; one `wsl.exe` each for the process lifetime |

## 2. Helper

### 2.1 Bundle and deployment

- Source `src/helper/` (new; Node-only, no electron), entry `src/helper/main.ts` → `out/helper/agent-workspace-helper.mjs` via `scripts/build.mjs` (esbuild, `platform: node`, `target: node18`, **`format: esm`** — the SDK's `sdk.mjs` calls `createRequire(import.meta.url)` at top level, which an esbuild cjs bundle turns into `{}`; ESM output keeps `import.meta` intact). The SDK is inlined; the helper never resolves node_modules at runtime. Pure modules shared with the app (`src/core/claudeUsage.ts`, `src/core/hostRpc.ts`, `src/core/claudeHooks.ts`) are imported normally. **P1 starts with a bundling spike** (plan Task 4): build a store-only bundle, run every SDK call it uses under real Node 18, 20 and 22, record the size; the 3 MB cap is asserted in the build.
- `HELPER_HASH` = first 12 hex of sha256 of the bundle, written by the build into `out/helper/helper-hash.json` and read by main at start. The installed path is `<home>/.agent-workspace/helper-<hash>.mjs`. On start and then hourly the helper touches its own file, and on start it deletes other `helper-*.mjs` files whose mtime is older than 7 days (a sibling app instance on another version keeps its file fresh the same way). Before every respawn the channel re-runs the cheap `HELPER_PRESENT` check (folded into the respawn itself: the launch line is `test -f <file> || exit 86; exec node …`, and exit 86 triggers a redeploy instead of counting as a failure).
- Packaged under the existing `build.files` `out/**/*`; main reads it out of the asar to stream it (no `asarUnpack`).
- Probe: the existing single probe line gains `command -v node >/dev/null && node -p process.versions.node || echo NONODE` and `test -f <home>/.agent-workspace/helper-<hash>.mjs && echo HELPER_PRESENT` — no extra spawns. If absent: one spawn `wsl.exe -d D -e /bin/sh -c 'mkdir -p "$1" && cat > "$1/.tmp.$$" && mv "$1/.tmp.$$" "$1/$2"' sh <home>/.agent-workspace helper-<hash>.mjs` with the bundle on stdin. No UNC. All paths are **absolute** (the probed home): neither `wsl.exe -e` nor `"$0"` expands `~`.

### 2.2 Launch

`wsl.exe -d D --cd <home> -e <shell> -ilc 'exec node "$0" --stdio' <home>/.agent-workspace/helper-<hash>.mjs` (built by a new pure `helperSpec` in `src/core/execHost.ts`; fish → `exec node $argv`, same as `ptySpec`). The helper therefore inherits the full interactive-login env (PATH, nvm, `SSH_AUTH_SOCK`, tokens) — `env.get` returns it and replaces the 60 s `-ilc` recapture for `spawnOn`/`execOn`/`ptySpawnSpec`. `WSL_ENV_DENYLIST` still applies when merging.

The helper's stdout carries only protocol frames; anything an rc file prints before `exec` is discarded until the first frame (`hello`). Its stderr is drained and counted, never logged. The helper exits on stdin EOF and on SIGTERM/SIGHUP, so a killed channel or app quit never leaves an orphan in the distro.

### 2.3 Protocol (`src/core/hostRpc.ts`, pure, shared)

NDJSON, one JSON object per line, UTF-8.

- Request `{id, method, params}` → response `{id, result}` | `{id, error: {code, message}}`.
- Notification (helper → app) `{method, params}`, no id.
- First frame from the helper: `hello {protocol: 1, hash, node, pid, home, watchMode}`. A `protocol` or `hash` mismatch → the app kills the channel and redeploys (once per run; a second mismatch → `degraded`).
- Max frame 32 MB; bigger → error `too-large` and the decoder resyncs at the next newline. `store.messages` pages (`{offset, limit ≤ 500}`; the caller pages until a short page — the SDK returns no total), so history never needs that.

| Method | Params → result | Replaces |
|---|---|---|
| `ping` | `{}` → `{t}` | — (heartbeat) |
| `env.get` | `{}` → `{env}` | `captureEnv` 60 s recapture |
| `store.list` | `{}` → `SDKSessionInfo[]` (SDK `listSessions({includeProgrammatic:true})`) | UNC `listSessions` under `withConfigDir` |
| `store.rename` / `store.fork` / `store.delete` | SDK params → SDK result | UNC SDK mutations |
| `store.listSubagents` / `store.subagentMessages` / `store.messages` | `{sessionId, agentId?, offset?, limit?}` → SDK result | UNC history reads |
| `store.transcriptPath` | `{sessionId}` → `{path: string|null}` (linux path) | UNC `transcriptPath` readdir |
| `watch.subscribe` | `{}` → `{}`; then notifications `store.changed {files, sessions, removed}` — `files` in the `<encoded-cwd>/<id>.jsonl` relative shape `onTranscriptFiles` parses today, `sessions` = SDK `getSessionInfo` for each changed id, `removed` = ids whose transcript was deleted; debounced 250 ms | tiered poll, `inotifywait` path, and the full re-list on every change |
| `usage.scan` | `{months: [YYYY-MM]}` → `{buckets}` — runs `fileScanPlan` + `aggregateUsageLines` locally; the per-file offset cache lives in helper memory (a helper restart rescans natively, cheap on ext4) | UNC walk + stream |
| `usage.accounts` | `{}` → `{accessToken?, expiresAt?, email?, org?, usageCache?}` | UNC `.credentials.json`/`.claude.json`/`.usage-cache` reads |
| `hooks.apply` | `{enabled, port, token, addr?}` → `{installed, changed, error}` — builds the block with `buildHooksBlock`, then `mergeHooksIntoSettings`/`removeHooksFromSettings` + one-time `.agent-workspace.bak` + tmp+rename, all in Linux | sync UNC `applyGlobalHooks` |
| `agents.list` | `{}` → raw stdout of `claude agents --json --all` (parsed app-side by `parseAgentsJson`) | 15 s `wsl.exe` spawn |
| `fs.stat` | `{path}` → `{exists, dir}` (P2; configured UNC `pickerFolder`) | `existsSync` over UNC |
| `fs.readdir` | `{path}` → `{entries: [{name, dir}]}` (directories only, for `RemoteFolderInput`; P3) | native dialog over UNC |

Watching inside the helper: `fs.watch` (non-recursive, so Node 18 works) on `~/.claude/projects` and each project dir, plus `subagents/` dirs as they appear; a new project dir is picked up from the parent watch. On `ENOSPC`/watch errors the helper falls back to a local 5 s stat poll of the recent-50 (native ext4 stats, not 9P) and reports `watchMode` in `hello`/`env.get`.

The token from `usage.accounts` travels only in that response, stays in main memory, and is never logged or put in state (same rule as today's `.credentials.json` read).

## 3. App side

### 3.1 `HostChannel` (`src/main/hostChannel.ts`)

One per enabled host whose enumeration says `Running` (WSL) or that is configured (SSH). Owned by `HostsRegistry`; `hosts().channel(host)` returns it.

- `request(method, params, {timeoutMs})` — default 10 s; `store.list`/`usage.scan` 60 s.
- Liveness: **any** frame from the helper counts. A `ping` is sent only after 15 s of silence, and the channel is killed (`reconnecting`) after 45 s with no frame at all. A helper busy in a long `store.list` still answers pings from its event loop, and the long call has its own 60 s timeout.
- Respawn backoff 60 s → 120 s (pure schedule in `hostRpc.ts`). A failed start is a spawn error, no `hello` within 20 s, **or an exit within 60 s of `hello`**; the failure count resets only after 60 s of stable `ready`. After the third consecutive failure the **breaker opens**: state `degraded`, no further spawns until `hosts:refresh` or an enumeration that newly reports the distro `Running`. A stopped distro is never started (Phase 8 rule).
- `onNotification(method, fn)`; `onState(fn)` feeds `HostStatus.helper = {state: 'absent'|'starting'|'ready'|'reconnecting'|'degraded'|'node-missing'|'unsupported-node', node, watchMode}` into `ShellState.hosts` and the Settings `#hostsBlock` row.
- `fsReady(host)` becomes `channel ready` for WSL/SSH hosts (local unchanged).

### 3.2 Consumers

| Module | Change |
|---|---|
| `claude/store.ts` | A `ClaudeStore` per host gets a `StoreBackend` — `LocalBackend` (today's SDK + `fs.watch`, unchanged) or `ChannelBackend` (RPC + `store.changed`). Tiered poll, `hotTick`, `recomputeHotPaths`, `transcriptFor`, `startInotify` are deleted |
| `claude/sessions.ts` | `store.changed {sessions, removed}` patches/removes those rows in the snapshot; a full `store.list` only on start, channel (re)connect, mutation, explicit refresh. Local hosts keep their current full refresh (cheap on NTFS). `revealTranscript` on a remote host uses `store.transcriptPath` → `windowsPath` → `shell.showItemInFolder` (Explorer on the user's click, not app fs) |
| `claude/host.ts` | `getSessionMessages`/`getSubagentMessages` → `store.messages`/`store.subagentMessages` for remote hosts |
| `claude/usage.ts` | Remote hosts: `usage.accounts` + `usage.scan`; the app-side per-file cache holds local files only. `fsRace`/`HOST_FS_BUDGET_MS` stay for local only |
| `claude/hooks.ts` + `hooksInstall.ts` | `applyGlobalHooks` takes a `SettingsFileIo` (`read`/`writeAtomic`/`backupOnce`), local = async `fs/promises`, remote = `hooks.apply`. Re-apply only when `(host, enabled, sha256(block))` differs from the last successful apply, not on every `onStatusChange` |
| `claude/backgroundAgents.ts` / `sessions.ts` agents poll | `agents.list` over the channel |
| `hosts.ts` | Delete `withConfigDir`, the `configMutex`, `captureEnv` recapture (kept only for `local`), UNC `configDir` for remote hosts. No read path (`statuses()`, `list()`, `enabledDistros()`) triggers enumeration — they read the cached rows; enumeration runs on its 5-min timer, on window focus if > 5 min old, and on `hosts:refresh` |
| `local/terminalHost.ts` | The sync `spawnSync(wsl.exe -l -q)` (`wslDistros`) reads `hosts().list()` instead |
| pickers (`sessions.ts` `pickerDefaultPath`, `local/ipc.ts` `localWorkspacePick`, `core/pickerFolder.ts`) | The `existsSync` of a WSL distro home is dropped (the probed home exists); a configured UNC `pickerFolder` is checked with the channel's `fs.stat`. The native dialog still opens on `\\wsl.localhost` until P3 — Explorer browsing on the user's click, not app fs; the one documented exception |
| `testHooks.ts` | `withConfigDirHold` removed (its S7 race can't exist without the swap); `claudeUsage.spec.ts:304` replaced by a channel test |
| Pickers (P3) | `localWorkspacePick`/`pickWorkspaceDir` for remote hosts → in-app `RemoteFolderPicker` over `fs.readdir`; WSL keeps the native dialog until P3 |

### 3.3 Guard

The plan (Task 10) carries the inventory of every app fs call whose argument can be a remote path, with its disposition. `src/main/remoteFsGuard.ts`: in test mode, `fs`/`fs/promises` calls whose path starts with `\\wsl.localhost`, `\\wsl$`, `//wsl.localhost` or the `AGENT_WORKSPACE_TEST_WSL_UNC_ROOT` prefix throw `RemoteFsViolation` (installed by monkey-patching the handful of entry points the app uses: `stat`, `readdir`, `readFile`, `writeFile`, `access`, `open`, `createReadStream`, `watch`, `existsSync`, `readFileSync`, `writeFileSync`, `renameSync`, `copyFileSync`). In production the same check logs `remote-fs-violation {op}` once per op and lets the call through. The e2e suite asserts zero violations.

## 4. Phases

Each phase is its own PR, green on typecheck/lint/unit/build/e2e, and shippable alone.

### P0 — Hotfix on the current code (~1 day)

1. `sessions.ts` `onChange(files)`: for a **WSL** host, a non-empty `files` list only calls `onTranscriptFiles(files)` (history reload of terminal-owned sessions — today's behaviour) — **no** `refresh('watch')`. Sessions the app starts or mutates still refresh through the mutate/terminal paths; rows of sessions started elsewhere in the distro update at the next change-check hit or on entering the Claude surface (stated in the PR).
2. `store.ts`: the WSL poll becomes a **cheap change check** every 300 s: `readdir(projects)` + `stat` of each project *directory* (≈70 9P stats, no transcript stats); only a moved directory mtime fires `onChange([])` (full re-list). The 2 s `hotTick` stats only `terminalOwned` ids' transcripts (≤ a handful), never the recent-20; `recomputeHotPaths` is deleted.
3. `usage.ts`: skip `walkJsonl`/`runScan` for WSL hosts (the Analytics token totals show local-only + a "WSL totals paused" note); keep the `/usage` fetch (one small `readFile` pair, 10 min hidden).
4. `hooksInstall.ts`: async `fs/promises`; `hooks.ts` re-applies only on a change of `(host, enabled, block hash)`.
5. `hosts.ts`: `ENV_CACHE_MS` 60 s → 10 min; no read path calls `enumerate()` (timer + focus + refresh only); `onStatusChange` fires only when a host's status actually changed; every `wsl.exe` invocation (`runWsl`, `execWsl`, `execOn`, `spawnOn`) logs `host-exec {host, kind}` so the soak counts all of them.
6. `backgroundAgents.ts`: WSL hosts poll at 120 s focused / 5 min blurred.
7. The existing probe line also records `command -v node` + version into `HostStatus` (no new spawn), so the P1 Node prerequisite is known per distro before the helper ships.
8. AGENTS.md + README: document the reduced cadences; log events unchanged except `claude-watch` gains `mode: 'poll-wsl'`.

Verification: unit (status-change dedup, hook hash gate, change-check decision); e2e `hosts.spec.ts` "terminal-owned WSL session reloads history on a transcript change" still passes and a new spec asserts a transcript change on a WSL host does **not** trigger `claude-list`; real-machine soak on a **copied** userData (2 distros, one active WSL chat, 30 min): `host-exec` ≤ 2.0/min total, WSL `claude-list` ≤ 0.4/min, WSL usage-scan files = 0; plus the user re-runs the workload that crashed before.

### P1 — Helper + WSL channel; Claude store over RPC

Bundling spike first; then `src/helper/*`, `src/core/hostRpc.ts`, `src/main/hostChannel.ts`, `helperSpec` in `execHost.ts`, deploy in the probe, `store.*` + `watch.subscribe` + `env.get` + `ping` + `hooks.apply` + `agents.list`, `ClaudeStore` backends, `sessions.ts` row patching, `host.ts` history, `revealTranscript` via `store.transcriptPath`, `HostStatus.helper` in Settings. UNC code remains only for usage until P2. Real-distro gate before the PR opens: `hosts:probe` reports helper deploy/hello/`store.list` ms and a 30-min soak.

### P2 — Everything else over RPC; delete UNC

`usage.*` + `fs.stat`; picker `existsSync` removal (`pickerStartPath`'s `exists` callback becomes async), `terminalHost` `wslDistros` off `spawnSync`; delete `withConfigDir`, `captureEnv` recapture for remote hosts, `withConfigDirHold`; install the guard; Analytics WSL totals return.

### P3 — `ssh:<alias>` host kind

- Settings `hosts.ssh: {alias: string, enabled: boolean}[]` (zod + `SETTINGS_PRESERVE_SPEC` array by `alias` + `storePreserve.test.ts`); Settings → General `#hostsBlock` gains "Add SSH host…" (alias from `~/.ssh/config`, validated `^[A-Za-z0-9._-]+$`).
- Transport: Windows OpenSSH `ssh.exe -o BatchMode=yes -o ServerAliveInterval=15 -T <alias> -- <cmd>`; probe/deploy/launch identical to §2 with `ssh` replacing `wsl.exe -d D`. Ptys: `ssh -t <alias> -- $SHELL -ilc 'cd <cwd> && exec "$0" "$@"' …`. Spawns: `ssh -T <alias> -- cd <cwd> && exec /usr/bin/env K=V … cmd`. Shell quoting by a pure `posixQuote` in `execHost.ts` (unit-tested against the argv round-trip probe).
- Path form `ssh://<alias>/<abs path>`: `hostIdForPath`, `toHostPath`, `displayPath`, `workspaceLabel` and `workspaceFor` learn it; it is the stored identity for ssh workspaces/cwds.
- Remote folder entry: a path field with directory autocomplete over `fs.readdir` (`RemoteFolderInput`), used for every non-local host — WSL included from here on, which retires the native dialog's UNC browsing. A tree picker is not part of this phase.
- Hooks: `hookReachability` probes `curl 127.0.0.1:<port>` from the remote; for ssh hosts the channel adds `-R <port>:127.0.0.1:<port>` reverse forwarding so hooks reach the Windows listener without mirrored networking.

## 5. Settings, logs, docs

- New keys: P3 only (`hosts.ssh`). No key removed, so no migration.
- New log events (ids/counts/ms only): `host-exec {host, kind}` (P0), `host-helper-deploy {host, ok, bytes, ms}`, `host-helper {host, state, reason?}`, `host-rpc-timeout {host, method, ms}`, `host-rpc-error {host, method, code}`, `remote-fs-violation {op}`, `host-ssh {alias-hash, op}` (P3). `claude-watch` gains `mode: 'channel'|'poll-wsl'`. All added to the AGENTS.md log table in the PR that introduces them.
- README: "Running sessions in WSL" — Node ≥ 18 requirement, what the helper is, where it lives (`~/.agent-workspace/`), `node-missing` status; P3 adds "SSH hosts".
- AGENTS.md: replace the Execution hosts "never do synchronous fs on a wsl host's config dir" paragraph with the channel rule ("no app-originated fs on a remote host — everything goes through `hosts().channel(host)`"); env vars below.

## 6. Testing

CI has no WSL, but the helper is plain Node fs code — so e2e runs the **real** bundle.

- `fakeWsl.ts`: the helper launch runs with `spawn` and **piped** stdio (the fake's current `spawnSync` / `stdio:['ignore',…]` can't carry the protocol), using a real `node` (not Electron — RunAsNode is fused off) from `FAKE_WSL_NODE`, default `node` on PATH, with `HOME` **and `CLAUDE_CONFIG_DIR`** under `FAKE_WSL_ROOT` (Windows node ignores `HOME`; without `CLAUDE_CONFIG_DIR` the SDK would read the developer's real `~/.claude`). The probe additions and the deploy `sh -c` line are emulated in JS (Windows CI has no `sh`). `FAKE_WSL_NO_NODE=1` answers `NONODE`; `FAKE_WSL_HELPER_HANG=1` makes the **fake** stop forwarding the helper's stdout after `hello` (the hang lives in the fixture, never in the shipped bundle). Test hook `hostHelperKill(id)` kills the child for the reconnect test.
- Unit (`tests/unit/hostRpc.test.ts`): framing (split lines, oversize, garbage before `hello`), id matching, timeout, backoff schedule, breaker transitions incl. "exit within 60 s of hello counts as a failed start" and "reset only after 60 s ready"; `helperSpec` per shell family; `posixQuote` (P3); hook hash gate; row patching.
- Helper unit (`tests/unit/helper/*.test.ts`, runs the helper modules directly against a temp `~/.claude` copied from `tests/fixtures/claude-home`): `store.*`, `watch` notifications, `usage.scan` equals `aggregateUsageLines` over the same files, `hooks.apply` idempotence + backup-once.
- e2e (`tests/e2e/hostsHelper.spec.ts`): deploy-then-hello; a WSL session lists via the channel; a transcript append emits `store.changed` and patches only that row, a deleted transcript removes its row (no `claude-list` full refresh); history of a WSL session via `store.messages`; killed helper → `reconnecting` → back to `ready`; `FAKE_WSL_HELPER_HANG` → 45 s silence (shortened in test) → reconnect; three failed starts → `degraded` and no further spawns for the rest of the test; `FAKE_WSL_NO_NODE` → `node-missing` and the Settings hint; **zero `remote-fs-violation`** across the whole suite (P2). `hostsStartup.spec.ts` keeps passing (slow probe never blocks the window).
- Real-machine evidence (`npm run hosts:probe`, extended; git-ignored `docs/evidence/hosts-probe.json`): helper deploy ms, `hello` ms, `store.list` ms per distro (target: Ubuntu-24.04 < 1.5 s vs 9.8 s over UNC), and a 30-min soak with one active WSL chat: `wsl.exe` spawns after startup (target: 0 beyond chat/pty), `remote-fs-violation` count (target: 0), stopped distro still stopped. Plus the user's own repro of the original crash workload.
- `npm run smoke:install` for P1 (new packaged file) and P3 (settings schema).

## 7. Out of scope

- Running the Devin CLI's own store through the helper (Devin Local reaches its sessions over ACP, not the filesystem).
- Updating Node inside the distro, or shipping a Node runtime.
- AF_VSOCK/hvsocket and TCP-forwarded transports (same failing layer as #41830 / fragile across networking modes).
- macOS remote hosts (the SSH kind works there in principle; not tested in this phase).
