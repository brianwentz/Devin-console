# Agent Workspace — project rules

Agent Workspace — Electron desktop client (BaseWindow + WebContentsViews; the React shell is the only view exposing a window API via preload).

## Commands
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `eslint .` (flat config `eslint.config.mjs`; see Versions for the `tools/lint` workspace)
- `npm run test:unit` — vitest, `tests/unit` (pure logic only)
- `npm run build` — esbuild (main/preload/scripts → `out/*.cjs`) + `vite build` (shell → `out/shell`); runs a dependency preflight first
  (`src/core/depPreflight.ts` → `out/scripts/dep-preflight.cjs`) and exits 1 with a `run npm install` message when a package.json dependency is
  missing from node_modules
- `npm run test:e2e` — build + Playwright `_electron` (`tests/e2e`, fixture servers in `tests/fixtures/http.ts`)
- `npm run dist:win` — build + electron-builder NSIS per-user x64 installer → `dist/AgentWorkspace-Setup-<version>.exe` (unsigned, fuses flipped by
  electron-builder from `build.electronFuses`; `scripts/after-pack.cjs` only writes `resources/signing.json`; icon from `build/icon.ico` via `npm run icon`)
- `npm run dist:mac` — build + electron-builder arm64 dmg+zip → `dist/AgentWorkspace-<version>-arm64.*` + `latest-mac.yml`; ad-hoc signed
  (`-c.mac.identity=- -c.mac.hardenedRuntime=false` — hardened runtime off because ad-hoc signatures have no team ID), so Gatekeeper requires
  right-click → Open on first launch (icon from `build/icon.png`, entitlements `build/entitlements.mac.plist`). Never reintroduce fuse-flipping in
  afterPack — it invalidates the Electron ad-hoc signature → "application is damaged".
