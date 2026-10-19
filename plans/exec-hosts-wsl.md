# Phase 8 — Execution hosts: Claude Code and Devin sessions inside WSL

Status: Implemented — PR pending.

The app runs on Windows; the user's Claude Code (and Devin CLI) sessions mostly run inside WSL. Today every integration point assumes the CLI, its `~/.claude` store and the session cwd all live on the Windows side. This phase introduces one **execution host** abstraction that the Claude surface and the Devin Local surface both use, with two host kinds in scope — `local` (unchanged behaviour) and `wsl:<distro>` — and an interface shaped so an `ssh:<name>` kind can be added later without touching the callers.

## 0. Options considered

| Option | How VS Code / JetBrains do it | Verdict |
|---|---|---|
| **A. `wsl.exe` as the process bridge + `\\wsl.localhost\<distro>` for files** | JetBrains (IDEA/Rider "WSL interpreter/targets") | **Chosen.** Zero install inside the distro, no daemon, no keys or ports. `wsl.exe -d <distro> --cd <linux cwd> -e <argv…>` gives exact argv (verified: JSON/spaces/quotes round-trip byte-exact), stdio pipes work for the SDK's stream-json protocol and for ACP ndjson, and ConPTY ptys already run `wsl.exe` (the dock's WT profiles do this today). `\\wsl.localhost\<distro>\…` is a normal UNC path for `fs` (listing 70 project dirs / 227 transcripts took 68 ms). |
| B. SSH into the distro | VS Code Remote-SSH, JetBrains Gateway | Not now. Needs `sshd` per distro, key management, a port, and it adds nothing over A on the same machine. The `ExecHost` interface (§1) is where an `ssh` kind would plug in later — that's the only concession to it in this phase. |
| C. A server component installed in the distro (VS Code Remote-WSL model) | VS Code Remote-WSL | No. Our remote-side needs are "spawn a CLI, read `~/.claude`", both covered by A. A server would need Node in every distro and an update story. |
| D. Run the whole app under WSLg | — | No. Loses the Windows integration (notifications, GitHub views, installer). |

## 0.1 Verified on this machine (2026-10-20, SDK 0.3.296, WSL 3.0.3, CLI 2.1.303 in Ubuntu-22.04)

These are the facts the design rests on; each becomes a probe in §6 so they're re-checked on every SDK/CLI bump.

1. **SDK → WSL claude works end-to-end** via `Options.spawnClaudeCodeProcess` returning `spawn('wsl.exe', ['-d', D, '--cd', cwd, '-e', '/usr/bin/env', 'K=V', …, command, …args])`. New session: `system/init` in 1.6 s, Bash tool ran `pwd`/`uname` inside Linux, `result success`. **Resume** of an existing WSL transcript by id: `init` in 1.8 s, same session id, success. The SDK passes `command` = our `pathToClaudeCodeExecutable` (a Linux path) and never stats it when a custom spawner is set.
2. **SDK store functions work over UNC**: `CLAUDE_CONFIG_DIR=//wsl.localhost/Ubuntu-22.04/home/brian/.claude` → `listSessions` returned 226 rows in 1.25 s with Linux `cwd`s. The SDK re-reads `CLAUDE_CONFIG_DIR` at the start of **each** call (58 Windows rows and 227 WSL rows from one process, including two concurrent calls with the env swapped between them) — so one process can serve several hosts if the env is set synchronously right before each SDK store call.
3. **`fs.watch` over `\\wsl.localhost` fails** (`EISDIR` on the recursive watch); a file written from Windows is visible in WSL immediately. Store change detection for WSL hosts therefore needs an in-distro watcher or polling (§3.2). `inotifywait` is **not** installed in the user's distros; `curl` and `gh` are.
4. **Hook listener reachability**: the machine runs WSL in `networkingMode=mirrored`, and `curl http://127.0.0.1:<port>` from inside the distro reached a Windows loopback server (HTTP 200). NAT mode is *not* verified — see §3.3.
5. **`wsl.exe` refuses a UNC process cwd** (spawn error); `--cd <linux path>` must be used instead, with the Windows-side `cwd` left at a real local directory.
6. Distros: `Ubuntu-22.04` (default; `claude` 2.1.303 at `~/.local/bin`, `devin` 3000.11.3, Node 24 — all under `~/.local/bin`, which is only on `PATH` in a **login** shell), `Ubuntu-24.04` (running), `wsl-vpnkit` (stopped, utility). `wslpath -w /home/brian/src` → `\\wsl.localhost\Ubuntu-22.04\home\brian\src`; `wslpath -u 'C:\Users\brian\source'` → `/mnt/c/Users/brian/source`.