- `npm run smoke:install` — `npm run dist:win:smoke` (same build packaged as "Agent Workspace Smoke", appId `io.github.brianwentz.agent-workspace.smoke`,
  `dist/smoke/AgentWorkspace-Smoke-Setup-*.exe`) then `scripts/smoke-install.ps1 -Isolated`:
  - silent install → `tests/smoke/installed.spec.ts` (CDP-driven, `playwright.smoke.config.ts`) → upgrade-in-place → uninstall; evidence in
    `docs/evidence/p3-smoke*` (docs/ is git-ignored - local output only).
  - Run before pushing when packaging or the settings schema changes (it reads `settings.json` directly).
  - `npm run smoke:install:real` smokes `dist/AgentWorkspace-Setup-*.exe` and is CI-only (`windows.yml`); the script refuses to run when a non-smoke
    install of the product is registered or running (`-Force` bypasses; never set from package.json), and only ever kills processes under its own
    `-InstallDir`.
  - Why the isolated identity exists and how the spec reaches main-process hooks (`test:hook` IPC): see Conventions.
  - The script fails the installer over a 180 MB size budget (see Versions).
  - `npm run smoke:install:rename` — cross-rename smoke: installs the pre-rename `dist/smoke-before/DevinWorkspaces-Smoke-Setup-*.exe`
    (captured before the rename; git-ignored), launches it once, then runs the new installer with `/S --updated` and asserts the new
    identity (install dir, the pinned GUID's registry entry, shortcuts) plus the profile migration; evidence `docs/evidence/p3-smoke-rename.log`.
- `npm run rebuild:native` — electron-builder install-app-deps; exists if node-pty ever needs a rebuild (requires MSVC) — see "Terminal (P4b)" below.
- `npm start` / `npm run acp:probe`
- `npm run acp:contract` — P4 contract run against the real `devin acp` (initialize/new/prompt/cancel/list/load); writes
  `docs/evidence/p4-acp-contract.jsonl` (git-ignored); exit 0 also when the CLI is missing/unauthenticated (reported in the file)
`- `npm run claude:sdk-probe` / `claude:hooks-probe` / `claude:store-probe` — build then run `scripts/claude-*-probe.ts` → `out/scripts/*.cjs`; evidence
  under `docs/evidence/claude-*` (git-ignored); exit 0 when the claude CLI is missing (reported in the file). `claude:sdk-probe --host wsl:<distro>`
  (or `AGENT_WORKSPACE_PROBE_HOST`) runs new+resume + a Bash turn inside the distro through `spawnSpec`.
- `npm run hosts:probe` — build then run `scripts/hosts-probe.ts` → `out/scripts/hosts-probe.cjs` → `docs/evidence/hosts-probe.json`; real-WSL
  measurements (enumeration/probe/env-capture vs plain env/argv round-trip/UNC timings/fs.watch EISDIR/inotify/hook reachability); exit 0 when
  `wsl.exe` or distros are absent.
  `-- --soak <minutes> [--profile <dir>]` launches the built app on a temp copy of the profile and writes `soak` (host-exec/min by kind, background
  claude-list/min, usage-scan files) into the same file — never run it against the real profile without saying so; test/FAKE_* env passes through.
- `acp:contract` honours `AGENT_WORKSPACE_HOST=wsl:<distro>` — spawns `devin acp` through `spawnSpec` + captured env with cwd = distro home; evidence
  `docs/evidence/p4-acp-contract-wsl.jsonl`.
- CI:
  - `.github/workflows/windows.yml` — push/PR: typecheck, lint, unit, build, e2e, dist:win, smoke:install, plus a `macos` job running
    typecheck/lint/unit/build/dist:mac only — e2e and smoke stay Windows-only.
  - `release.yml` — on `release: published` with tag `vX.Y.Z` created in the GitHub UI: sets package.json to X.Y.Z, builds Windows + macOS arm64,
    uploads `.exe`/`.blockmap`/`.dmg`/`.zip`/`latest.yml`/`latest-mac.yml` to that release — the feed used by `src/main/updater.ts` — then commits
    `chore: release vX.Y.Z` to main; never bump the version by hand; mark a release as pre-release to keep clients from auto-updating to it.
  - macOS signing/notarization is optional via secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` —
    unsigned Mac builds have the updater disabled: `updater-disabled reason: unsigned-mac`, gated by `resources/signing.json` written by after-pack.

## Env vars

Scope: *always* = honoured in every build; *test mode* = only with `AGENT_WORKSPACE_TEST=1`; *smoke* = read by `scripts/smoke-install.ps1` / the smoke spec.
Fakes live in `tests/fixtures/` and build to `out/fixtures/*.cjs` (`fakeClaudeSdk` → `.mjs`); the `FAKE_*` variables each fake reads are listed with the
variable that selects it.

| Variable | Scope | Effect |
|---|---|---|
| `AGENT_WORKSPACE_TEST=1` | always | Enables the `__agentworkspace` hooks (and the `test:hook` IPC); also disables the auto-updater (in testMode update checks are simulated — see Updates). |
| `AGENT_WORKSPACE_TENANT_URL` | always | Overrides settings.tenantUrl (localhost http is allowed only in tests through this variable). |
| `AGENT_WORKSPACE_USER_DATA` | always | Overrides userData (default is `%APPDATA%\agent-workspace`, from package.json `name`). |
| `AGENT_WORKSPACE_TEST_MIGRATE_FROM` | test mode | Stand-in for the legacy `devin-workspaces` profile dir — lets the migration run even though the test profile is explicit (`tests/e2e/migration.spec.ts`, cross-rename smoke). |
| `AGENT_WORKSPACE_LOG` | always | Event-log path. |
| `AGENT_WORKSPACE_DOWNLOAD_DIR` | always | Download directory. |
| `AGENT_WORKSPACE_SCALE` | always | Display scale override. |
| `AGENT_WORKSPACE_ALLOW_EXTERNAL` | test mode | Test override for `settings.routing.allowExternal`. |
| `AGENT_WORKSPACE_TEST_GITHUB_ORIGINS` | test mode | Comma-separated extra GitHub origins (fixture servers). |
| `AGENT_WORKSPACE_TEST_BEFOREUNLOAD` | test mode | beforeunload fixture switch. |
| `AGENT_WORKSPACE_TEST_WINDOW_SIZE` | test mode | `WxH`, default `1400x900` — CI runners with small displays get a fail-fast error instead of pane timeouts. |
| `AGENT_WORKSPACE_TEST_KEEPALIVE_MS` | test mode | Override for `settings.tabs.keepAliveHours`; 0 = discard hidden-scope tabs on switch. |
| `AGENT_WORKSPACE_LOG_MAX_BYTES` | test mode | Event-log rotation cap (test-only), default 10 MB. |
| `AGENT_WORKSPACE_EVIDENCE=1` | test mode | Makes the routing e2e write its event log to `docs/evidence/e2e-fixture-events.jsonl` (default: temp profile; docs/ is git-ignored). |
| `AGENT_WORKSPACE_INSTALLED_EXE` | smoke | Path of the installed exe under test. |
| `AGENT_WORKSPACE_SMOKE_PROFILE` | smoke | Profile (userData) used by the smoke run. |
| `AGENT_WORKSPACE_SMOKE_PHASE` | smoke | `fresh`\|`upgrade`. |
| `AGENT_WORKSPACE_SMOKE_EVIDENCE` | smoke | Evidence output path. |
| `AGENT_WORKSPACE_API_BASE` | test mode (P5) | Overrides `settings.apiBase` for the v3 poller. |
| `AGENT_WORKSPACE_POLL_MS` | test mode (P5) | Poll interval for active and idle. |
| `AGENT_WORKSPACE_TEST_BANNER_MS` | test mode (P5) | Shortens the notification banner's 8 s auto-hide. |
| `AGENT_WORKSPACE_TEST_AUTOFILL_PROMPT_MS` | test mode (P5) | Shortens the save-password prompt's 1.5 s show-delay fallback. |
| `AGENT_WORKSPACE_TEST_AUTOFILL_DISMISS_MS` | test mode (P5) | Shortens its 10 s auto-dismiss. |
| `AGENT_WORKSPACE_TEST_RELEASES_URL` | test mode | Overrides the GitHub API base used by the release-notes fetcher (`src/main/releases.ts`). |
| `AGENT_WORKSPACE_TEST_AUTH_STATUS_CMD` | test mode | e.g. `node out/fixtures/fakeAuthStatus.cjs` — replaces the `devin auth status` spawn used for service-user identity resolution; the fake reads `FAKE_AUTH_STATUS_EXIT` / `FAKE_AUTH_STATUS_USER_ID` / `FAKE_AUTH_STATUS_ORG_ID`. |
| `AGENT_WORKSPACE_LOCAL_AGENT_CMD` | test mode | e.g. `node out/fixtures/fakeAcpAgent.cjs` — replaces the `devin acp` spawn with a full command; the fake agent reads `FAKE_ACP_LIST=1` / `FAKE_ACP_LOAD=1` / `FAKE_ACP_DELETE=1` / `FAKE_ACP_LINK_URL` / `FAKE_ACP_USAGE=1` (emits a `usage_update` mid-prompt and `usage` on the prompt response) / `FAKE_ACP_PROMPT_DELAY_MS` (stalls the prompt so the thinking indicator is observable) / `FAKE_ACP_MODES=1` (advertises `modes` on session/new+load and implements `session/set_mode` → `current_mode_update`) / `FAKE_ACP_MODE_LOG` (file the fake appends `<sessionId> <modeId>` to per set_mode call). |
| `DEVIN_CLI` | always (scripts) | Overrides the binary for `acp:probe` / `acp:contract`. |
| `AGENT_WORKSPACE_TEST_TERMINAL_CMD` | test mode | e.g. `node out/fixtures/fakePty.cjs` — replaces the command the embedded terminal spawns — for `devin`-kind (Local panel), `shell`-kind (dock) and claude-kind ptys (the fake pty echoes argv → `-r <id>` assertable, and `env:AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN=set`; `tests/fixtures/fakePty.ts` echoes stdin with control bytes escaped as `\xNN`). |
| `AGENT_WORKSPACE_TEST_CLOUD_SESSIONS` | test mode | Path to a JSON file shaped like `CloudListResult` — `{ sessions: CloudSession[], folders: string[], folderTotals: {}, nextCursor }` — makes the cloud sidebar data layer (`src/main/cloudSessions.ts`) skip the network and load the file at start and on every `cloudRefresh()`; unset in test mode → `cloud.status` is `'disabled'`. |
| `AGENT_WORKSPACE_TEST_CLOUD_CACHE` | test mode | Path to a JSON file in `CloudCache` shape — `{version:1, tenantUrl, savedAt, sessions, folders, folderTotals}` — loaded as the cached list when no fixture file is set, leaving `cloud.status` `'connecting'` with `cached: true`. |
| `AGENT_WORKSPACE_TEST_SESSIONS_OPEN` | test mode | `'1'`/`'0'` overrides `settings.sessions.open` at startup; `launchApp` sets `'0'` by default so legacy specs keep `devin.x === RAIL_WIDTH` — sidebar specs pass `'1'`. |
| `AGENT_WORKSPACE_TEST_CLOUD_KEEPALIVE_MS` | test mode | Overrides `settings.sessions.keepAliveHours` for the pooled Cloud views — mirrors `AGENT_WORKSPACE_TEST_KEEPALIVE_MS` (tabs). |
| `AGENT_WORKSPACE_TEST_CLAUDE_SDK` | test mode | An ESM module `loadSdk()` imports instead of the real SDK — `tests/fixtures/fakeClaudeSdk.ts` → `out/fixtures/fakeClaudeSdk.mjs` (`export *` real SDK + fake `query`; writes real-shaped jsonl into `CLAUDE_CONFIG_DIR/projects/<encoded cwd>/`; emits `message_start` per group). The fake reads `FAKE_CLAUDE_TOOL=1` (parks on `canUseTool`), `FAKE_CLAUDE_DELAY_MS` (stalls the deltas), `FAKE_CLAUDE_TWO_MESSAGES=1` (splits a turn into two API messages), `FAKE_CLAUDE_COST_USD` (`result.total_cost_usd`). |
| `AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD` | test mode | Replaces the folder `showOpenDialog` in `newSession(cwd|null)`. |
| `AGENT_WORKSPACE_TEST_PICKER_CANCEL` | test mode | Every folder dialog routed through `src/main/dialogs.ts openFolderDialog` returns canceled immediately; the options are recorded for the `lastOpenDialogOptions()` test hook. |
| `AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_CMD` | test mode | Whole command, e.g. `node out/fixtures/fakeClaudeAgents.cjs` — replaces the `claude` binary for background agents; the fake prints `FAKE_CLAUDE_AGENTS` for `agents --json --all` and appends `stop <id>` to `FAKE_CLAUDE_AGENTS_LOG`. |
| `AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS` | test mode | Background-agent poll interval. |
| `AGENT_WORKSPACE_TEST_GH_CMD` | test mode | Full command line replacing `gh` for the PR-state fallback (`out/fixtures/fakeGh.cjs` reads `FAKE_GH_JSON`). |
| `AGENT_WORKSPACE_TEST_WSL_CMD` | test mode | Full command line replacing `wsl.exe` for *every* invocation (enumeration, probe, spawn, pty, inotify). `launchApp` defaults it to `node out/fixtures/fakeWsl.cjs` with `FAKE_WSL_DISTROS=''` so specs stay local-only; the fake reads `FAKE_WSL_DISTROS` (`"Fake:Running:default,Other:Stopped"`), `FAKE_WSL_HOME` (default `/home/u`), `FAKE_WSL_ROOT` (`--cd` map root), `FAKE_WSL_ENV_MARKER`, `FAKE_WSL_NO_CLAUDE`, `FAKE_WSL_NO_GH`, `FAKE_WSL_INOTIFY`, `FAKE_WSL_HOOKS`, `FAKE_WSL_CLAUDE_CMD`, `FAKE_WSL_DEVIN_CMD`, `FAKE_WSL_SPAWN_LOG`, `FAKE_WSL_PROBE_DELAY_MS` (sleeps that long inside the probe line before answering), `FAKE_WSL_NO_NODE=1` (the probe line answers `NONODE` instead of a node version). |
| `AGENT_WORKSPACE_TEST_WSL_UNC_ROOT` | test mode | Replaces the `\\wsl.localhost\<distro>` prefix for path mapping (`configDir`, `toWindowsPath`-derived paths, `pathHostId`) so a plain temp dir stands in for a distro. |
| `AGENT_WORKSPACE_TEST_QUIET` | test mode | `'0'` opts out of quiet mode: by default test launches run the window invisible (opacity 0, skip-taskbar, `showInactive`, `disable-features=CalculateNativeWinOcclusion` + `disable-renderer-backgrounding`) and bring-forward/focus calls go through `window.ts activateWindow`/`focusContents` instead of `show()/focus()`. `npm run test:e2e:headed` sets `'0'`. |
| `AGENT_WORKSPACE_TEST_CLAUDE_USAGE_URL` | test mode | Replaces `https://api.anthropic.com/api/oauth/usage` for the usage service — `tests/fixtures/http.ts` `GET /api/oauth/usage` returns `FAKE_USAGE_STATUS` (default 200) + `FAKE_USAGE_JSON` (default `tests/fixtures/claude-usage.json`); `launchApp` sets it to `fixtures.claudeUsageUrl`. |
| `AGENT_WORKSPACE_TEST_DEVIN_USAGE_URL` | test mode | Replaces `<tenant>/api/personal-analytics/usage-limit` for the Devin usage service — the devin fixture serves it with `FAKE_DEVIN_USAGE_STATUS` (default 200) + `FAKE_DEVIN_USAGE_JSON` (default `tests/fixtures/devin-usage-limit.json`); `launchApp` sets it to `fixtures.devinUsageUrl` and `fixtures.devin.setUsageLimit(body|null)`/`setUsageStatus(n)` override at runtime. Unset in test mode → the service stays `idle` and never fetches (identity is stubbed `{token:'test',orgId:'test'}` only when the URL is set). |
| `AGENT_WORKSPACE_TEST_DEVIN_USAGE_POLL_MS` | test mode | Poll interval for the Devin usage service; `launchApp` sets `600000` — specs opt into faster polling. |
| `AGENT_WORKSPACE_TEST_CLAUDE_ACCOUNT_FILE` | test mode | Replaces `<dirname(configDir)>/.claude.json` as the account file (`oauthAccount {emailAddress, organizationName}` → `tests/fixtures/claude-account.json`). Value may be a `;`-separated list of `hostId=path` pairs for multi-account staging (bare path = default for hosts without a pair). |
| `AGENT_WORKSPACE_TEST_NOW` | test mode | ISO timestamp overriding the wall clock for the usage service (current month) and the panel's `testNow` static (gauge "resets in") — specs pin `2026-10-15T12:00:00Z`. |
| `AGENT_WORKSPACE_PROBE_HOST` / `AGENT_WORKSPACE_HOST` | always (scripts) | `claude:sdk-probe --host wsl:<distro>` (flag or env) and `acp:contract` `AGENT_WORKSPACE_HOST=wsl:<distro>` route through `spawnSpec` + captured env against real WSL. |
| `CLAUDE_CONFIG_DIR` | always | Claude home read by the Agent SDK (default `~/.claude`); the SDK also *writes* into it — tests always copy `tests/fixtures/claude-home`. |
| `AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN` | always (set by the app) | Bearer token placed in claude-kind pty `extraEnv` and referenced from the injected `--settings` hooks block. |
| `WT_SESSION` / `TERM_PROGRAM` | always (set by the app) | Set on devin-kind ptys when unset so the `devin` CLI doesn't detect conhost (`terminal-env` carries `added: [...]`). |

## Versions
- Requires Node ≥ 22.12; currently developed on Node 24.x. All deps are pinned exact — package.json is the source of truth.
- Couplings: `@types/node` must stay on the Node major bundled by the current Electron (Electron 44 → Node 24), not `latest`; `electron-builder` tracks
  the `v26` npm dist-tag (its `latest` tag lags behind).
- Dependabot (`.github/dependabot.yml`) opens weekly PRs with a 7-day cooldown; CI runs `npm audit --audit-level=high` after `npm ci`. Dependabot ignores
  `typescript` majors (see Lint below).
- `@anthropic-ai/claude-agent-sdk@0.3.296` is pinned — its `manifest.json` targets Claude CLI 2.1.296, so check `claude --version` against it when
  bumping; the `@anthropic-ai/claude-agent-sdk-<platform>` optional deps are install-only (they bundle claude.exe) and must never ship in the installer.
- The SDK is ESM-only, so it stays `external` in `scripts/build.mjs` and is packaged unpacked: `build.files`/`build.asarUnpack` carry it plus its runtime
  deps (ajv, ajv-formats, fast-deep-equal, fast-uri, json-schema-traverse, require-from-string, zod) with `!`-negations excluding the platform packages,
  `@anthropic-ai/sdk` and `@modelcontextprotocol/*`; `scripts/smoke-install.ps1` fails the installer over a 180 MB size budget (real installers are
  ~127 MB; the budget catches the 249 MB platform binary leaking in).
- Lint: `npm run lint` (`eslint.config.mjs`: `@eslint/js` + `typescript-eslint` recommended, not type-checked, + `react-hooks` on `src/shell/**`).
  `typescript-eslint` needs the TypeScript JS compiler API, which the root's `typescript@7` (native) package no longer ships, so it lives in the
  `tools/lint` npm workspace with its own `typescript@5.9.3` (npm nests both under `tools/lint/node_modules`; the root `overrides` entry for
  `ts-api-utils` keeps that transitive peer there too); `eslint.config.mjs` imports it via `tools/lint/typescript-eslint.mjs`.

## Layout & settings (F-features)

### Frame & shortcuts
- Frame: `titleBarStyle: 'hidden'` + `titleBarOverlay` on the BaseWindow, `Menu.setApplicationMenu(null)`; the shell's `TitleBar.tsx` renders the drag
  region and the GitHub tab strip. Zoom (Ctrl+= / Ctrl+- / Ctrl+0) and detached DevTools (F12 / Ctrl+Shift+I, dev only) live in `src/main/shortcuts.ts`;
  Ctrl+` toggles the terminal dock — only on dock surfaces (`dockSurface(surface)` in `src/core/layout.ts`: `cloud | local | claude`; the predicate is
  the single source of truth for `window.ts: terminalVisible()`, `App.tsx` and the `Rail` button, which is `disabled` on Settings/Analytics). Off a dock
  surface the shortcut is a no-op and `layout.terminalOpen` keeps its value; a shortcut toggle logs `terminal-toggle {open, source:'shortcut'}`.
- e2e: Playwright's `page.keyboard.press` does NOT reach Electron's `before-input-event`, so main-process shortcuts must be driven with
  `webContents.sendInputEvent` from `app.evaluate` (see `ctrlBacktick` in `tests/e2e/terminal.spec.ts`: `keyDown`+`keyUp` with `modifiers:['control']`
  on `__agentworkspace.getShellWebContents()`).
- Composer (`src/shell/chat/ChatView.tsx`, shared by Local and Claude): Enter with `ctrlKey || metaKey` sends; plain Enter and Shift+Enter insert a
  newline. `sendShortcutLabel()` (`⌘+Enter` on darwin via `window.agentworkspace.platform`, else `Ctrl+Enter`) feeds both footer hints.
- `window.agentworkspace.platform` (a static `process.platform` string exposed by the preload) is the only platform signal in the shell — no IPC needed.

### Settings keys
- `pane.open` + `pane.fraction` (0..1 share of the available width — px guards are derived in `computeBounds`, never persisted; `pane.width` migrates to
  fraction on load), `windowPlacements` (per-display-config window bounds/maximized), `layout.terminalOpen`/`layout.terminalHeight` (the dock's
  visibility is `terminalOpen ∧ dockSurface(surface)` — there is no per-surface opt-in key any more; `terminal.allSurfaces` was deleted in ux2 P0 and is
  ignored on load — since ux3 S6 it stays in the file as unknown data rather than being stripped), `prs.autoOpenTabs` (lazy background tab when a session gains a PR).
- `sessions.open`/`sessions.width`/`sessions.collapsedFolders` (Cloud session sidebar, below); `sessions.open` also drives the Settings checkbox
  `#sessionsColumnToggle` and applies to the `cloud`, `claude` and `local` surfaces (`computeBounds` reserves the column for all three);
  `sessions.maxLiveViews` (1..20, default 6) + `sessions.keepAliveHours` (0..168, default 24) — the Cloud view pool caps/idle TTL.
- `workspaces` (root array) is **Local-only** storage: the Devin Local agent roster and the pty cwd allow-list (`terminalHost.ts`/`terminalIpc.ts`); its
  array order is the display order of the Local sidebar (reorder = rewrite the array via `local:workspaceReorder`). No Settings UI — managed from the
  session column.
- `analytics.tab` (`'devin'|'claude'`, default `'devin'`) — the last-selected Analytics tab strip tab; no Settings UI.
- `usage.devinPollMinutes` (int 5..240, default 15) — Devin usage poll cadence; Settings → General `#usageDevinPollMinutes` ("Check Devin Cloud usage every (minutes)").
- `notifications.kinds.usage` (default true) — usage-limit alert entries (50%/80%); Settings → Notifications "Usage limits (50% / 80%)". Usage entries never banner.
- `local.{devinPath, defaultWslDistro, workspaceLabels: Record<path,label>, collapsedWorkspaces: string[]}` — `devinPath` (Settings → Devin Local
- `local.{devinPath, defaultWslDistro, defaultMode, workspaceLabels: Record<path,label>, collapsedWorkspaces: string[]}` — `devinPath` (Settings → Devin Local
  `#devinPathInput`; blank = PATH; inline not-found hint from `local.cliPath === null`; `DevinLocalHost` resolves the command once at start, so a change
  needs an app restart), `defaultWslDistro` (`#localDefaultWslDistroSelect`; read by `localWorkspacePick`), `defaultMode` (`#localDefaultModeSelect`; free
  string, null = agent default; applied by `acpHost.applyModes` on session/new and crash-rebind only — never on load, where the agent's persisted mode
  wins; options are the union of modes live agents advertise, falling back to `DEVIN_LOCAL_MODES`), labels/collapse keyed by workspace path.
- `local.pickerFolder` / `claude.pickerFolder` (`string | null`, ux3 S3) — "Folder pickers start in" (`#localPickerFolderInput` + `#localPickerFolderBrowse`,
  `#claudePickerFolderInput` + `#claudePickerFolderBrowse`; shared `PickerFolderField` in `settings/fields.tsx`, Browse… = `dialogPickFolder`). Draft
  validation: blank or `isAbsolutePickerPath` (drive, UNC or POSIX-absolute). Precedence is the pure `pickerStartPath(configured, distroHome, exists)`
  in `src/core/pickerFolder.ts`: configured folder if it `existsSync` → default WSL distro home → undefined; a missing configured folder logs
  `picker-folder-missing {surface}` and is skipped, never cleared. Wired at `localWorkspacePick` (`src/main/local/ipc.ts`) and Claude
  `pickerDefaultPath()` (`sessions.ts`, used by `newSession(null)` and `pickWorkspaceDir`); `AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD` still short-circuits before it.
- `claude.{workspaces: string[], workspaceLabels, defaultWslDistro}` — the Claude workspace list (separate from `workspaces`), labels by path,
  `defaultWslDistro` (`#claudeDefaultWslDistroSelect`; read by Claude `newSession(null)`); collapse state reuses `claude.collapsedFolders` keyed by path.
- `hosts.defaultWslDistro` is gone: `migrateSettingsRaw` (`src/core/settings.ts`) copies a non-empty value into `local.defaultWslDistro` and
  `claude.defaultWslDistro` where those are still absent, then deletes the old key; `main/settings.ts` spots it in the raw file, logs
  `settings-migrated {from:'hosts.defaultWslDistro'}` and re-saves once.
- `notifications.userId` (manual user-id override for service-user tokens; `''` = detect automatically).
- `routing.rules` (LinkRule `{id, kind: 'prefix'|'regex', pattern, enabled}`, max 100 — matched http(s) links open as GitHub-pane tabs; matcher in
  `src/core/linkRules.ts`, RouteKind `'rule'` ranks after github/tenant; gh-tab decisions reached via a rule log `rule-tab`/`rule-tab-background` with
  `{ruleId, ruleKind}` detail — never the pattern; the `clipboard-sanitized-write` permission extends to rule-owned origins).
- Claude keys (`claude.*`) are listed under Claude integration.

### Stores preserve unknown data (ux3 S6)
- Rule: a build may only rewrite what it understands in a user-data store; everything else in the file comes back out exactly as it went in, across
  upgrades *and* downgrades. Applies to `settings.json`, `claude-sessions.json`, `local-sessions.json`, `notifications.json`, `pr-ledger.json`; caches
  rebuilt from source (`cloud-cache.json`, `claude-usage-cache.json`, `devin-usage-cache.json`, `usage-alerts.json`, `prs.json`, `identity.json`) and the encrypted credential stores are exempt.
- Mechanism: each store keeps the file as read (`raw`) and saves `overlayKnown(raw, inMemoryValue, spec)` (`src/core/storePreserve.ts`). A `PreserveSpec`
  marks the structural parts — `object` (unknown keys survive), `record` / `array` with an `identity` key (membership from memory, unknown fields inside a
  matched entry survive), `replace` (memory wins wholesale: scalars, plain arrays, records whose absence is a deletion such as `workspaceLabels`,
  `hosts.overrides`, `windowPlacements`). Specs: `SETTINGS_PRESERVE_SPEC` (`src/core/settings.ts` — every `ZodObject` block + `notifications.kinds`;
  `tests/unit/storePreserve.test.ts` introspects the zod schema and fails on drift), `REGISTRY_PRESERVE_SPEC` (`src/core/claudeRegistry.ts` — entries
  record → per-entry object → `prs` by `url`), local index (`sessions` by `id`), notifications (top-level array by `id`), PR ledger (all leaves replace).
- Invalid-but-known settings values are preserved, not repaired away: `parseSettingsFile` repairs at leaf granularity (`dropped: ['surface',
  'claude.model']`, raw values in `invalid`), the default is used in memory, and `SettingsStore.save()` writes the raw value back unless that path was
  *touched* this run — `merge()` touches every path in the validated patch (`key`, or `block.key` for structural blocks), `syncFromState()` touches
  `pane`/`layout`/`sessions.open`/`sessions.width`/`surface`/`tabSnapshot` only once the live state differs from what was loaded. Note the Settings
  page commits its whole draft, so a form commit touches every draft-covered path (e.g. `claude.model`).
- Only named migrations delete: `migrateSettingsRaw` removes `hosts.defaultWslDistro` / `discardIdleMinutes` / `pane.width` / `notifications.enabled`
  on the raw object before the overlay; `registryFileObject` removes the P4b `folders` / `entries[*].folder` once the in-memory registry has consumed
  them and `prUrls` once read into `prs`. The overlay itself never deletes.
- Each store logs `store-preserved {store, keys}` once at load when the file carried data this build does not know (keys capped at 50).

### Cloud session sidebar
- Shell-rendered column right of the rail, `SessionSidebar.tsx`. Geometry in `computeBounds`: `leftChrome = RAIL + sessionsWidth + SPLITTER` when visible,
  collapse order is pane then sessions when `width − leftChrome < MIN_DEVIN_WIDTH`; drag axis `'s'`; `setSessionsOpen(open, source)` seam + `cloud:panel`
  IPC + Ctrl+Shift+S on the cloud surface.
- Data layer `src/main/cloudSessions.ts` — ws JSON-RPC `session/list` over `wss://<tenant>/api/acp/live` using `devinDebug.getAccessToken()`, token never
  leaves main; `cloud-token` failures carry a fixed `reason` ('view-not-ready'|'no-devindebug'|'login-required'|'timeout'|'error') and set `no-token` only
  for an external-login URL or after a 90 s bootstrap grace — otherwise 'connecting'.
- List coalescing / retries: `session/list` is coalesced (in-flight + one dirty follow-up) with a 30 s timeout — a `session/list` timeout is retried once on
  the live socket (`cloud-list-retry`) before the socket is torn down; sockets stuck in CONNECTING for 20 s are dropped
  (`cloud-connect {ok:false, reason:'timeout'}`); a 30 s watchdog re-runs the token/connect path when there is no live socket, retry timer or in-flight
  token read (`cloud-watchdog`); the sidebar Refresh button forces a reconnect when the socket isn't open (`cloud-refresh-force`); the poll cadence treats
  any focused webContents as focused (a hosted WebContentsView leaves `BaseWindow.isFocused()` false).
- Cache: the last successful list is persisted to `userData/cloud-cache.json` (`src/core/cloudCache.ts`, per-tenant) and loaded at start so the sidebar
  renders instantly — `cloud.cached` stays true until a live list lands (`cloud-cache {loaded,...}`/`cloud-cache-error` logs).
- New session: 'New session' (header `#sessionNew`, the header context menu, or a folder's `+`/context item → `cloud:newSession` IPC →
  `newSession(folder)`) records a pending folder then runs the Ctrl+N path; a home→session rekey of the active pooled view arms a watch (the backend
  lists the new session seconds after the navigation) that re-lists on a backoff (`NEW_SESSION_WATCH_DELAYS_MS`, ~44 s) until the id appears — then
  the pending folder (valid 15 min) is filed via `sessionMove` (`cloud-new-session-settled`/`cloud-new-session-skip {existing|not-listed|folder-gone}`
  logs; test hooks `cloudNewSession(folder)`/`cloudNoteHomeNavigation(id)`).
- Org: `syncOrg` re-reads the page's `devinDebug.getOrgId()` on refresh/navigate/empty-list and reconnects when the org changed —
  `cloud-org-change {reason}` log, no ids.
- Mutations / context menus: REST mutations on `<tenant>/api/` (`sessions/folder*`, `sessions/bulk-archive`) via `mutate(op,…)` — 401 → one token
  re-read + retry, `cloud-mutate {op,ok,status}` only, failures set transient `cloud.lastError {op,message}` cleared by the next list;
  `cloud.showArchived` flips `archivedStatus` to `'ALL'`; PR badges bucket `_meta sessionPRs` into open/queued/draft/merged/closed (`parseSessionPrs`);
  native context menus over `cloud:contextMenu` (test mode returns item descriptions instead of popping — `cloudMenuItems`/`cloudMenuClick` hooks,
  `cloudMutations()` records the fake backend's ops; shell applies optimistic edits via `src/core/sessionTree.ts` helpers, cleared on the next cloud
  update or lastError).
- Settings keys: `sessions.open`/`sessions.width`/`sessions.collapsedFolders`, `sessions.maxLiveViews`, `sessions.keepAliveHours`, `sessions.sessionOrder` (manual row order per section, ux3 S1) (see Settings keys).

### Cloud view pool
- `state.devinView` is a getter for `cloudViews().activeView()` (`src/main/cloudViews.ts`) — views are keyed by the session they display (`keyForUrl`,
  `'home'` for tenant root); switching just reattaches. Only the active pooled view is laid out/attached; `rekey` follows in-app navigations (background
  view navigating onto another pooled session destroys the duplicate). Discard honours beforeunload (same 3 s/50 ms race as TabManager; cancelled →
  `protected`). Log events `cloud-view-show|create|rekey|duplicate|discard|discard-cancelled|crashed` — kinds/counts/ids only.

### Pane toggle & splitter
- Pane toggle resizes the WINDOW, not the split: `setPaneOpen(open, source)` in `src/main/window.ts` is the single seam (rail, Ctrl+Shift+G,
  settings:set, test hooks, tab auto-open). Closing shrinks the window so the devin column keeps its exact px width; opening grows to the right where
  the pane px derives from `pane.fraction` as f/(1−f)·devin (fraction clamped to 0.95 for the ratio), capped at the display work area and never
  shrinking. `paneToggleWindowWidth` in `src/core/layout.ts` computes the target (`computeBounds` unchanged); maximised/fullscreen keeps the in-window
  split. The window min width is dynamic: 696 closed / 1000 open (`applyMinimumSize`, applied before the shrink / after the grow). `pane-toggle` log
  detail: `{ paneOpen, source, resized, fromWidth, toWidth, maximized }`.
- Removed channels: `pane:width` (width changes come from the splitter drag or `paneFraction` in ShellState); `tabs:scopeMenu` (the "N in other sessions"
  overflow button was removed — hidden scopes are still in `ShellState.tabs.hiddenTabCount`); `prs:popup` (the native PR menu was replaced by the PR
  panel below); `layout:dragGuide` (the splitter drag now live-resizes the hosted views without raising the shell — on macOS a transparent raised view
  does not composite and whites the window, so the overlay raise there is opaque).

### GitHub tabs
- `tabs-preload` event: on scope switch/launch the visible scope's discarded tabs are background-loaded (150 ms stagger); the live cap
  (`tabs.maxLiveTabs`) and idle discard apply to hidden scopes only — the visible scope's tabs are exempt.

### Terminal (P4b) & clipboard
- `node-pty` is N-API, so its win32-x64 prebuild works in Electron without a rebuild — no postinstall; `npm run rebuild:native` (electron-builder
  install-app-deps) exists if a rebuild is ever needed (requires MSVC). node-pty is esbuild-external + `asarUnpack`ed and `build.files`-listed.
  Terminal output is never logged (byte counts only). devin-kind ptys get `WT_SESSION`/`TERM_PROGRAM` when unset so the `devin` CLI doesn't detect
  conhost (`terminal-env` carries `added: [...]`). On quit, `dispose()` taskkills the child tree before `proc.kill()` — ConPTY teardown on a live
  console deadlocks the libuv loop (`terminal-dispose-error`/`terminal-dispose-failed` if teardown still misbehaves).
- Shell right-click gets a native menu from `src/main/contextMenu.ts` (`context-menu` log event: editable/hasSelection/hasLink booleans only); xterm
  containers handle clipboard themselves: key bindings are the pure table in `src/core/terminalKeys.ts` (Windows: Ctrl+C copies only with a selection
  else ^C, Ctrl+Shift+C copies, Ctrl+V / Ctrl+Shift+V paste — never forwarded as ^V, PSReadLine's own paste is ~500 ms; macOS: Cmd+C/Cmd+V, plain
  Ctrl+C/V keep their terminal meaning); right-click copies the selection else pastes. Copy/paste go through main's Electron `clipboard` via the
  shell-only `clipboard:readText` / `clipboard:writeText` channels (`terminal-clipboard` log event: op + length only) and all pastes use xterm
  `term.paste()` (bracketed paste). Test hooks `clipboardWrite`/`clipboardRead` wrap Electron's clipboard; `tests/fixtures/fakePty.ts` echoes stdin with
  control bytes escaped as `\xNN`.

### PR panel
- Rail `#prQuickOpen` → `PrPanel.tsx`, same controls/ids pattern as the notifications panel: `#prsPanel`, `#prsMarkAllRead`, `#prsClearAll`, rows
  `[data-pr-url][data-unread]`. Per-URL read/dismissed records live in `src/core/prPanelModel.ts` (pure) + `src/main/prs.ts` (`PrStore`,
  `userData/prs.json`), reconciled against `openPullRequests(apiSessions)` after every successful poll (records drop when the PR leaves the open list;
  `restart()` deliberately does not reconcile). Every PR is unread from first observation; delete/clear = dismissed permanently while open.
- `ShellState.notifications`: `openPrCount` = visible (open ∧ not dismissed), `unreadPrCount` (the badge), `prsPanelOpen`. IPC
  `prs:list|markRead|markAllRead|remove|clear|open|panel` (`PrUrlArg`/`PrOpenArg`/`PrPanelArg`); `setPrsPanel` mirrors `setNotificationsPanel` and the two
  panels close each other. Log events `pr-read`/`pr-dismiss` (`{ all, count }`), `prs-panel`, `prs-save-error`.
- PR titles: `src/main/prTitles.ts` resolves GitHub PR titles via `ses.fetch` on `persist:github` (10 min null / 6 h ok cache, 3 concurrent, `pr-title`
  log event — never the title text); `src/core/prTitle.ts` parses/strips the `<title>` (pure). (Title+state cache extensions: see Claude → Pull requests.)

### Poller, identity & PR auto-open
- The v3 poller only lists the token user's sessions: `notifier` always calls `GET /v3/self` (org-id override still wins) and passes `user_ids` to the
  sessions list. A PAT's `user_id` comes straight from `/v3/self` (source `self`); for a service-user token the user id is resolved by
  `src/main/identity.ts` (`identity.json` in userData persists cli/inferred results) in the order manual → `devin auth status` → persisted →
  inferred-from-observed-sessions (`onSessionChanged` in `src/main/sessions.ts` calls `getSession` and feeds `src/core/identityModel.ts` vote logic),
  retried each poll while unresolved. The first filtered `listSessions` after a cli/inferred resolution must confirm the id (a matching session or an
  empty single page) — otherwise the source is rejected for that generation and the next strategy runs.
- Fully unresolved → `state.notifications.noUserIdentity` and an `identity` notification; `state.notifications.identity = { source, resolved }` never
  carries the id (the shell reads `{ source, maskedUserId, cliOrgMismatch }` via `notifications:identity`; `notifications:identityReset` clears it).
  `notifications.openPrCount` (was `currentSessionPrCount`) counts open PRs across those sessions.
- Poller health: `poll-error` detail carries `op` (`self|list|session` — which v3 call failed). A 401/403 raises one runtime-only `auth` notification per
  outage (like `identity`; opening it goes to Settings) and the rail bell shows `#pollerWarning` while `authError || noUserIdentity`. Window focus while
  in error drops the backoff and polls now (`notifier-focus-poll`).
- PR auto-open catch-up: `src/main/prLedger.ts` persists `userData/pr-ledger.json` (`{version:1,lastGoodAt,seen[]}`, 500 URLs, written on change or
  ≥60 s) from every successful poll; a baseline poll (empty `state.apiSessions` after restart/outage) diffs against the ledger via `catchUpPullRequests`
  (24 h window, max 10, open/null PRs only) instead of opening nothing — `pr-auto-open` detail has `catchUp`, plus a `pr-catch-up` event
  `{ count, lastGoodAgeMs }`.

### Notification center (P6)
- `src/core/notificationModel.ts` (derive/list ops, pure) + `src/main/notifications.ts` (persisted store in `notifications.json`; 'update' entries are
  runtime-only). IPC: `notifications:list|markRead|markAllRead|remove|clear|open|panel|identity|identityReset`, push `notifications:banner`. While the
  panel is open main raises the shell view (`setNotificationsPanel`/`raiseShell`); the raise must survive `applyLayout` and surface switches close it.
- Taskbar overlay = unread count (`badge` log event); no OS toasts. The badge PNG is drawn on an offscreen canvas in the shell (`src/shell/badge.ts`, spec
  from `src/core/badge.ts` — Slack red `#e01e5a`, 16 px × display scale): main sends `badge:render {count,size}`, the shell replies over
  `badge:rendered {dataUrl}` whose handler returns the desired `{count,size}` so a late-mounting shell converges (nativeImage cannot rasterise SVG).
- Entries carry `ownerUserId`; `NotificationStore.reconcile(userId)` runs once per `/v3/self` resolution and prunes session-scoped entries from other
  users / legacy builds (`notifications-pruned` log event, counts only); the `identity` kind is runtime-only like `update` and is raised once for
  service-user tokens.

### Passwords (autofill)
- `credentials.json` v2 is id-keyed with many accounts per origin (v1 migrates on load) in `src/main/credentials.ts`; login-form heuristics live in
  `src/core/autofillModel.ts`; main side is `src/main/autofill.ts`; shell overlays `AccountPicker.tsx` / `SavePasswordBanner.tsx` are raised via
  `overlayOpen()` in `window.ts`. One account → fill on load (never submits); several → account picker on field focus; a submitted login → save/update
  prompt after the next navigation or 1.5 s, auto-dismissed after 10 s.
- Log events: `autofill-query`, `autofill-picker`, `autofill-capture`, `autofill-prompt`, `autofill-save`, `autofill-save-failed`, `autofill-dismiss`,
  `credential-add|update|delete|reveal` — origins/counts only. The Settings Passwords tab lists accounts in `#credentialsTable` rows
  `tr[data-credential-id]` (sorted by origin then username; empty state `#credentialsEmpty`). Removed channels: `credentials:fill`, `credentials:menu`.

### Updates
- App version + update status: `ShellState.update` =
  `{ version (app.getVersion()), available, downloaded, releasesUrl, enabled, checking, lastCheckedAt, error }` from `src/main/updater.ts`; the Settings
  Updates tab renders `#aboutSection` (`#appVersion`, `#updateStatus[data-update-state=none|downloading|ready]`, `#updateNow`, `#updateCheckNow` /
  `#updateLastChecked` / `#updateError` while not downloaded), `#releasesLink` (opens via `link:open`), and release-notes cards
  `#releaseNotesAvailable` / `#releaseNotesCurrent` (`data-notes-state=loading|ok|missing|error`).
- `update:install` (shell-only, no payload) calls `installUpdate()` only when a download is ready. `update:check` (guardedOn,
  `UpdateCheckArg { source: 'settings' | 'manual' }`) calls `checkForUpdatesNow` — the tab auto-checks on mount ('settings') and `#updateCheckNow` sends
  'manual'. Checks also run on `powerMonitor` resume/unlock-screen and window focus; timer interval is 2 h.
- Throttles by source (skipped checks log `update-check-skipped` `{ source, reason: disabled|in-flight|throttled, sinceMs }` — the `disabled` reason is
  logged for settings/manual sources only; focus/resume skips in dev builds are silent): settings 60 s / resume 15 min / focus 1 h; startup/timer/manual
  are never throttled; each run logs `update-check` `{ source }`. In testMode checks are simulated (no network) and `update.enabled` reports true.
- `update:releaseNotes` (guardedHandle, no payload) returns `{ current, available }` ReleaseNotes — lazy, only fetched when the tab asks.
  `src/core/releaseNotes.ts` parses GitHub release JSON / electron-updater UpdateInfo; `src/main/releases.ts` caches fetches (`net.fetch`, no cookies;
  ok 6 h / miss 10 min; `release-notes` log event — version/ok/status/length, never body) and stores the UpdateInfo-derived notes via
  `setAvailableReleaseNotes`. Repo coordinates are the `RELEASE_REPO` constant mirroring `build.publish` in package.json. Test hooks:
  `simulateUpdateAvailable` / `simulateUpdateDownloaded` / `simulateUpdateFocus` / `simulateUpdateResume`.

### Settings page
- Seven tabs (`#settingsTabs` tablist, `[data-settings-tab=general|local|claude|links|passwords|notifications|updates]`, `#settingsPanel-<id>` tabpanel)
  — active tab is shell-only state in `src/shell/store.ts` (`useSettingsTab`/`setSettingsTab`); `SettingsTabId` + the field → tab map `FIELD_TAB` in
  `src/core/settingsDraft.ts` route a validation error to the tab holding the field. The `links` "Link Handling" tab (`LinksTab.tsx`, `#linkRulesList`
  rows `[data-rule-id][data-rule-invalid]`, `#linkRuleAdd`, `#linkRuleTestInput`/`#linkRuleTestResult`) also hosts the `#allowExternalInput` "Open
  non-GitHub links in system browser" checkbox.
- ux2 P3 tabs (`settings/LocalTab.tsx`, `settings/ClaudeTab.tsx`, shared bits in `settings/fields.tsx`: `CliPathHint`, `FieldError`, `WslDistroSelect`,
  `HostsPointer`): **Devin Local** = `#devinPathInput` (+ `#devinPathInputError` not-found hint from `local.cliPath`), `#localDefaultWslDistroSelect`,
  read-only `#localAgentsSummary` (`[data-local-agent=<path>][data-local-agent-status]` rows from `local.agents`); **Claude Code** = `#claudePathInput`,
  `#claudeAutoArchiveInput`, `#claudePermissionModeDefault`, `#claudeModelInput`, `#claudeKeepAliveInput` (1–240), `#claudeMaxLiveAgentsInput` (1–10),
  `#claudeDefaultWslDistroSelect`, `#claudeHooksEnabledMirror` (not a draft field — commits `claude.hooksEnabled` through `setSettings` like the
  Notifications checkbox). General keeps tenant/API base, tab + Cloud pools, `#sessionsColumnToggle`, shell command and `#hostsBlock` (minus the
  default-distro select); the Workspaces block and `#terminalAllSurfacesInput` are gone (P0).
- Field edits live in a draft (`src/core/settingsDraft.ts` pure model + `src/shell/settingsDraft.ts` store); saves are implicit on tab switch, leaving
  Settings (`requestSurface` in `src/shell/surface.ts` vetoes on invalid drafts), and quit (`settings:flush` push → `commitDraft('quit')` →
  `settings:flushDone`, 1 s timeout in `src/main/settingsFlush.ts`). `settings:commit` (guardedHandle) returns
  `{ ok:true, settings } | { ok:false, errors, message }`; `settings:set` keeps its old behavior for instant-save toggles. Field errors show as
  `aria-invalid` + `#<inputId>Error`, banner `#settingsError`, `#settingsSaved` on success. Log events `settings-commit` / `settings-flush` carry field
  names and counts only. The Devin token Save/Clear and password Add/Edit buttons stay explicit actions — only settings fields are implicit-save.

### Analytics surface
- A 4th rail button `#analyticsButton` swaps the main column to a lazily created `analyticsView` (`src/main/analytics.ts`, `persist:cloud`, no preload)
  loaded with `ANALYTICS_PATH` (`/settings/my-analytics`, `analyticsUrl`/`isAnalyticsUrl` in `src/core/sessions.ts`). It mirrors the devinView branch in
  `applyLayout`/`lowerShell` and stays alive after switching away and reloads in place on each re-entry (`refreshAnalyticsView`, `analytics-refresh` log
  event with `mode: reload|navigate`). Router: same-tab navigations from `analytics` to GitHub open a foreground gh-tab, to other tenant pages route to
  the Cloud view (`devin`), everything else stays in place. Log events `analytics-view-created` / `analytics` `load-error`. Test hook `getAnalyticsBounds`.
- **Two tabs** (shell `AnalyticsTabs` strip, `analytics.tab` setting `'devin'|'claude'` — default `devin`): the Devin tab keeps the hosted view (Refresh
  button → `analytics:refresh` IPC → `refreshAnalyticsView()`); the Claude tab is shell-rendered `ClaudeAnalyticsPanel` and zeroes/detaches the hosted
  view (`getAnalyticsBounds` returns null; re-entering on the Claude tab logs `analytics-refresh-skipped {tab:'claude'}` — the hosted page is created
  lazily when the Devin tab is shown). `#analyticsRefresh` → `claudeUsageRefresh` on Claude / `analytics:refresh` + `devin:usageRefresh` on Devin.
- **Claude usage service** (`src/main/claude/usage.ts`, singleton `claudeUsage()`): pushes `ClaudeUsageState` on `claude:usage` (`createPushedStore`;
  invoke `claudeUsageState`, `claudeUsageRefresh`, send `claudeUsageVisible`). Started eagerly at window creation (usage alerts); visible → fetch+scan every 60 s, hidden → fetch
  every 10 min; `poke('turn'|'hook')` (debounced 5 s) fires on chat `end_turn` and `Stop` hook events. Accounts: per-host `.credentials.json`
  (`claudeAiOauth.accessToken` — never logged/stored in state) + `oauthAccount` email grouping (same email across hosts → one account, fetch via the
  host with the latest `expiresAt`). 401/403/expired → stale fallback (cache `lastBody`, else newest `<configDir>/.usage-cache`); 429/5xx/network →
  keep last good, 1→16 min exponential backoff; `fetchedAt` = the cached body's timestamp when stale. Scanner: incremental per-file cache
  (`{size,mtime,offset,buckets}` → `fileScanPlan` reuse/append/full with a newline line-boundary check), `aggregateUsageLines` for the current + previous
  month, chunked with `setImmediate` yields. WSL hosts are NOT scanned (reading transcripts over `\wsl.localhost` overloads the distro VM): `ClaudeUsageState.wslTotalsPaused` is true while any wsl host is ready and the panel renders `#claudeWslTotalsPaused` ("Token totals for WSL distros are paused"); there is no `byHost['wsl:…']` bucket and the prune pass drops wsl cache keys; `readAccounts` and the `/usage` fetch are unchanged. Cache: `userData/claude-usage-cache.json` (`{version,files,accounts}`) — never written into the CLI's
  configDir. Pure helpers in `src/core/claudeUsage.ts` (`parseUsageResponse`, `aggregateUsageLines`, `fileScanPlan`, `groupAccounts`, `gaugeArc`,
  `resetsIn`, …). `claudeUsage().start()` runs eagerly after `devinUsage().start()` at window creation (usage alerts can't wait for a tab visit).
- **Usage alerts** — `DevinUsageService` (`src/main/devinUsage.ts`, singleton `devinUsage()`, started after `cloudSessions().start()`) polls
  `GET <tenant>/api/personal-analytics/usage-limit` with the Cloud view's `devinDebug` bearer + `x-cog-org-id` header (BOTH required — 401
  without the org header; identity via `cloudSessions().readIdentity()` → `{identity,reason}`, token never logged/stored; 401 → identity re-read
  + one retry). Cadence `usage.devinPollMinutes` (first poll +5 s); failures keep the last good (`stale: true`, backoff 1→16 min). Transient
  identity reasons (`view-not-ready`/`timeout`/`error`) leave status/backoff alone and retry in 30 s, max 6 consecutive; `login-required`/
  `no-devindebug` → status `login-required`. Cache `userData/devin-usage-cache.json` (`{version,tenantUrl,savedAt,body}`, tenant-gated, loaded
  stale). Parsed by `src/core/devinUsage.ts` (`parseUsageLimit`, `fmt`, `shortDate`); state rides `ShellState.usage.devin` (no pushed store —
  `notifyShell` on change; `devin:usageRefresh` send + `refreshAnalyticsView()` both force a poll). `src/main/usageAlerts.ts` `UsageAlertStore`
  (`userData/usage-alerts.json` ledger, cache-class): `deriveUsageAlerts` (`src/core/usageAlerts.ts`) fires thresholds 50/80 once per period —
  highest-only per reading (40→85 fires 80, marks [50,80]), a new `periodKey` re-arms, muted kinds still advance the ledger. Devin metric
  `devin-monthly` (periodKey = `cycle_start`); Claude `claude-session`/`claude-weekly` per non-stale account (`resetsAt` periodKey), fed by the
  claude service's `runFetch`. Alerts become `usage`-kind notification entries (persisted, never banner, `itemKey` = `usage:<metric>:<account>`,
  open → Analytics on the matching tab) gated by `notifications.collect` ∧ `notifications.kinds.usage`. `ShellState.usage` = `{level,items,devin}`
  → `#usageBadge` rail dot (warn amber `#e0a03c` / critical `#d93a2f`), `#devinUsageSummary` + `#claudeUsageSummary` rows inside the strip
  (`ANALYTICS_TABS_HEIGHT = 36 + 24`).

### Devin Local
- `src/main/local/`, `src/shell/local/`, reducers in `src/core/localModel.ts`: spawn the external `devin` binary (`acp`), never fork Node (RunAsNode fuse
  is off). Gate `session/list` / `session/load` / `session/delete` on `agentCapabilities.sessionCapabilities.list` / `agentCapabilities.loadSession` /
  `agentCapabilities.sessionCapabilities.delete` (`local:session:delete` channel; `session-delete` log event; deleting a running session is refused —
  cancel first).
- Bulk delete: `local:session:deleteAll` → `acpHost.deleteWorkspaceSessions` cancels running prompts first, then deletes each session (failures don't stop
  the rest); `session-delete-all` log event `{ workspace, requested, deleted, cancelled, failed }` (counts + path only); the panel keeps an inline
  confirm for bulk delete while single delete is one click. Test hooks: `localDeleteSession`, `localDeleteWorkspaceSessions`. Log prompt/message lengths
  and ids, never content.
- Workspaces in the session column (ux2 P4a): `src/shell/local/LocalSidebar.tsx` is a thin adapter over the shared
  `src/shell/components/sidebar/WorkspaceSidebar.tsx` (header *New session* / *Add workspace* / *Refresh* / *More*, filter box, `SectionHeader` sections
  with collapse/rename/DnD-reorder/new-in-folder, `SessionRow` rows, `moveDisabled` + `onMove` no-op — sessions never move between workspaces, D7);
  `<section data-sidebar="local">`, headers carry `data-workspace`/`data-status`, agent status dot + `[data-host-chip]` for `\\wsl.localhost` paths as
  `headerLeading`. Tree data from the pure `src/core/workspaceTree.ts` (`defaultWorkspaceLabel` = last path segment, `workspaceEntries`,
  `workspaceListData` — folders = workspace paths in array order, unmatched sessions → `recent`; `reorderWorkspaces` permutation guard; shared with
  P4b). `LocalPanel` has no `<aside>` any more (header/chat/terminal only); sessions for every workspace are listed at start, not on first selection.
  IPC: `local:workspace:add|remove|pick`, `local:workspaceReorder {paths}` (`WorkspaceReorderSchema`, rewrites `settings.workspaces` +
  `syncWorkspaces`), `local:workspaceRename {path,label}` (`WorkspaceRenameSchema` → `local.workspaceLabels`), `local:contextMenu`
  (`LocalContextMenuRequestSchema`, kinds `workspace|session|header`; `src/main/local/contextMenu.ts` `LocalContextMenu` — workspace: *New session*,
  *Rename…*, *Open terminal here*, *Reveal in Explorer*, *Delete all sessions…* (needs `sessionDelete` capability + sessions), *Remove workspace*
  (confirm dialog, auto-confirmed in test mode); session: *Open terminal*, *Copy session id*, *Delete*; header: *Add workspace…*, *Refresh all*; actions
  that need shell UI resolve as `{action}` for the sidebar to perform; test mode keeps the invoke open until `localMenuClick`). Log events
  `workspace-add`/`workspace-remove` (`{workspace}` path), `local-workspace-reorder {count}`, `local-workspace-rename` (no detail),
  `local-session-copy-id` (no detail). Test hooks `localMenuItems` / `localMenuClick(id)`. Agents for configured workspaces autostart after
  window creation — `acpHost` waits for `HostsRegistry.whenEnumerated()` first so enabled WSL distros are known; a UNC workspace on a
  disabled/absent distro is skipped and a missing CLI keeps `missing-cli`.
- PR links: `src/core/prLinks.ts` (`stripAnsi`, `extractPullRequestUrls`, `LinkScanner`) scans agent chat output (acpHost via injected `onPullRequestUrl`
  — never user chunks) and devin-pty output (terminalHost `flush`); a new PR URL calls `src/main/local/prAutoOpen.ts` `autoOpenLocalPr` → lazy
  background tab in `local:<sessionId>` gated on `prs.autoOpenTabs`, `pr-auto-open` event with `detail.source` = `local-chat|local-terminal`. xterm uses
  `@xterm/addon-web-links` (plain-click → `localOpenLink`).
- Devin-kind ptys are per-session (`bySession` map, `TerminalSummary.sessionId`, `terminalOpen` takes `{ kind:'devin', workspace, sessionId }`;
  `closeForSession`/`closeForWorkspace` on delete/workspace removal). The GitHub tab scope for Local is `local:<sessionId>` via
  `localScope`/`effectiveScope` in `src/core/tabModel.ts` — `syncScope()` runs at the top of `applyLayout`; the selected local session is lifted to
  `state.localSessionId` via the `local:activeSession` channel (`active-session` log event) and mirrored in `ShellState.localSessionId` so it survives
  surface switches; delete also `closeScope`s the session's tabs.
- Terminal handoff: a selected session's Terminal tab resumes it with `devin -r <id>`; opening it restarts the workspace agent to release the CLI's
  per-session lock and marks the session `terminalOwned` (chat disabled), closing it reclaims the session and reloads its history.
  `releaseSessionForTerminal` refuses (`TerminalHandoffRefused`) while any session in the workspace is running/has a pending permission because the lock
  is process-wide — `session/close` is not implemented by the agent; a restart-cancelled prompt resolves `'cancelled'` (never `'error'`); reclaim happens
  only from the pty's `onExit` (`close(id, { reclaim:false })` for delete/workspace-removal/quit) and retries `session_locked` loads 3×. Log events:
  `agent-restart`, `session-reclaim-error`, `terminal-session-release-error`, `terminal-session-locked`; `terminal-open` carries `sessionId`/`resume`.

## Claude integration

### Sidebar & registry (landed Phase 1)
- Surface: `src/main/claude/`, `src/shell/claude/ClaudeView.tsx`, `src/shell/components/ClaudeSidebar.tsx` — a 5th rail button `#claudeButton` (sparkle)
  listing the machine's Claude Code sessions via the Agent SDK's `listSessions` (`CLAUDE_CONFIG_DIR` or `~/.claude`; the SDK also *writes* `.claude.json`
  and new transcripts into it — tests always copy `tests/fixtures/claude-home`, never point at the committed tree).
- Registry: sidebar state derives from `src/core/claudeRegistry.ts` (pure `reconcile`: one row per non-removed store session, un-remove on newer
  `lastModified`, keep-if-pinned/foldered `'(transcript missing)'`, auto-archive with `unarchivedAt` suppression) persisted to
  `userData/claude-sessions.json` by `src/main/claude/registry.ts` (debounced 200 ms tmp+rename; written on the first mutation only).
- Store: `src/main/claude/store.ts` wraps the SDK + `fs.watch` (`{recursive}`, 250 ms debounce; poll fallback 30 s — fires `onChange` only when
  `projects/` exists; a second watcher error or a `watch()` throw latches `watchFailed` so the poll never retries `startWatch`).
- Controller: `src/main/claude/sessions.ts` (coalesced `refresh`, `lastError`, test-mode `mutations` recorder) with three collaborator modules
  taking the controller — `claude/contextMenu.ts` (menu building + the `menuItems`/`clickItem`/`pendingAction` test seam — in test mode the
  `claude:contextMenu` invoke stays open until `claudeMenuClick` resolves it, same as the production popup), `claude/prTracking.ts` (PR record/refresh/
  notifications — the `recordPr`/`claudeOpenPullRequests`/`refreshPrStates`/`prsOf` delegates), `claude/hooks.ts` (hook listener + install, the
  `ActivityState`/`hooks` snapshot state, hook/chat notifications, `hookInjection`). The fields they share are marked `/** @internal */` on the class.
- Sidebar components shared with Cloud live in `src/shell/components/sidebar/` (generic `SessionRow`/`SectionHeader`/`FolderNameInput`/`PrBadges`/
  `useOptimisticList`/`useRowKeyboardNav`/`dnd.ts` — Cloud-specifics arrive as render props; Cloud DOM ids unchanged, `<section data-sidebar="cloud|claude">`).
  The claude GitHub-tab scope is `claude:<sessionId>` (`claudeScope`/`effectiveScope`).
- Settings `claude.path` (Settings → Claude Code `#claudePathInput`; a non-empty path that doesn't resolve is flagged inline from `claude.cliPath === null`,
  not a commit error), `claude.autoArchiveDays` (0-365, 0 = off; `#claudeAutoArchiveInput`), `claude.showArchived`, `claude.collapsedFolders`,
  `claude.workspaces`/`claude.workspaceLabels`/`claude.defaultWslDistro`/`claude.sessionOrder` (see Settings keys).
  `preload.setSurface` guards on `SurfaceSchema` — new surfaces must be added to the schema.
- Workspaces (ux2 P4b, plan D8 — landed): Claude folders became path-bound workspaces on the shared `WorkspaceSidebar` (`ClaudeSidebar` is the adapter;
  subagent rows, the background-agents section, host chip and activity dots survive through `renderRow`/`extraSections`/`rowOpts`). A session's folder is
  *derived* — the workspace whose path matches its `cwd`, host-aware via `workspaceFor` in `core/workspaceTree.ts` (local paths compare
  case-insensitively after normalisation; a `\\wsl.localhost\D\…` workspace matches a `wsl:D` session by linux cwd, ancestor match on
  segment boundaries — nested workspaces resolve deepest-wins via `workspaceDepth`, and the row meta shows the cwd relative to the workspace, '' on an
  exact match). Sub-folder sessions are workspace members, so they're auto-archive exempt like exact matches. IPC
  `claude:workspaceAdd|Reorder|Rename|Remove`; `newSession(cwd)` from a header passes the path through without the picker; `fork` files itself from the
  same cwd. The free-form folder registry (`claude:folderCreate|Rename|Delete|Reorder`, `claude:sessionMove`, `entry.folder`, the `folders` list) is
  deleted — the loader still tolerates the legacy fields and `registryFileObject` deletes them by name once the migration has consumed them (while
  `legacyFolders` is still pending they are written back as `folders`, so a save before the migration can't lose them). The one-shot migration (`migrateLegacyFolders`
  → most-common `(host,cwd)` per folder → `toWindowsPath`, label = folder name when it differs from the basename) runs in `ClaudeSessions` after the
  first *complete* store refresh — a pass where any host's store fails skips it and retries next refresh — and drops folders whose members resolve to
  no session or an unresolvable host. Logs `claude-folders-migrated {converted,dropped}`.
  Context menu gains *Add workspace…* (header) and on workspaces *New session here*, *Rename…*, *Open terminal here*, *Reveal in Explorer*,
  *Remove workspace*.