## 0.2 Re-evaluation (review questions, answered with measurements)

**Q1 — Do sessions started this way register like native WSL sessions and see other agents in the distro?**
Yes. The `claude` process *is* a Linux process running as the distro user with the distro `HOME`; the Windows-side SDK is only a stdio pipe (the `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` the SDK sets is an env flag *for the child*, the parent reads nothing from disk during a live query). Checked after the probe: its transcript landed in `/home/brian/.claude/projects/-home-brian/<id>.jsonl` with `entrypoint: sdk-ts` — the same entrypoint today's Windows chat sessions have — alongside the terminal-started ones; `claude agents`, `~/.claude/sessions`, `session-env`, `ide/` locks, teammates and background agents all operate on that same in-distro store. What does *not* cross: the Windows `~/.claude` and the WSL `~/.claude` are separate worlds (they are today too); the app shows both, tagged by host.

**Q2 — Environment, PATH, SSH keys: what does the spawned process actually inherit?**
This was a real gap in the first draft, which used `wsl.exe -e /usr/bin/env K=V claude …` directly. Measured in Ubuntu-22.04:

| Launch | Vars | What's missing |
|---|---|---|
| `wsl.exe -e <cmd>` (first draft) | 19 | `~/.local/bin`, nvm/sdkman `PATH` entries, `JAVA_HOME`, `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_PROFILE`, `DATADOG_API_KEY`, `LAUNCHDARKLY_API_KEY`, the `*_SERVICE_PATH` vars, **`SSH_AUTH_SOCK`/`SSH_AGENT_PID`** |
| `bash -lc` (login) | 32 | still no nvm/sdkman/`JAVA_HOME`/`SSH_AUTH_SOCK` — they come from `.bashrc`, whose `case $- in *i*)` guard returns early in non-interactive shells |
| `bash -ilc` (interactive login) | 45 | nothing; `ssh-add -l` lists both keys; `PATH` starts with `/home/brian/.local/bin`; **no stdout noise** from rc files (0 bytes besides a marker); costs ~0.5 s |

So the plan now resolves the environment the way VS Code and JetBrains do ("shell environment resolution"): capture `$SHELL -ilc` once per spawn (cached 60 s per host), and launch children with that environment (§1.4). Tools Claude runs (Bash, git, gh, ssh, npm, java…) then see exactly what a terminal in that distro sees. File-based state (`~/.ssh/*`, `~/.gitconfig`, `gh` auth, `~/.aws`, `~/.claude/.credentials.json`) needs nothing — the process already runs as the distro user.

**Q3 — JetBrains Gateway over SSH: should the bridge be SSH?**
Re-evaluated and kept `wsl.exe`, for these reasons specific to "the distro is on this machine":
- The environment problem is identical over SSH (`ssh host cmd` runs a non-interactive `bash -c`; the same `.bashrc` guard trips), so SSH doesn't buy fidelity — the `-ilc` capture is needed either way.
- SSH would need `sshd` installed and running per distro, a port, keys, and `~/.claude` would have to be read over SFTP instead of a UNC path (the sidebar list, `fs` reads of transcripts and the hooks `settings.json` merge all become remote operations).
- `wsl.exe` auto-discovers distros, starts nothing extra and gives exact argv (verified).
Where SSH is genuinely the right answer is a **remote** Linux box — the Gateway use case. The `ExecHost` interface is defined so an `ssh:<name>` kind drops in: `spawnSpec` → `ssh … -- env …`, `configDir`/store reads → SFTP or a tiny remote `find`/`cat` recipe, env capture → the same `-ilc` command over ssh. That is a later phase; **if your Gateway targets are remote machines rather than this WSL, say so and it becomes Phase 9 rather than an extension point.**