### Chat host (landed Phase 2)
- `src/main/claude/host.ts` keeps ONE streaming-input `query()` per live session (`prompt: AsyncIterable<SDKUserMessage>` — a pushable `PromptQueue`;
  `resume` when `isOnDisk(id) || started.has(id)`, else `sessionId`) so `interrupt()`/`setPermissionMode()`/`setModel()` work mid-session; queries are
  opened lazily on the first prompt, idled out after `claude.keepAliveMinutes` and LRU-evicted at `claude.maxLiveAgents` (running never evicted —
  overflow allowed).
- The consumer loop feeds every message through `src/core/claudeTranslate.ts` (`{streaming:true}`) → generic `applyUpdate`/`startPrompt`/`finishPrompt`
  reducers from `localModel.ts`; state lives in `src/main/claude/chatState.ts` (coalesced `claude:chatUpdate` push, zod-guarded) — the same
  `createPushedStore` (`src/main/pushedStore.ts`) that backs `src/main/local/localState.ts`, and the shell mirrors it with `usePushedState` /
  `createPushedStateClient` (`src/shell/pushedState.ts`) for `useClaudeChatState`/`useLocalState`.
- Spike A facts: `interrupt()` makes the iterator throw → `cancelled`; `close()` leaves the child alive 2–7 s → `dispose()` bounds the consumer wait at
  8 s; `closeLive`/`idle`/`LRU`/`dropSession` throws also land in the catch, so `finishPrompt` only runs when the session is actually `running`.
- `canUseTool` parks a promise behind `setPermission` (`allow`/`allow_always` iff `suggestions`/`reject`; `allow_always` → `updatedPermissions: suggestions`;
  `signal` abort → deny) — `claude-permission` logs `{sessionId, tool, decision}`.
- Subagent `tool_use` folds `↳` items into the parent call via the `appendContent` flag on `tool_call_update` (translator sets it on the subagent
  `tool_use` folds and on `tool_result`; the reducer appends `content` in arrival order — a fold arriving after the result keeps the result, where the
  old host-side accumulator dropped it). `LinkScanner` per session feeds
  `autoOpenLocalPr(url, claudeScope(id), 'claude-chat')` (`src/main/local/prAutoOpen.ts` takes `scope` + `source` now; Local callers pass `localScope(id)`).
- `options`: `cwd`, `pathToClaudeCodeExecutable`, `permissionMode`, `model?`, `includePartialMessages:true`, `settingSources:['user','project','local']`,
  `canUseTool`, `abortController`.
- Channels `claude:chatState` (invoke), `claude:chatUpdate` (push), `claude:newSession|prompt|cancel|permission|setPermissionMode|setModel|loadHistory`
  (invoke → `LocalResult` via `handleResult`). `sessions.ts` `newSession(cwd|null)` → `openFolderDialog` (`src/main/dialogs.ts` — records options for `lastOpenDialogOptions()`, honours `AGENT_WORKSPACE_TEST_PICKER_CANCEL`) / `AGENT_WORKSPACE_TEST_CLAUDE_NEW_CWD` →
  `host.newSession` → `open`; `claude.lastSessionId` persists on open and restores on the first list; `versions` = `claude --version` (execFile, 3 s) vs
  the SDK `manifest.json` (`sdkTargetCliVersion()`), re-checked on `claude.path` change. Ctrl+N on the claude surface → `newSession(null)`.