**Q4 — Does a session launched this way get the WSL user's `~/.claude` settings, skills, plugins, MCP servers?**
Yes — verified by launching a session the plan's way (`wsl.exe … bash -ilc 'exec "$@"' … claude`, SDK `settingSources: ['user','project','local']`) and reading its `system/init`: `model: claude-opus-5-5` (from `settings.json` `model: opus`), **15 plugins** (`cb`, `cb-java`, `cb-mfe`, `superpowers`, `security-guidance`, `code-simplifier`, …), **131 skills** including the user's own `unblocked-*` set, `/evaluate-system` from `commands/`, 9 plugin agents, the `unblocked` MCP server from `~/.claude.json` plus every claude.ai connector with the same auth state a terminal session shows, `~/.claude/CLAUDE.md` (8 KB) loaded, credentials from `.credentials.json` with no prompt. Two conditions make this hold and both are in the plan: `settingSources` must stay all three (the SDK loads *no* filesystem settings without it — `host.ts` already passes it for Windows sessions), and the §1.4 environment capture must be in place for anything the settings or MCP servers read from the shell environment. Project-level `.claude/settings.json`, `.mcp.json` and `CLAUDE.md` come from the Linux cwd. The `claude:sdk-probe --host` gate asserts `plugins.length > 0 && skills > 0`.

## 1. Design

### 1.1 The host abstraction (`src/core/execHost.ts`, pure)

```ts
export type HostId = 'local' | `wsl:${string}`;           // 'wsl:Ubuntu-22.04'
export type ExecHost =
  | { id: 'local'; kind: 'local' }
  | { id: HostId; kind: 'wsl'; distro: string; home: string | null; mount: string }; // mount: '/mnt' (from [automount] root)

export function hostIdForPath(p: string): HostId;          // '\\wsl.localhost\D\…' | '\\wsl$\D\…' → 'wsl:D', else 'local'
export function toHostPath(host: ExecHost, winPath: string): string;   // UNC → '/home/…'; 'C:\x' → '/mnt/c/x' for wsl; identity for local
export function toWindowsPath(host: ExecHost, hostPath: string): string; // '/home/…' → '\\wsl.localhost\D\home\…'; '/mnt/c/x' → 'C:\x'
export function displayPath(host: ExecHost, hostPath: string): string;  // 'Ubuntu-22.04 · /home/brian/src/x' when hosts.length > 1
export function spawnSpec(host: ExecHost, cmd: { file: string; args: string[]; cwd: string; env?: Record<string,string> },
  shellEnv: Record<string,string> | null):                 // the captured `-ilc` environment (§1.4); null = not captured yet
  { file: string; args: string[]; cwd: string };           // local: identity; wsl: wsl.exe -d D --cd <cwd> -e /usr/bin/env K=V… file args…
export function ptySpec(host: ExecHost, cmd: { file: string; args: string[]; cwd: string; env?: Record<string,string> }):
  { file: string; args: string[]; cwd: string };           // wsl: wsl.exe -d D --cd <cwd> -e <shell> -ilc 'exec "$@"' -- env K=V… file args…
export function parseShellEnv(stdout: Buffer, marker: string): Record<string,string> | null; // text after marker, NUL-separated `K=V`
export function mergeShellEnv(captured: Record<string,string>, extra: Record<string,string>): Record<string,string>;
  // drops the per-invocation vars WSL itself provides (WSL_INTEROP, WSLENV, WSL_DISTRO_NAME, PWD, OLDPWD, SHLVL, _, TERM*) so
  // the child keeps the live interop socket of *its own* wsl.exe, then overlays `extra` (hook token, SDK CLAUDE_CODE_*)
export function parseWslList(utf16: string): { name: string; state: 'Running'|'Stopped'; default: boolean }[]; // `wsl.exe -l -v`
```

**Path form is the host selector.** A workspace or session cwd stored as `\\wsl.localhost\<distro>\…` *is* its host identity plus path, so `settings.workspaces: string[]`, the Local allow-list (`resolve()` keeps UNC intact), the folder picker (`showOpenDialog` browses `\\wsl.localhost\…` natively) and `claude:newSession(cwd)` all stay string-typed with **no schema migration**. Only transient process-facing values (spawn cwd, ACP `session/new.cwd`, SDK `options.cwd`) are converted with `toHostPath` at the boundary. Claude registry rows gain `host: HostId` because their `cwd` comes from the store in Linux form.