- Fake SDK for tests: `AGENT_WORKSPACE_TEST_CLAUDE_SDK` + `FAKE_CLAUDE_*` (see Env vars).
- Shell: `src/shell/chat/ChatView.tsx` (+ `Cards.tsx`, extracted from `src/shell/local/` — Local e2e ids
  `#messageList`/`#turnSummary`/`#stopReason`/`#composer`/`#sendButton`/`#cancelButton` are the shared DOM contract) inside `ClaudeView`
  (`#claudePermissionMode`, `#claudeModel`, `#claudeVersionWarning`, `data-live`, `#claudeNewSession`/`#claudeNewSessionEmpty`, `#claudeError`).
- Settings `claude.{defaultPermissionMode,model,keepAliveMinutes 1-240/15,maxLiveAgents 1-10/3,lastSessionId}`. Log events: `claude-query`, `claude-prompt`,
  `claude-turn`, `claude-permission`, `claude-live`, `claude-history`, `claude-query-error`, `claude-chat-state-invalid`. Test hooks: `claudeChatState`,
  `claudeNewSession`, `claudePrompt`, `claudeCancel`, `claudePermission`, `claudeLiveCount`.

### Terminal & background agents (landed Phase 3)
- `terminalHost` kind `'claude'` shares `bySession`/`inflightBySession`/`closeForSession` with devin-kind (one pty per session; `reclaimOnExit:false`, no
  sessionGate). Args are appended at spawn (`-r <id>` resume, `--session-id <id>` in-memory-new, `attach <agentId>`); the allowed-cwd list = workspaces +
  home + the session cwd itself, and a missing session cwd falls back to home (ConPTY error 267).