`env` handling for wsl specs: the child gets the **captured distro shell environment** (§1.4) plus **only the variables we add** (hook token, `CLAUDE_CODE_*` from the SDK's `SpawnOptions.env` diff against `process.env`). The Windows environment is never sent into the distro; `WT_SESSION`/`TERM_PROGRAM` posing is a Windows-only concern and is not applied.

### 1.4 Environment fidelity (shell environment resolution)

Rationale and numbers in §0.2 Q2. Mechanism, per WSL host:

- **Capture**: `wsl.exe -d D -e <shell> -ilc 'printf "\0__DW_ENV__\0"; env -0'` where `<shell>` is the distro user's login shell from the probe (`getent passwd $USER`, falling back to `/bin/bash`; `zsh`/`fish` get their own flag spelling — `zsh -ilc` is identical, `fish -ilc` too). Parse only what follows the marker, so rc-file chatter on stdout can't poison the result; a missing marker → `shellEnv: null`, `host-env { ok:false, reason }`, and spawns fall back to the plain exec environment with a visible "shell environment unavailable" status on the host row. ~0.5 s measured; cached **60 s** per host and refreshed on Settings "Re-check", so a restarted `ssh-agent` or edited `.bashrc` is picked up at the next session start rather than requiring an app restart. The capture itself never goes to the log — only `{ ok, ms, count }`.
- **Piped children** (SDK `claude`, `devin acp`, `claude agents`, `gh`, probes): `wsl.exe -d D --cd <cwd> -e /usr/bin/env K=V… <abs file> args…` with `mergeShellEnv(captured, extra)`. Not `env -i`: the WSL-provided per-invocation vars (`WSL_INTEROP` socket, `WSLENV`, …) must be the ones of *this* `wsl.exe`, so they are excluded from the overlay and inherited.
- **Pty children** (Claude Terminal tab, Devin terminal handoff): `wsl.exe -d D --cd <cwd> -e <shell> -ilc 'exec "$@"' -- /usr/bin/env K=V… <abs file> args…` — a real interactive login shell, exactly what the user gets in Windows Terminal; rc output is harmless on a tty and the shell is replaced by the CLI via `exec`.
- **Absolute CLI paths** everywhere (resolved by the probe under the captured `PATH`), so the result does not depend on `PATH` ordering at spawn time.
- Settings per host: `shell` override (for a user whose `getent` shell differs from what they actually configure) and `envCaptureDisabled: boolean` (escape hatch; default false).

### 1.5 Contracts (land first, exact names)

`src/shared/ipc.ts`
- `HostIdSchema = z.string().regex(/^(local|wsl:[A-Za-z0-9._-]+)$/)`; `HostStatusSchema`:
  ```
  { id: HostId, kind: 'local'|'wsl', label: string,                 // 'This PC' | distro name
    state: 'ready'|'probing'|'stopped'|'disabled'|'error', error: string|null, probedAt: string|null,
    home: string|null, shell: string|null,
    claude: { path: string|null, version: string|null }, devin: { path: string|null },
    shellEnv: { ok: boolean, count: number, ms: number }|null,        // §1.4 capture summary, never the values
    hooks: 'ok'|'unreachable'|'untested', inotify: boolean, gh: boolean }
  ```
- `AppState.hosts: HostStatus[]` (pushed; `local` always first).
- `ClaudeSessionSchema.host: HostIdSchema` (default `'local'` when absent in stored data); `ClaudeStateSchema` keeps `configDir`/`cliPath`/`versions` for the local host (unchanged for existing specs) and gains `hostErrors: Record<HostId, string>` for per-host status lines.
- `ClaudeAgentSchema.host: HostIdSchema`; `TerminalSummarySchema.host: HostIdSchema`.
- `LocalWorkspaceArg.path` accepts UNC unchanged (`WorkspacePath` is already a non-empty string; any `\wsl.localhost\<D>\…` directory is a valid workspace).
- Channels: `hostsRefresh 'hosts:refresh'` (invoke `{ id?: HostId }` → re-enumerate / re-probe), `hostsSetEnabled 'hosts:setEnabled'` (invoke `{ id, enabled }`), `claudeRecheckEnv 'claude:recheckEnv'` (invoke `{ sessionId }` → re-capture for that session's host).
- Settings (`HostsFields`): `wslEnabled: boolean`, `wslDistros: string[] | null`, `defaultWslDistro: string | null`, `overrides: Record<string, { claudePath?: string|null; devinPath?: string|null; home?: string|null; shell?: string|null; envCaptureDisabled?: boolean }>` under `hosts`, each with defaults so `parse({})` stays valid; `SettingsPatchSchema.hosts` partial.

`src/core/execHost.ts` — exactly the §1.1 exports, plus `WSL_ENV_DENYLIST` exported for tests.

`src/core/claudeRegistry.ts` — `ClaudeRegistryEntry.host: HostId` (schema `.default('local')`), `ClaudeStoreSession.host: HostId`.

Env vars (test mode): `DEVIN_WORKSPACES_TEST_WSL_CMD`, `DEVIN_WORKSPACES_TEST_WSL_ROOT`, `DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT` (§3.8). Fake: `tests/fixtures/fakeWsl.ts` → `out/fixtures/fakeWsl.cjs`, reads `FAKE_WSL_DISTROS` (`"Fake:Running:default,Other:Stopped"`), `FAKE_WSL_HOME` (default `/home/u`), `FAKE_WSL_ENV_MARKER=1` → the `-ilc` capture includes `FAKE_WSL_MARKER=1`, `FAKE_WSL_NO_CLAUDE=1` → `command -v claude` fails.

Test hooks (`__devinworkspaces`): `hosts()`, `hostStatus(id)`, `hostRefresh(id)`, `hostShellEnvKeys(id)` (names only).

Log events (`host` category): `host-list { count, wsl: bool }`, `host-probe { host, ok, ms, claude, devin, hooks }`, `host-env { host, ok, ms, count, reason? }`, `host-spawn { host, kind: 'pipe'|'pty', ok, ms }`, `claude-watch` gains `host`.

### 1.2 Main-process host registry (`src/main/hosts.ts`)

- `listHosts(): ExecHost[]` — `local` + one `wsl:<distro>` per distro from `wsl.exe -l -v` that is **Running or the default** and not disabled in settings (probing a stopped distro would boot it; stopped distros appear in Settings as "stopped — enable to probe"). `wsl.exe` missing → `local` only. Re-enumerated on Settings open and every 5 min; cached otherwise (today's `wslDistrosCache` in `terminalHost.ts` moves here).
- Per-host **probe**, run lazily once per host per app run and on demand from Settings ("Re-check"): `home`, `user` and login `shell` (`wsl.exe -d D -e /bin/sh -c 'echo "$HOME"; id -un; getent passwd "$(id -un)" | cut -d: -f7'`), then the **shell environment capture** (§1.4), then `claude` and `devin` paths resolved *under the captured `PATH`* (`command -v` inside `-ilc`; override per host in settings), `claude --version` (compared to `sdkTargetCliVersion()` exactly as the local check does), `gh` presence, `inotifywait` presence, hook reachability (§3.3). Result → `HostStatus` pushed to the shell; log `host-probe { host, ok, ms, claude: bool, devin: bool, hooks: 'ok'|'unreachable'|'untested' }` — never the paths.
- `shellEnv(host)` → the cached §1.4 capture (refreshes when older than 60 s); `spawnOn(host, cmd)` → `child_process.spawn` of `spawnSpec(host, cmd, await shellEnv(host))`; `ptySpawnOn(host, cmd, ptyOpts)` → `node-pty` of `ptySpec(...)`. `spawnSync` equivalents for probes with a 10 s timeout (a cold distro can take seconds).
- `configDir(host)` → local: today's `CLAUDE_CONFIG_DIR || ~/.claude`; wsl: `\\wsl.localhost\<D>\<home>\.claude` (no `CLAUDE_CONFIG_DIR` concept inside the distro is honoured — documented limitation).
- `withConfigDir(host, fn)` — serialises SDK store calls per process: sets `process.env.CLAUDE_CONFIG_DIR` synchronously, invokes `fn()`, restores on settle. Relies on fact 0.1-2; `claude:store-probe` gains a two-host assertion so a future SDK that caches the dir fails the probe, not the app.

### 1.3 Settings (`src/shared/ipc.ts`)

```
hosts: {
  wslEnabled: boolean (default true),
  wslDistros: string[] | null       // null = auto (running + default); explicit list otherwise
  overrides: Record<HostId, { claudePath?: string; devinPath?: string; home?: string; shell?: string; envCaptureDisabled?: boolean }>
}
```
`claude.path` and `local.devinPath` remain the `local` host's overrides (no migration). Settings → General gains a **Hosts** block: a row per host with status (CLI versions, hooks reachability, last probe), enable/disable, path override fields; and a "Default WSL distro for new sessions" selector that only sets the folder picker's starting location.

## 2. What changes where

### 2.1 Claude surface
| Area | Today | Change |
|---|---|---|
| Store (`store.ts`) | one `ClaudeStore` over `configDir` | one store **per enabled host**; `sessions.ts` merges the lists and tags rows with `host`. Each store's `list()` runs inside `withConfigDir`. |
| Change detection | `fs.watch` recursive, 30 s poll fallback | wsl: if `inotifywait` is present run `wsl.exe -d D -e inotifywait -m -r -q -e modify,create,delete,moved_to --format %w%f <projects>` and feed its lines into the same debounced `onChange`; else tiered polling — stat the `N=20` most recent transcripts + any terminal-owned one every 2 s while the Claude surface is visible, full `readdir` scan every 30 s. Log `claude-watch { mode: 'inotify' \| 'poll-tiered', host }`. |
| Transcript path, `getSubagentMessages`, rename/fork/delete | SDK + fs on `configDir` | same calls under `withConfigDir(host)`; `transcriptPath` scans the host's projects dir. |
| Live query (`host.ts ensureLive`) | `pathToClaudeCodeExecutable: cliPath()` | per session host: `cwd: toHostPath`, `pathToClaudeCodeExecutable: hostStatus.claudePath`, and for wsl hosts `spawnClaudeCodeProcess: (o) => spawnOn(host, { file: o.command, args: o.args, cwd: o.cwd, env: diff(o.env, process.env) })` with `o.signal` forwarded. `isOnDisk` consults the right store. |
| Shell environment | n/a (Windows children inherit the app's env) | wsl children get the captured `-ilc` environment (§1.4); the chat header's session menu gains "Re-check host environment" → re-capture + log. |
| New session (`newSession(cwd)`) | Windows folder picker | picker unchanged; `defaultPath` = last used dir for the chosen host (the Hosts "default WSL distro" → `\\wsl.localhost\D\<home>`); `host = hostIdForPath(dir)`, cwd stored as `toHostPath`. |
| Terminal tab (claude-kind pty) | `nodePty.spawn(claudePath, ['-r', id, '--settings', json, '--permission-mode', m])` | `ptySpawnOn(host, …)` → interactive login shell `exec`ing claude (§1.4); the `--settings` block is still passed inline (argv round-trip verified) and the hook token via `env`. Windows-side pty `cwd` stays `homedir()`. |
| Hooks (`hookServer.ts`, `claudeHooks.ts`, `hooksInstall.ts`) | loopback `127.0.0.1:<port>`; global opt-in merges into `~/.claude/settings.json` | URLs stay `127.0.0.1` in mirrored mode (§3.3 covers NAT). Global opt-in applies to **every enabled host's** `settings.json` (`\\wsl.localhost\D\<home>\.claude\settings.json`) with the same merge/backup/remove code; a host whose file is unparseable is reported per host, never written. |
| Background agents | `claude agents --json --all` locally | run per host, rows tagged with host; stop goes to the owning host. |
| PR state `gh` fallback (`prTitles.ts`) | `gh` on Windows PATH | prefer the session's host (`gh` is authenticated in WSL on this machine); fall back to local `gh`. |
| Activity / notifications / PR tracking | keyed by session id | unchanged — ids are UUIDs, unique across hosts. |
| Sidebar | folder = cwd | Linux cwds group naturally; a small host chip on rows/folders when > 1 host contributes sessions; per-host status lines ("Ubuntu-24.04: Claude Code not found — set the path in Settings"). |

### 2.2 Devin Local surface
| Area | Today | Change |
|---|---|---|
| Workspace add | picker → Windows path | picker browses `\\wsl.localhost\…` as-is; stored verbatim; `displayPath` in the panel. |
| Agent spawn (`acpHost.start`) | `spawn(devinPath, args, { cwd: workspace, env: process.env })` | `spawnOn(hostFor(workspace), { file: hostStatus.devinPath, args, cwd: toHostPath(workspace) })`; ACP `session/new` / `session/load` send the host path as `cwd`. |
| Terminal handoff (`devin -r <id>`) | local pty | `ptySpawnOn(host, …)` with `--cd`. |
| Allow-list (`resolve(path)`) | Windows paths | unchanged — `resolve` preserves `\\wsl.localhost\…`. |
| CLI resolution (`resolveDevinPath`) | `where devin` | per host via the probe; `local.devinPath` keeps overriding the local host. |

### 2.3 Terminal dock
No functional change — WSL profiles already work. `wslDistros()` moves to `hosts.ts`; `windowsTerminal.ts` keeps its `matchDistro`.

## 3. Risks and how each is settled

### 3.1 `wsl.exe` argv fidelity
Verified for JSON, spaces and embedded quotes with `-e` (fact 0.1-1). Remaining risk: a `--settings` block containing a `%` or a trailing backslash. Probe asserts a fixed set of pathological strings; if any fails, the fallback is writing the block to `%TEMP%` and passing `--settings /mnt/c/…/<file>.json` (Claude accepts a path).

### 3.2 WSL store latency and freshness
UNC reads are fast enough for lists (1.25 s for 226 sessions through the SDK — the SDK reads every transcript's head; cache the list and refresh on change events only, as today). Tiered polling keeps the terminal-owned live-history feature within ~2 s. Probe records `list ms`, `stat 20 files ms`.

### 3.3 Hook reachability in NAT networking mode
Unverified (this machine is mirrored). Plan: the host probe runs `curl -s -m 2 http://127.0.0.1:<port>/devin-workspaces/hook/health` inside the distro. If it fails, try the Windows vEthernet (WSL) IPv4 from `os.networkInterfaces()` (name matches `/^vEthernet \(WSL/`); if reachable, the listener also binds that address (token-authenticated, same as loopback) and wsl-host URLs use it (`hookUrl(port, event, addr)`, `isOurHook` accepts both); if neither works, hooks for that host are reported "unreachable" in Settings and the global opt-in skips that host. Needs a NAT-mode run on this machine once (`.wslconfig` flip, `wsl --shutdown`) as part of §6's manual gate.

### 3.4 Both hosts share one session-id space
Transcript UUIDs collide with negligible probability; the registry stores `host` and never looks up by id alone when a host is known.

### 3.5 A distro that stops mid-session
`wsl.exe` child exits → SDK `exit` event → the existing `live: 'error'`/ACP restart paths apply. Probe is not re-run automatically; the row's status shows "distro not running".

### 3.6 Windows ↔ Linux path confusion
All conversions go through `execHost.ts` with unit tests for: `\\wsl.localhost` and `\\wsl$` forms, `/mnt/<drive>` round-trips, distro names with dots/dashes, trailing slashes, and the identity behaviour for `local`.

### 3.7 Shell environment capture fails or lies
A broken rc file (exits non-zero, blocks on a prompt, prints before the marker) must not take the host down: capture has a 10 s timeout, `stdin` is `/dev/null`, parsing starts at the marker, and failure degrades to the plain exec environment with a visible status — never a silent fallback. A captured `SSH_AUTH_SOCK` can point at a dead agent (same as in a new terminal tab); not ours to fix. Probe records var count and the presence of `PATH` entries under `$HOME`.

### 3.8 CI has no WSL
e2e uses a **fake `wsl.exe`**: `DEVIN_WORKSPACES_TEST_WSL_CMD=node out/fixtures/fakeWsl.cjs` (handles `-l -v`, `-d D --cd c -e argv…` by running `argv` locally with `cwd` mapped through `DEVIN_WORKSPACES_TEST_WSL_ROOT=<tmp>` — `/home/u/x` ↔ `<tmp>/home/u/x`) and `DEVIN_WORKSPACES_TEST_WSL_UNC_ROOT=<tmp>` replacing `\\wsl.localhost\<D>`. Everything except `wsl.exe` itself runs for real. Real-WSL evidence comes from the probe scripts on the dev machine (§6).

## 4. Streams (after §1 contracts land)

**Core (pure + unit tests):** `execHost.ts` incl. `parseShellEnv`/`mergeShellEnv` (marker-less input, NUL in values, the WSL denylist, overlay precedence) and `ptySpec` quoting; `parseWslList`; settings schema `hosts` + defaults; `ClaudeRegistryEntry.host` with `local` default on load; `displayPath`; `hookUrl(port, event, addr?)`/`isOurHook` extension; `claudeHooks.ts` unchanged otherwise.

**Main A — hosts + Claude:** `hosts.ts` (enumeration, probe, spawn/pty wrappers, `withConfigDir`); per-host `ClaudeStore` + inotify/poll watcher; `host.ts` spawner + cwd conversion; `sessions.ts` merge/tag; hooks install per host + reachability; background agents per host; `prTitles` gh-by-host; terminal claude-kind via host; test hooks `hosts()`, `hostStatus(id)`.

**Main B — Devin Local:** `acpHost` per-host command + spawn + ACP cwd; terminal handoff; `local/ipc.ts` picker `defaultPath`; `resolveDevinPath` → host probe.

**Shell:** Settings Hosts block; sidebar host chip + per-host status lines; Local panel `displayPath`; New-session picker default-host selector (empty state + sidebar header).

**Fixtures/e2e:** `fakeWsl.cjs`; `tests/e2e/hosts.spec.ts` — Settings lists `wsl:Fake`, probe status renders, a Claude session created under `\\wsl.localhost\Fake\home\u\proj` shows a Linux cwd and the fake pty receives `wsl.exe`-shaped argv (`-d Fake --cd /home/u/proj -e … claude -r <id>`), a Local workspace added under the UNC root spawns the fake ACP agent through the fake wsl with the Linux cwd, hooks opt-in writes both `settings.json` files and removes both; the fake wsl's `-ilc` capture returns a canned env with `FAKE_WSL_MARKER=1` and the fake pty/ACP agent asserts it arrived. Existing specs run unchanged with `wslEnabled` defaulting to the fake's absence (no `wsl.exe` → `local` only).

## 5. Explicitly out of scope
SSH hosts (interface only); running the SDK or a helper inside the distro; `CLAUDE_CONFIG_DIR` set *inside* a distro; stopped-distro auto-start; file watching for Devin workspaces; macOS (no WSL — `hosts.ts` returns `local` only, as it does when `wsl.exe` is absent).

## 6. Gates
- typecheck · lint · unit · build · full e2e (incl. `hosts.spec`) · isolated `smoke:install` (settings schema changes).
- **Probes (manual, dev machine, evidence under `docs/evidence/hosts-*`):** `npm run hosts:probe` (new; per host: enumeration, home/shell/CLI resolution timing, **env capture: var count and the §0.2 Q2 diff vs plain exec, `ssh-add -l` result under the captured env, PATH head**, argv round-trip set, UNC list/stat timings, `fs.watch` failure confirmed, inotify availability, hook reachability on 127.0.0.1 and the vEthernet address), `claude:sdk-probe --host wsl:Ubuntu-22.04` (new flag; new + resume turn through `spawnClaudeCodeProcess`, and a Bash-tool turn that prints `echo $SSH_AUTH_SOCK $JAVA_HOME; which node` to prove the environment reached the tool), `claude:store-probe` two-host assertion, `acp:contract` with `DEVIN_WORKSPACES_HOST=wsl:Ubuntu-22.04`. One NAT-mode pass for §3.3.
- Docs: README "Running sessions in WSL" (how hosts are discovered, that the distro's interactive login shell environment is what sessions run with and how to re-check it, the hooks reachability note, limitations), AGENTS.md (env vars, test hooks, log events, Hosts conventions), `plans/README.md` row, `claude-sessions.md` phase list entry, findings appended to `claude-sessions-findings.md` (facts 0.1-1…6 with the probe outputs).