- `terminalHost.claudeGate` (`onOpen`→`claudeSessions().beginTerminal` — throws `'Cancel the running prompt first'` when running, else `closeLiveQuery` +
  `terminalOwned`; `onExit`→`endTerminal` re-lists + `loadHistory`) is the one-writer gate; `terminal:open` fills `cwd` from the chat session and derives
  resume-vs-new via `sessions.terminalModeFor` (isOnDisk || host.started). `forget` also `closeForSession`s. `claudeGate`/`terminalExit` pty output feeds
  `autoOpenLocalPr(url, claudeScope(id), 'claude-terminal')` (the host's `onPullRequestUrl` now gets `{scope, source}`).
- `src/main/claude/backgroundAgents.ts` polls `claude agents --json --all` (local 15 s focused / 60 s blurred; wsl hosts 120 s / 300 s, each poll being a `wsl.exe` spawn; immediate on focus and after `agentStop`, coalesced
  in-flight+dirty) parsed by `src/core/claudeAgents.ts#parseAgentsJson` (tolerant: requires `id`; maps `sessionId`/`session_id`, `name`/`description`,
  `status`/`state` → running|completed|stopped|unknown, `cwd`, `startedAt`; probe ran `claude --bg` in a trusted cwd (untrusted dirs and home refuse);
  item shape `{pid,id,cwd,kind,startedAt(ms),sessionId,name,status:busy|idle,state:working|done}` — item persists with `state:done` after finish/stop until
  `claude rm`). `snapshot().agents` is the raw list; `agentStatus` is overlaid per sessionId on each row (claudeRegistry untouched).
- Menus: session menu gains `open-terminal` after Fork; `kind:'agent'` menus get Attach (`action:'attach-agent'` — the shell maps it to
  `terminalOpen({mode:'attach'})`) + Stop (`sessions.agentStop` → `claude stop <id>` 3 s then a mutate refresh). Channels `claude:agentStop`
  (invoke→LocalResult), `claude:agentsRefresh` (send). Env: `AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_CMD`, `AGENT_WORKSPACE_TEST_CLAUDE_AGENTS_POLL_MS`,
  `AGENT_WORKSPACE_TEST_TERMINAL_CMD` (see Env vars).
- Hooks: `claudeAgents()`, `claudeAgentsRefresh()`, `claudeTerminalOpen(id)`. Log events: `claude-terminal`, `claude-agents`, `claude-agents-parse`,
  `claude-agents-error`, `claude-agent-stop`.
- Gotcha: on Windows/Electron 44, when the close that started cleanup was itself a vetoed `app.quit()`, a later `app.exit(0)` can return WITHOUT exiting
  or block — shutdown keeps `app.exit(0)` plus a best-effort in-loop `shutdown-exit-watchdog` 5 s `process.exit` fallback; `destroy()` is try/catch'd;
  e2e specs cancel a running Claude turn before `app.close()`. `expect.poll` does not retry a throwing readFileSync (poll `existsSync` instead).

### Hooks, activity & notifications (landed Phase 4)
- `src/main/claude/hookServer.ts` is a loopback `127.0.0.1` http listener (`Authorization: Bearer <token>`; `/agent-workspace/hook/<event>`; body ≤256KB;
  immediate `{}` reply; never logs cwd/tool input/response) — `{version:1,port,token}` persists in `userData/claude-hooks.json` (0600 where supported;
  port = sha256(userData) → 49152–65535, +1 probing up to 20 on EADDRINUSE). Log events: `claude-hooks-listen`, `claude-hook`, `claude-hook-rejected`,
  `claude-hook-ignored`, `claude-hooks-error`.
- `src/core/claudeHooks.ts` (`HOOK_EVENTS`/`hookUrl`/`buildHooksBlock`/`settingsFlagJson`/`mergeHooksIntoSettings`/`removeHooksFromSettings`/`isOurHook`)
  owns the block shape — `SessionStart` intentionally absent (never fires via `--settings`; still true on 2.1.302, kept in `HOOK_EVENTS` as a no-op);
  `PostToolUse` carries `matcher:'Bash'`, and the `gh pr` filter runs server-side in `notificationsForHookEvent` (`src/core/claudeNotify.ts`), not the
  CLI's `if`.
- `src/main/claude/hooksInstall.ts#applyGlobalHooks` merges/removes the block in `<configDir>/settings.json` on `claude.hooksEnabled` (one-time
  `.agent-workspace.bak` backup, tmp+rename, unparseable → no write + `hooks.error`; `claude-hooks-install {enabled,changed,ok}`). `applyGlobalHooks` is async (`fs/promises`); `ClaudeHooks.applyHooks()` stays a sync-void call but coalesces (one run in flight + one dirty follow-up) and skips a host whose `hooksApplyKey(host, enabled, block)` equals the key of its last *successful* write (`lastApplied`; an error leaves it unset so the next trigger retries).
- `hooks.ts` owns an `ActivityState` (`src/core/claudeActivity.ts`: applyHookEvent → running|waiting; `activityFor(activity, chat|null, id)` — chat
  running/pendingPermission wins; entries expire after 2 h without an event, swept every 10 min + each refresh) overlaid on snapshot rows + a
  `hooks {port,enabled,installed,error}` block.
- Hook events → `notificationsForHookEvent` (titleFor = sidebar title else cwd basename else 'Claude session'; `recentPermission` map dedups
  `PermissionRequest`/`Notification{permission_prompt}` within 5 s; prUrls → `autoOpenLocalPr(url, claudeScope(id), 'claude-hook')`);
  `Notification{permission_prompt}` after a `PermissionRequest` for the same `session_id`/`prompt_id` never double-posts (Spike B: `idle_prompt` never
  arrived — 'waiting' comes from `PermissionRequest`, 'finished' from `Stop`).
- Chat-derived events come from `host.ts` `onEvent(id,'waiting'|'finished'|'blocked')` (`canUseTool` park → waiting; `end_turn` → finished; any other
  non-cancelled finish → blocked, body = error ≤200) — never `cancelled`, and entries respect `notifications.collect` + the same `notifications.kinds`
  toggles. Claude entries are `source:'claude'`/`ownerUserId:null` keyed `session:claude:<id>` (`pruneForeign` keeps them); `openNotification` on a
  claude entry → `surface='claude'` + `claudeSessions().open(id)`, prUrl → tab in `claude:<id>` scope.
- Pty injection: `sessions.hookInjection(id,mode)` → `hooks.ts#injection` (null on attach or when the listener failed) → `TerminalOpenOptions` claude variant
  `extraArgs=['--settings', settingsFlagJson(port,'AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN')]` + `extraEnv` token, filled in `terminalIpc.ts` (fake pty echoes
  `env:AGENT_WORKSPACE_CLAUDE_HOOK_TOKEN=set`); it also adds `--permission-mode <claude.defaultPermissionMode>` (resume/new).
- Settings `claude.hooksEnabled` (default false; Settings → Notifications `#claudeHooksToggle`/`#claudeHooksStatus`/`#claudeHooksError`). Test hooks:
  `claudeHookInfo` ({port,token}), `claudeActivity`, `claudePostHook(event,body)`/`claudePostHookRaw(...,auth)`, `claudeHooksSettingsPath`.

### Pull requests (landed Phase 5)
- Every detected Claude PR URL funnels through `claudeSessions().recordPr(id, url, 'chat'|'terminal'|'hook')` BEFORE `autoOpenLocalPr` — chat `LinkScanner`
  (`host.ts` flushes the scanner at `result.finish` or a trailing URL stays in carry), claude-pty output (`index.ts` maps `'claude-terminal'` scope →
  session id), `PostToolUse` hook `prUrls`.
- Registry entries hold `prs: ClaudeRegistryPr[]` (`{url, state|null, seenAt, completedAt, source}`, `MAX_PRS_PER_SESSION` 20; legacy `prUrls` strings
  migrate to `prs` on load; `recordPr` touches seenAt, `setPrState` reports `completed` exactly once on first merged|closed, `openPrsOf` = non-removed
  non-final newest-seenAt-first, `prCountsFor` feeds the row's `prs` badge counts via the snapshot overlay — reconcile only refills them on refresh).
- `prTitles` (`src/main/prTitles.ts`) is now a title+state cache: `getInfo(url)`, `get` (title compat), `ensure(urls,{maxAgeMs})` (merged/closed final 6 h;
  non-final default or caller maxAge), `parsePrState` on the same HTML, `seed()` for tests, debounced `onChange` + notifyShell; a fetch that fails or
  can't parse a state keeps the previous one (never regresses known state to null) and `pr-title` logs `state`. It falls back to
  `gh pr view <url> --json state,isDraft,title` when the page fetch yields no state (`resolveGhCmd` via where/which cached 10 min;
  `pr-title {via:'page'|'gh'}`; test `AGENT_WORKSPACE_TEST_GH_CMD`).
- `prTracking.ts#refreshPrStates(reason)` (10 min timer while focused + `setPrsPanel` open seam + `claudeRefreshPrStates` hook) re-ensures non-final
  urls; the `onChange` subscription writes `setPrState` for changed states → first final flip →
  `notificationStore().add({kind:'pr-completed', source:'claude', prUrl, prState})` (collect + `kinds.prCompleted`).
- `prs.ts#allOpenPullRequests()` merges Devin `openPullRequests` + `claudeOpenPullRequests()` (non-missing sessions, sidebar title, `source:'claude'`) —
  `openPrs()`/`publicState` counts/`PrStore.reconcile` (also after every recordPr/cache-driven state change; works with no Devin token since reconcile
  isn't gated on the poller). `openPr` looks the url up in the merged list: `source:'claude'` → `openClaudeSessionPr` (surface claude +
  `claudeSessions().open` + tab in `claude:<id>` — the Phase 4 notification path extracted).
- Persisted `notifications.json` schema gained `source` (zod strips unknown keys — without it Claude entries died at reload and got `pruneForeign`d).
  Test hooks: `claudeRecordPr`, `claudePrs(id)`, `claudeRefreshPrStates`, `prTitlesSeed(url,{title,state})`.

### Execution hosts (WSL) (landed Phase 8)
- `src/core/execHost.ts` (pure): `HostId` `'local' | \`wsl:<distro>\``, `hostIdForPath`/`toHostPath`/`toWindowsPath` (UNC forms `\\wsl.localhost`/`\\wsl$`/`//wsl.localhost`), `spawnSpec`/`ptySpec` (`wsl.exe -d D --cd <linux cwd> -e /usr/bin/env …` / `-ilc 'exec "$0" "$@"'`; fish → `exec $argv`), `parseShellEnv`/`mergeShellEnv` (`WSL_ENV_DENYLIST`), `parseWslList`, `shellFamily`, `displayPath`/`workspaceLabel`.
- `src/main/hosts.ts` singleton: async enumeration (`-l -v` utf16le, running+default or explicit `settings.hosts.wslDistros`; a stopped distro is never started implicitly — only explicit listing enables it; `statuses()`/`list()`/`enabledDistros()` read the cached rows and never spawn — enumeration runs once at `start()`, on a 5 min interval, on window focus once the cache is older than `ENUM_CACHE_MS`, and on `refresh()`; `onStatusChange` fires only when `statusesChanged` (`src/core/execHost.ts`, ignores timestamps/timings) says the rows changed, except that `refresh()` always republishes), per-host probe (`home`/`shell`//CLI paths/`gh`/`inotifywait`/hook reachability — loopback then `vEthernet (WSL)` IPv4 with a second `hookServer.listenOn`), `-ilc` env capture (also prints a second `__DW_NODE__` marker + `command -v node && node -p process.versions.node || echo NONODE`, parsed by `parseNodeVersion` into `HostStatus.node` — a version string, or `null` for `NONODE` *and* when env capture is disabled/failed (null = unknown); spawn `stdio:['ignore',…]`, marker-parsed, 10 min `ENV_CACHE_MS` cache refreshed at next spawn — `shellEnv()` primes, `spawnOn`/`execOn`/`ptySpawnSpec` read the cache), `withConfigDir` (per-process mutex swapping `CLAUDE_CONFIG_DIR`), `errorParts` joined into `hostErrors`.
- The local `CLAUDE_CONFIG_DIR` is captured once at `HostsRegistry` construction (`resolveLocalConfigDir` in `src/core/execHost.ts`; `localConfigDir()` /
  `configDir(LOCAL_HOST)`); a `withConfigDir` swap is only ever visible to the SDK through `process.env` and must never be observed through
  `configDir()` — never read `process.env.CLAUDE_CONFIG_DIR` from app code (ux3 S7: the usage scanner raced a swap and cached a whole WSL store as
  `local:`; `runScan` now also prunes cache keys of scanned hosts that no longer map to a file → `usage-cache-pruned {count}`).
- The *path form selects the host* — a UNC `\\wsl.localhost\<D>` cwd/workspace means wsl everywhere (session rows, agent spawn, pty, store, gh). `hosts.errors()` feeds `claude.hostErrors`; `hooks.ts` applies the hooks block per `allHosts()`; `store.ts` watches per host (inotifywait → tiered poll: 30 s scan computes the recent-20 ∪ hot set, 2 s tick stats it and emits `<proj>/<id>.jsonl` relative paths).
- Never do synchronous fs on a wsl host's config dir from the main process, and never touch it before the probe is `ready` — an unresponsive distro makes every `\\wsl.localhost` call block the main thread for the SMB timeout (~60 s; v1.2.1 hung at startup this way). Gate with `hosts().fsReady(host)` / `readyList()` (`isFsReady` in execHost.ts), use `fs/promises`, and race per-host work against `HOST_FS_BUDGET_MS` (`usage-scan-host-timeout`). `claude-list`/`usage-scan`/`usage-fetch` carry `skippedHosts`; `claudeUsage()`/`devinUsage()` start after the shell `loadURL`. Regression e2e: `tests/e2e/hostsStartup.spec.ts` (`FAKE_WSL_PROBE_DELAY_MS`).
- Never log env values or filesystem paths under hosts — `host-list`/`host-probe`/`host-env`/`host-spawn` carry ids, counts, ms only. Test hooks: `hosts`, `hostStatus(id)`, `hostRefresh(id?)`, `hostShellEnvKeys(id)`.
- Settings: `hosts.{wslEnabled,wslDistros:null|auto,overrides[id].{claudePath,devinPath,home,shell,envCaptureDisabled}}`; the Settings → General `#hostsBlock` lists every distro (enabled rows probed, others `stopped`/`disabled`). The default-distro select moved to the per-surface keys `local.defaultWslDistro` / `claude.defaultWslDistro` (see Settings keys) — `hosts.defaultWslDistro` is migrated away on load.

### Deferrals closed (landed Phase 6)
- Subagent transcripts under a session row — `claude:subagents` (`loadSubagents`, lazy + cached, invalidated at turn end and on watch changes, title =
  first user text via `titleFromPrompt` else `agent-<id>`) and `claude:openSubagent` (synthetic `<sessionId>/<agentId>` read-only chat session in
  `ClaudeChatState.subagentSessions` via `ensureSubagentSession`/`loadSubagentHistory`; `state.selectedSubagentId`, cleared on `claude:open`;
  `dropSession` removes its keys). Fixture `claude-home/.../subagents/agent-fixture01.jsonl` (verified via `getSubagentMessages` — no `dir` option).
- Host tracks `currentMessageIds` per session (`messageIdFromStreamEvent` → `translateSdkMessage { streaming:true, messageId }`, reset at `result`) so
  consecutive API messages render separately — fake SDK emits `message_start` per group, `FAKE_CLAUDE_TWO_MESSAGES=1` splits a turn into two API messages.
- claude-kind `hookInjection` adds `--permission-mode <claude.defaultPermissionMode>` (see Hooks); `prTitles` gained the `gh pr view` state fallback
  (see Pull requests; test `AGENT_WORKSPACE_TEST_GH_CMD` full command line + `FAKE_GH_JSON` via `out/fixtures/fakeGh.cjs`).
- The store watcher now passes changed filenames — `<id>.jsonl` on a `terminalOwned` session → debounced 1 s `host.loadHistory` (live terminal turns in
  chat; `inFlight` guard); any `<id>`/`subagents` change invalidates the subagent list. `usage.costUsd` reaches the pill from `result.total_cost_usd`
  (`FAKE_CLAUDE_COST_USD`).
- Quit: `state.shutdownComplete` flips at the end of `shutdown()` → the second `close` passes through → `app.quit()` (watchdog `process.exit` stays
  last-resort; `quitAndInstall` branch kept).
- Hooks: `claudeSubagents`, `claudeOpenSubagent`, `claudeChatMessageIds`, `shutdownState`. #11: `SessionStart` still never fires via `--settings` on 2.1.302
  (kept in `HOOK_EVENTS` as a no-op).

## Conventions
- `src/core/` is pure TS — no `electron` imports (unit-testable).
- All IPC payloads are validated with the zod schemas in `src/shared/ipc.ts`; add a schema when adding a channel.
- IPC handlers go through `ipcGuard` (`guardedHandle`/`guardedOn`) — shell sender only.
- Log URLs/ids/lengths only — never page or process output text (terminal output, ACP stderr, credential usernames/passwords are all excluded).
  Claude log details are ids/counts/durations only — never `configDir`, cwd, tool input/response or terminal output. Prompt/message lengths and ids,
  never content.
- `tenantUrl`/`apiBase` must be https (localhost http only in tests via `AGENT_WORKSPACE_TENANT_URL`).
- Remote views (devin + `gh:*` tabs) get only `out/autofill-preload.cjs` (`src/autofill/preload.ts`): sandbox + contextIsolation stay on, it exposes
  nothing via contextBridge, and it talks to main only over `autofill:*` channels guarded by `hostedHandle`/`hostedOn` (`fromHostedView`: sender is a
  hosted view, frame origin == top-frame origin). Partitions stay separate.
- Shell loads only `app://shell/...`; strict CSP — `script-src 'self'`, no inline script; `style-src` allows `'unsafe-inline'` only because xterm.js
  injects `<style>` elements (P4b) — keep all other directives unchanged.
- Explicit `webContents.close()` on tab/window teardown; the splitter drag live-resizes hosted views (`moveDrag` → `applyBounds` + a non-persisting
  `state:update`) — never restack the shell mid-drag, and on macOS `raiseShell` paints the shell opaque because a transparent top view does not
  composite (white-out).
- Secrets (vault passwords) never reach renderers or logs; credential IPC handlers must not log payloads.
- The Devin API token lives only in `src/main/secrets.ts` (safeStorage-encrypted `userData/secrets.json`) and main-process memory: never add it to
  `ShellState`, IPC replies, or `log()` calls. Scrub error strings with `sanitizeMessage`.
- `preload.setSurface` guards on `SurfaceSchema` — new surfaces must be added to the schema.
- Smoke isolation: The isolated identity exists because electron-builder's NSIS always uninstalls the registered install of the same appId
  (`HKCU\Software\<GUID>\InstallLocation`, regardless of `/D=`) — smoking the real artifact on a dev machine removes the user's installed app.
- Rename / migration (Devin Workspaces → Agent Workspace, v2.0): `build.nsis.guid` is pinned to `1f69b7bc-532a-5b53-bb75-cfe47a155a29` — the
  *pre-rename* product's GUID — so NSIS treats the new installer as an upgrade of the existing install (smoke pins `8bc73818-…` the same way); the
  GUID is the one deliberate carry-over, do not change it. `build/installer.nsh` (`!macro customInit`, runs in `.onInit` AFTER `initMultiUser` seeds
  `$INSTDIR` from the registry `InstallLocation`) redirects only the old default-named folder (`...\Devin Workspaces` / smoke equivalents) to the new
  `Programs\${APP_FILENAME}` — custom folders are kept. `src/main/bootstrap.ts` applies `AGENT_WORKSPACE_USER_DATA` and runs
  `src/main/migrate.ts#runProfileMigration` (rename `devin-workspaces` → `agent-workspace` profile dir + `Partitions\devin` → `Partitions\cloud` +
  updater-cache cleanup, never throws); it must stay the FIRST import of `index.ts` and `log.ts` because `log.ts` mkdirs userData at import.
  `src/core/claudeHooks.ts#LEGACY_HOOK_PATH_PREFIXES` (`/devin-workspaces/hook/`) is accepted by `isOurHook` and the hook server until a later
  release; `hooksInstall.ts` renames the one-time `settings.json.devin-workspaces.bak` backup. On darwin only, when the migration ran this launch
  and a safeStorage decrypt fails (`secrets.ts` / `credentials.ts`), the undecryptable file is reset (Keychain keys are per app name) — that gate is
  what keeps an ordinary Keychain hiccup from deleting anything.
- `test:hook` IPC bridge (test mode only): the smoke spec reaches main-process test hooks through the test-mode-only `test:hook` IPC
  (`agentworkspace.testHook(name, ...args)`, registered in `registerTestHooks`) because Electron's browser CDP target does not implement
  `Runtime.evaluate`. Keep it — the installed smoke depends on it.
- Test fixtures never point at the committed `tests/fixtures/claude-home` tree — copy it (the SDK writes into its config dir).
- e2e: cancel a running Claude turn before `app.close()`; `expect.poll` does not retry a throwing readFileSync (poll `existsSync` instead).
- Docs: `README.md` is the user-facing description of the app and must be kept in sync with the code: whenever a PR adds, removes or renames a
  user-visible feature, rail button, Settings field/tab, keyboard shortcut, persisted file in userData, or install/update step, update the matching
  README section (intro bullets, First run, Notifications and PR auto-open, Devin Local, Settings reference, Keyboard shortcuts, Where things live) in
  the same PR. AGENTS.md is for implementation notes; the README is for users — no ids, channel names or log events there.
- This file is CRLF — keep it that way.

## Test hooks

All are `__agentworkspace` hooks (test mode only; reachable from the installed smoke via the `test:hook` IPC).

| Hook | Purpose |
|---|---|
| `ipcProbe()` | IPC guard probe; also reports `pooled` (whether a non-active pooled view passes `fromHostedView`). |
| `clipboardWrite` / `clipboardRead` | Wrap Electron's clipboard. |
| `setSessionsOpen(v)` / `getSessionsBounds()` | Toggle / measure the Cloud session sidebar. |
| `cloudState()` / `cloudRefresh()` | Cloud sidebar snapshot / force a list (reloads the fixture file). |
| `cloudMenuItems` / `cloudMenuClick` / `cloudMutations()` | Cloud context-menu descriptions, click an item, read the fake backend's recorded ops. |
| `cloudNewSession(folder)` / `cloudNoteHomeNavigation(id)` | Drive the new-session pending-folder watch. |
| `cloudViewsInfo()` / `cloudShow(id)` / `cloudPrefetchHook(id)` / `cloudIdleSweep()` / `setCloudKeepAliveMs(ms)` | Cloud view pool inspection and control. |
| `getAnalyticsBounds` | Analytics view bounds. |
| `simulateUpdateAvailable` / `simulateUpdateDownloaded` / `simulateUpdateFocus` / `simulateUpdateResume` | Updater simulation (no network in test mode). |
| `localDeleteSession` / `localDeleteWorkspaceSessions` | Devin Local single / bulk delete. |
| `localMenuItems` / `localMenuClick(id)` | Local sidebar context-menu descriptions (test mode describes instead of popping), resolve the open `local:contextMenu` invoke by item id → `{action}`. |
| `claudeState` / `claudeRefresh` / `claudeSelect` | Claude sidebar snapshot / refresh / select a session. |
| `claudeMenuItems` / `claudeMenuClick` / `claudeMutations` | Claude context-menu descriptions, resolve the open `claude:contextMenu` invoke, recorded mutations. |
| `claudeConfigDir` / `claudeSdkProbe` | Resolved Claude home / SDK load probe. |
| `claudeChatState` / `claudeNewSession` / `claudePrompt` / `claudeCancel` / `claudePermission` / `claudeLiveCount` | Claude chat host driving and inspection. |
| `claudeAgents()` / `claudeAgentsRefresh()` / `claudeTerminalOpen(id)` | Background agents list / poll now / open the claude-kind pty. |
| `claudeHookInfo` ({port,token}) / `claudeActivity` / `claudePostHook(event,body)` / `claudePostHookRaw(...,auth)` / `claudeHooksSettingsPath` | Hook listener info, activity overlay, post a hook event (authenticated / raw), path of the merged `settings.json`. |
| `claudeRecordPr` / `claudePrs(id)` / `claudeRefreshPrStates` / `prTitlesSeed(url,{title,state})` | Record a Claude PR, read a session's PRs, re-ensure states, seed the title+state cache. |
| `claudeSubagents` / `claudeOpenSubagent` / `claudeChatMessageIds` | Subagent list / open read-only / per-session current message ids. |
| `claudeUsageState` / `claudeUsageRefresh` | Claude usage state snapshot / force fetch+scan (resolves when both finish). |
| `devinUsageState` / `devinUsageRefresh` | Devin usage metric state snapshot / force a poll (resolves when it finishes). |
| `lastOpenDialogOptions()` | The options of the most recent `openFolderDialog` call (recorded in test mode). |
| `withConfigDirHold(id, ms)` | Holds a host's `configDir` context open (WSL env capture) so a configDir read races the hold. |
| `shutdownState` | Reads `state.shutdownComplete`. |

## Log events

Detail keys are ids/counts/durations/booleans only unless stated. Also carried: `drag-*` events have `axis`; `terminal-open` carries `sessionId`/`resume`;
`session-update` with kind `usage_update` carries `used`/`size` (ids and numbers only).

| Event | Detail keys / notes |
|---|---|
| `updater-disabled` | `reason: unsigned-mac` (unsigned Mac builds). |
| `context-menu` | editable/hasSelection/hasLink booleans only. |
| `terminal-clipboard` | op + length only. |
| `terminal-env` | `added: [...]` (`WT_SESSION`/`TERM_PROGRAM` added to devin-kind ptys). |
| `terminal-dispose-error` / `terminal-dispose-failed` | ConPTY teardown misbehaving at quit. |
| `terminal-toggle` | Terminal dock toggled; from the Ctrl+` shortcut carries `{ open, source:'shortcut' }` (not emitted off dock surfaces — the shortcut is a no-op there). |
| `terminal-open` | carries `sessionId`/`resume`. |
| `pane-toggle` | `{ paneOpen, source, resized, fromWidth, toWidth, maximized }`. |
| `window-placement` | Window bounds persisted per display config. |
| `window-quiet` | `{ opacity: 0, skipTaskbar: true }` — test-mode quiet launch applied. |
| `window-activate` | `{ reason, quiet }` — window-bring-forward request via `activateWindow`; `quiet: true` means it showed without activating. |
| `tabs-preload` | Visible scope's discarded tabs background-loaded. |
| `rule-tab` / `rule-tab-background` | `{ruleId, ruleKind}` — never the pattern. |
| `cloud-token` | fixed `reason` ('view-not-ready'\|'no-devindebug'\|'login-required'\|'timeout'\|'error'). |
| `cloud-connect` | `{ok:false, reason:'timeout'}` when CONNECTING for 20 s. |
| `cloud-list-retry` | `session/list` timeout retried once on the live socket. |
| `cloud-watchdog` | 30 s watchdog re-ran the token/connect path. |
| `cloud-refresh-force` | Refresh button forced a reconnect. |
| `cloud-cache` / `cloud-cache-error` | `{loaded,...}` — cached list load. |
| `cloud-new-session-settled` / `cloud-new-session-skip` | skip reasons `{existing\|not-listed\|folder-gone}`. |
| `cloud-org-change` | `{reason}`, no ids. |
| `cloud-mutate` | `{op,ok,status}` only. |
| `cloud-session-reorder` | `{ section: 'folder'\|'pinned'\|'recent'\|'participated', count }` — row drag in the Cloud sidebar persisted to `sessions.sessionOrder` (app-local, no server op). |
| `cloud-view-show\|create\|rekey\|duplicate\|discard\|discard-cancelled\|crashed` | kinds/counts/ids only. |
| `pr-read` / `pr-dismiss` | `{ all, count }`. |
| `prs-panel` / `prs-save-error` | PR panel open/close, store write failure. |
| `pr-auto-open` | `detail.source` = `local-chat\|local-terminal\|claude-chat\|claude-terminal\|claude-hook` or the poller; `catchUp` for ledger catch-up. |
| `pr-catch-up` | `{ count, lastGoodAgeMs }`. |
| `pr-open` | PR opened from the panel. |
| `pr-title` | never the title text; `state`, `{via:'page'\|'gh'}`. |
| `poll-error` | `op` (`self\|list\|session`). |
| `notifier-self` / `notifier-focus-poll` / `notifier-org-mismatch` | Poller identity/focus events — booleans/counts/durations only, never the user id. |
| `identity-resolve` / `identity-rejected` / `identity-observe` / `identity-observe-error` / `identity-reset` / `identity-save-error` | Service-user identity resolution — booleans/counts/durations only, never the user id. |
| `badge` | Taskbar overlay unread count. |
| `notifications-pruned` | counts only. |
| `autofill-query` / `autofill-picker` / `autofill-capture` / `autofill-prompt` / `autofill-save` / `autofill-save-failed` / `autofill-dismiss` | origins/counts only. |
| `credential-add\|update\|delete\|reveal` | origins/counts only. |
| `update-check` / `update-check-skipped` | `{ source }` / `{ source, reason: disabled\|in-flight\|throttled, sinceMs }`. |
| `release-notes` | version/ok/status/length, never body. |
| `settings-commit` / `settings-flush` | field names and counts only. |
| `settings-repaired` / `settings-migrated` | `{ dropped: [dotted paths], preserved: true }` (invalid leaves defaulted in memory, raw value kept in the file until touched) / `{ from: 'hosts.defaultWslDistro' \| 'spike-state.json' }` — one-shot load-time migrations. |
| `store-preserved` | `{ store: 'settings' \| 'claude-sessions' \| 'local-sessions' \| 'notifications' \| 'pr-ledger', keys: [dotted paths, ≤50] }` — once at load when the file carried data this build does not know (see "Stores preserve unknown data"). |
| `analytics-refresh` / `analytics-view-created` / `analytics` | `mode: reload\|navigate`; `load-error`. |
| `analytics-refresh-skipped` | `{ tab }` — surface re-entered on the Claude tab (nothing hosted to reload). |
| `usage-fetch` | `{ ok, status, ms, stale, accounts, skippedHosts }` — OAuth `/usage` fetch per account group (the bearer token is never logged); `skippedHosts` = hosts not probed-ready or past `HOST_FS_BUDGET_MS`. |
| `usage-scan` | `{ files, changed, skipped, skippedHosts, ms }` — transcript-scan pass over `<configDir>/projects/**/*.jsonl` (incl. `subagents/`). |
| `usage-scan-host-timeout` | `{ host, ms }` — a ready host's projects walk exceeded `HOST_FS_BUDGET_MS` (wedged UNC); the host lands in `skippedHosts` for that pass. |
| `usage-cache-load` | `{ files }` — `userData/claude-usage-cache.json` loaded. |
| `usage-cache-pruned` | `{ count }` — scan dropped cache keys of scanned hosts that no longer map to a file (e.g. pre-S7 `local:` keys from a WSL store). |
| `devin-usage-fetch` | `{ ok, status, ms, stale, reason? }` — `reason: login-required\|no-devindebug\|view-not-ready\|timeout\|error\|http\|parse\|network\|disabled` (channel `cloud`; token never logged). |
| `devin-usage-cache` | `{ loaded }` — `userData/devin-usage-cache.json` load. |
| `usage-alert` | `{ metric, threshold, percent }` — a threshold crossed (fires even when the kind is muted; channel `shell`). |
| `usage-alerts-save-error` | `{ message }` — ledger write failure. |
| `active-session` | Local selected session lifted to state. |
| `session-mode-set` / `session-mode-unavailable` / `session-mode-error` | `{ sessionId, modeId, source:'new'\|'rebind' }` — `local.defaultMode` applied on session/new|rebind (never load); `unavailable` also carries `available` (count; 0 when the agent advertised no modes); `error` carries `message` when `session/set_mode` failed. |
| `session-delete` / `session-delete-all` | `{ workspace, requested, deleted, cancelled, failed }` (counts + path only). |
| `workspace-add` / `workspace-remove` | `{ workspace }` (path only). |
| `picker-folder-missing` | `{ surface: 'local' \| 'claude' }` — `*.pickerFolder` is set but no longer exists; the picker fell back to the distro home / OS default (the path is never logged, the setting is kept). |
| `local-workspace-reorder` | `{ count }`. |
| `local-session-reorder` | `{ section: 'folder'\|'pinned'\|'recent'\|'participated', count }` — row drag in the Local sidebar persisted to `local.sessionOrder`. |
| `agents-autostart` | `{ count, skipped }` — configured workspaces autostart after window creation (fix/ux2-local-startup); UNC workspaces whose distro isn't enabled count as `skipped`; a missing CLI keeps `missing-cli`. |
| `local-workspace-rename` / `local-session-copy-id` | No detail (label and id are never logged). |
| `agent-restart` / `session-reclaim-error` / `terminal-session-release-error` / `terminal-session-locked` | Local terminal handoff. |
| `shutdown-exit-watchdog` | 5 s `process.exit` fallback after `app.exit(0)`. |
| `claude-sdk-load` | `{ok,ms,version}` (version read by resolving the SDK entry — its exports map blocks `./package.json`). |
| `claude-list` / `claude-watch` / `claude-select` / `claude-mutate` / `claude-menu` | Sidebar/registry ops; `claude-list` carries `{ count, skippedHosts, ms, source }`; `claude-watch` carries `{ mode: 'poll-wsl'\|'inotify', host, events }` for wsl store watchers. |
| `host-exec` | `{ host, kind: 'enum'\|'probe'\|'env'\|'exec'\|'spawn' }` — one per `wsl.exe` invocation (enumeration incl. the terminal host's `-l -q`, probe/CLI resolution/hook curl, env capture, `execOn`, `spawnOn`, pty spawn, the inotify watcher, each `ghSpec` use) so a soak can count them; ids and enums only. |
| `claude-registry-load-error` / `claude-registry-save-error` | Registry persistence. |
| `claude-folders-migrated` | `{ converted, dropped }` — one-shot folder → workspace migration (P4b). |
| `claude-workspace-add` | `{ host }` — `claude:workspaceAdd` (the path is never logged). |
| `claude-workspace-reorder` | `{ count }`. |
| `claude-session-reorder` | `{ section, count }` — row drag in the Claude sidebar persisted to `claude.sessionOrder`. |
| `claude-workspace-rename` / `claude-workspace-remove` | No detail (paths and labels are never logged). |
| `claude-query` | `{mode:new\|resume,ms}`. |
| `claude-prompt` | `{length}`. |
| `claude-turn` | `{stopReason,ms}`. |
| `claude-permission` | `{sessionId, tool, decision}` — i.e. `{tool,decision}` plus the session id. |
| `claude-live` | `{live,evicted}`. |
| `claude-history` | `{count,ms}`. |
| `claude-query-error` | `{message<=200}`. |
| `claude-chat-state-invalid` | zod guard on the pushed chat state failed. |
| `claude-terminal` | `{sessionId,op}`. |
| `claude-agents` | `{count,running,ms,source}`. |
| `claude-agents-parse` | `{count,unknownKeys}`. |
| `claude-agents-error` | `{message}`. |
| `claude-agent-stop` | `{agentId,ok}`. |
| `claude-hooks-listen` | `{port,probed}`. |
| `claude-hook` | `{event,hasSession}`. |
| `claude-hook-rejected` | `{reason:auth\|path\|size\|json}`. |
| `claude-hook-ignored` | `{event}`. |
| `claude-hooks-error` | Listener error. |
| `claude-hooks-install` | `{enabled,changed,ok}`. |
