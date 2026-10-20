# Rename: Devin Workspaces → Agent Workspace

Status: Implemented — PR pending

## 0. The ask

The product has outgrown its name: it hosts Devin Cloud, Devin Local, Claude Code (local + WSL), GitHub, terminals and analytics. Rename it to **Agent Workspace** everywhere except references to the Devin *product* (CLI, tenant, API, ACU usage). After the rename ships, the word "devin" must not appear in the app's own identity or in anything persistent it creates: install directory, executable/uninstaller names, shortcuts, registry keys it owns, userData folder, file names, backup files it writes into `~/.claude`, hook URLs it registers, updater cache, env-var names, test hooks. Existing installs must auto-update into the renamed app and keep their settings, secrets, logins and history. The GitHub repo rename is done by hand (not in scope here); everything else is.

## 1. Current identity surface (verified on this machine, 2026-10-20)

| Surface | Today | Owner |
|---|---|---|
| `package.json name` → Electron `app.name` → userData folder, updater cache name | `devin-workspaces` → `%APPDATA%\devin-workspaces`, `%LOCALAPPDATA%\devin-workspaces-updater` (both exist here) | package.json |
| `build.productName` → exe, install dir, uninstaller, shortcuts, `.app` bundle, mac keychain item | `Devin Workspaces` → `%LOCALAPPDATA%\Programs\Devin Workspaces\Devin Workspaces.exe`, `Uninstall Devin Workspaces.exe`, `Devin Workspaces.lnk` (Start Menu + Desktop), `Devin Workspaces.app` | package.json |
| `build.appId` → NSIS GUID (uuid5 of appId) → `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>` + `HKCU\Software\<GUID>\InstallLocation`; also the AppUserModelId | `ai.devin.workspaces` → GUID `1f69b7bc-532a-5b53-bb75-cfe47a155a29` (registry confirmed, DisplayName `Devin Workspaces 1.2.0`); `app.setAppUserModelId('ai.devin.workspaces')` in `src/main/index.ts:62` | package.json, index.ts |
| Smoke identity | appId `ai.devin.workspaces.smoke` → GUID `8bc73818-13fb-5883-bfb3-62006ae4a564`, `Devin Workspaces Smoke`, `DevinWorkspaces-Smoke-Setup-*.exe`, `Programs\devin-workspaces-smoke`, `%TEMP%\devin-workspaces-smoke-profile` | package.json `dist:win:smoke`, `scripts/smoke-install.ps1` |
| Artifact names | `DevinWorkspaces-Setup-${version}.exe`, `DevinWorkspaces-${version}-arm64.{dmg,zip}` | package.json `nsis.artifactName`, `mac.artifactName`, `release.yml` Check/Upload steps, `windows.yml`, smoke script globs |
| Update feed | `build.publish` + `RELEASE_REPO` in `src/main/releases.ts` = `brianwentz/devin-workspace`; baked into `resources/app-update.yml` of every shipped build | package.json, releases.ts |
| Persistent files the app writes outside userData | `~/.claude/settings.json.devin-workspaces.bak` (`src/main/claude/hooksInstall.ts:19`); hook URLs `http://<addr>:<port>/devin-workspaces/hook/<event>` inside `~/.claude/settings.json` (`src/core/claudeHooks.ts HOOK_PATH_PREFIX`, matched by `isOurHook`) | hooksInstall.ts, claudeHooks.ts, hookServer.ts, hosts.ts:540 |
| Chromium partition on disk | `persist:devin` → `userData\Partitions\devin` (`index.ts:334`, `analytics.ts:15`, `cloudViews.ts:82`, `cookieAudit.ts:24`) | main |
| Runtime names (not on disk) | env vars `DEVIN_WORKSPACES_*` (≈390 refs in src/tests/scripts/.github), `window.devinworkspaces` preload API + `DevinWorkspacesApi` type, `__devinworkspaces` test hooks, ACP `clientInfo.name` (`acpHost.ts:474`, `cloudAcp.ts:84`), release-notes `user-agent`, notification `sessionTitle: 'Devin Workspaces'` (updater/notifier/testHooks), dialog title (`index.ts:347`), `index.html <title>`, `TitleBar.tsx`, `localModel.ts:149` install message, `claude/host.ts` deny message | everywhere |
| Docs | `README.md`, `AGENTS.md`, `scripts/smoke-install.ps1` header, `tools/lint/package.json` name, workflow artifact names | docs |
| Not ours — leave alone | `%LOCALAPPDATA%\Programs\Devin` (the Devin CLI), `secrets.json` key `devinPat`, settings keys `local.devinPath`, `analytics.tab 'devin'`, `usage.devinPollMinutes`, `DEVIN_CLI`, tenant/API defaults, `persist:github` | — |

Settings themselves need **no schema migration**: nothing in `settings.json` names the app. Migration is a *location* move (userData folder) plus the two `~/.claude` artifacts above.

## 2. New identity (proposed — confirm in §7)

| Field | Value |
|---|---|
| `name` | `agent-workspace` → `%APPDATA%\agent-workspace`, `~/Library/Application Support/agent-workspace`, `%LOCALAPPDATA%\agent-workspace-updater` |
| `productName` | `Agent Workspace` → `Programs\Agent Workspace\Agent Workspace.exe`, `Agent Workspace.app`, `Agent Workspace.lnk` |
| `appId` / AppUserModelId | `io.github.brianwentz.agent-workspace` (reverse-DNS of the GitHub home; no domain needed) |
| `nsis.guid` | **pinned to `1f69b7bc-532a-5b53-bb75-cfe47a155a29`** — the old product's GUID — so NSIS treats the new installer as an upgrade of the existing install (uninstalls the old version, replaces the uninstall entry) instead of installing a second product. The GUID contains no name; it is the one deliberate carry-over. Smoke builds pin `8bc73818-13fb-5883-bfb3-62006ae4a564` the same way. |
| Artifacts | `AgentWorkspace-Setup-${version}.exe`, `AgentWorkspace-${version}-arm64.{dmg,zip}` |
| Repo | `brianwentz/agent-workspace` (`build.publish`, `RELEASE_REPO`, git remote) |
| Hook path | `/agent-workspace/hook/` |
| `~/.claude` backup | `settings.json.agent-workspace.bak` |
| Partition | `persist:cloud` (dir `Partitions\cloud`) — see §7 Q2 |
| Env prefix | `AGENT_WORKSPACE_` (e.g. `AGENT_WORKSPACE_TEST=1`, `AGENT_WORKSPACE_USER_DATA`) |
| Preload / hooks | `window.agentworkspace`, `AgentWorkspaceApi`, `__agentworkspace` |
| Version | **2.0.0** — the rename is the breaking line; tag must exceed main's 1.2.0 |

## 3. How the upgrade path works

### 3.1 Windows, existing 1.x install auto-updating

1. The 1.x client's baked `app-update.yml` points at `github.com/brianwentz/devin-workspace`. After the repo rename GitHub serves 301s for the old name (`releases.atom`, `releases/download/...`); electron-updater's HttpExecutor follows redirects, so old clients find `v2.0.0/latest.yml` and download `AgentWorkspace-Setup-2.0.0.exe`. (Never create a new repo named `devin-workspace` — that breaks the redirect for every un-updated client.)
2. electron-updater runs the installer with `/S --updated`. Because `nsis.guid` is unchanged, electron-builder's `uninstallOldVersion` finds `HKCU\Software\<GUID>\InstallLocation` = `...\Programs\Devin Workspaces`, runs the old uninstaller silently (shortcuts, files, registry entry; appdata untouched — `deleteAppDataOnUninstall: false`).
3. **Install dir redirect** — `initMultiUser` also seeds `$INSTDIR` from that same registry value, which would put 2.0.0 back under `Programs\Devin Workspaces`. New `build/installer.nsh` (`nsis.include`) with `!macro customInit`: if `$INSTDIR` ends with `\Devin Workspaces` (or the smoke equivalent) → `StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Agent Workspace"`. A user who chose a custom folder keeps it (only the default-named folder is redirected). *Verify* in the smoke run that `customInit` runs after `initMultiUser` (electron-builder `installer.nsi` ordering) — if it runs before, move the override to `customInstallMode` or patch `$INSTDIR` in `customInstall`'s predecessor; the smoke in §5 is the gate.
4. Shortcuts: electron-builder records `ShortcutName` in the registry and, on update, renames/recreates the Start Menu and Desktop links when the name changed. *Verify* no stale `Devin Workspaces.lnk` remains (smoke assertion). A taskbar pin made by the user points at the deleted exe and will go dead — document it in the release notes (one line).
5. The installer launches `Agent Workspace.exe`. First-run **profile migration** (new `src/main/migrate.ts`, imported *before* `log.ts` — `log.ts` resolves `userData` and `mkdirSync`s it at import time, which would create the new empty folder and defeat the "destination exists" check):
   - Runs only when `AGENT_WORKSPACE_USER_DATA` is unset (explicit profiles — tests, smoke — are never migrated), the old folder `<dirname(userData)>/devin-workspaces` exists and the new one does not.
   - `renameSync(old, new)` (atomic, same volume). Chromium state (`Local State`, `Partitions/*`, cookies, `.updaterId`) moves intact, so Windows `safeStorage` (DPAPI key in `Local State`) keeps decrypting `secrets.json` and `credentials.json`.
   - Then rename `Partitions/devin` → `Partitions/cloud` (if Q2 approved), best-effort `rmSync` of `%LOCALAPPDATA%\devin-workspaces-updater` (the running installer may still hold it on the very first launch — idempotent, retried next start), and log one `profile-migrated { from, to, partitions, updaterCache }` event into the *new* `events.jsonl`.
   - If the rename fails (EXDEV, EPERM, EBUSY) fall back to recursive copy + verify + remove old; if that fails too, continue with a fresh profile and raise a notification pointing at the old folder — never crash startup.
6. `~/.claude` migration (inside `ClaudeSessions` start, both local and each WSL host's configDir): rename `settings.json.devin-workspaces.bak` → `settings.json.agent-workspace.bak` if present and the new name is free; `isOurHook` recognises **both** `/devin-workspaces/hook/` and `/agent-workspace/hook/` so the existing global block is stripped and re-written with the new URLs when the toggle is on (it is re-applied at startup today — confirm; if not, apply once when the migration ran). `hookServer.ts` and the `hosts.ts` health probe accept both prefixes for the 2.x line so Claude terminals that were started before the upgrade keep reporting; drop the old prefix in a later release.

### 3.2 Windows, fresh install → nothing special; the smoke `fresh` phase covers it.

### 3.3 macOS

- Auto-update is disabled (unsigned), so users install `AgentWorkspace-2.0.0-arm64.dmg` by hand. README: drag in, then delete `Devin Workspaces.app` (the quarantine dance applies again).
- Profile migration as in 3.1 step 5 (`~/Library/Application Support/devin-workspaces` → `agent-workspace`).
- **Keychain caveat.** macOS `safeStorage` keys the encryption key in Keychain by app name (`<name> Safe Storage`). After the rename the old key is not found, so `secrets.json` (API token) and `credentials.json` (saved logins) cannot be decrypted. Behaviour today: `SecretStore.load` logs `secrets-decrypt-failed` and continues; `CredentialStore.reveal` returns null. Plan: on darwin, when migration ran and a decrypt fails, delete the undecryptable file(s), log `profile-migrated-secrets-reset`, and raise one notification ("Re-enter your Devin API token / saved passwords after the rename"). No way to carry the key over without the old app's cooperation; Q3 asks whether that trade-off is acceptable (the Mac build is the author's own machine today).

### 3.4 Smoke identity

`dist:win:smoke` passes `-c.appId=io.github.brianwentz.agent-workspace.smoke -c.productName="Agent Workspace Smoke" -c.nsis.guid=8bc73818-13fb-5883-bfb3-62006ae4a564 -c.nsis.shortcutName=... -c.nsis.artifactName="AgentWorkspace-Smoke-Setup-${version}.${ext}"`. Pinning the old smoke GUID lets the cross-rename smoke (§5) install a *pre-rename* smoke build first and upgrade it.

## 4. Work breakdown

Single branch `rename/agent-workspace`, one PR; the sequencing matters because the smoke in §5 needs a pre-rename artifact built first.

### W0 — capture the "before" artifact (before any rename edit)
- `npm run dist:win:smoke` on `main` → copy `dist/smoke/DevinWorkspaces-Smoke-Setup-1.*.exe` to `dist/smoke-before/` (git-ignored). This is the installed-old-version input for §5.

### W1 — identity + packaging
- `package.json`: `name`, `description`, `productName`, `appId`, `nsis.guid`, `nsis.shortcutName`, `nsis.artifactName`, `mac.artifactName`, `publish.repo`, `dist:win:smoke` flags (incl. smoke guid), `nsis.include: "build/installer.nsh"`.
- `build/installer.nsh`: `customInit` install-dir redirect (3.1 step 3), parameterised by `${PRODUCT_NAME}` so the smoke flavour redirects `devin-workspaces-smoke`/`Devin Workspaces Smoke` → `Agent Workspace Smoke` too.
- `tools/lint/package.json` name; `scripts/after-pack.cjs` untouched (uses `productFilename`).
- `src/main/index.ts`: `setAppUserModelId`, dialog title; `src/main/releases.ts RELEASE_REPO`, user-agent; `acpHost.ts`/`cloudAcp.ts clientInfo.name`.
- Icons (`build/icon.ico|png`, `scripts/make-icon.mjs`): keep unless they carry the Devin wordmark — check once; out of scope otherwise.

### W2 — migration code
- New `src/core/migrateProfile.ts` (pure: given `{ oldDir, newDir, explicitUserData, partitions }` → list of fs ops / decisions; unit-tested) + `src/main/migrate.ts` (performs them; imported first in `index.ts`, before `log.ts`).
- `claudeHooks.ts`: `HOOK_PATH_PREFIX = '/agent-workspace/hook/'`, `LEGACY_HOOK_PATH_PREFIXES = ['/devin-workspaces/hook/']`, `isOurHook` matches either; `hookServer.ts` route + `hosts.ts` health URL accept both; `hooksInstall.ts` backup rename + new backup name.
- `secrets.ts` / `credentials.ts`: darwin decrypt-failure reset + notification (3.3) — gated on "migration ran this launch" so an ordinary Keychain hiccup never wipes anything.
- Partition rename (Q2): the four `persist:devin` sites → `persist:cloud` + the `Partitions/devin → cloud` step in migrate.

### W3 — mechanical rename (sed-style, reviewed)
- `DEVIN_WORKSPACES_` → `AGENT_WORKSPACE_` across `src/`, `tests/`, `scripts/`, `.github/`, `AGENTS.md`, `README.md`, `playwright*.ts`, `scripts/smoke-install.ps1`.
- `__devinworkspaces` → `__agentworkspace`; `window.devinworkspaces` → `window.agentworkspace`; `DevinWorkspacesApi` → `AgentWorkspaceApi`.
- User-visible strings: `'Devin Workspaces'` → `'Agent Workspace'` (notification `sessionTitle`, TitleBar, `index.html`, `localModel.ts`, `claude/host.ts`, Settings copy). Review each hit — "Devin Local", "Devin Cloud", "Devin API token", "Devin CLI" stay.
- `smoke-install.ps1`: product names, globs, default `-InstallDir`/`-ProfileDir` (`Programs\agent-workspace-smoke`, `%TEMP%\agent-workspace-smoke-profile`), env names, header comment.
- `tests/smoke/installed.spec.ts`: exe/product names, env names.
- Workflows: `release.yml` Check/Upload globs and `codesign` path (`Agent Workspace.app`), artifact names; `windows.yml` likewise.

### W4 — smoke + tests (see §5)

### W5 — docs
- `README.md` rewrite (concise; §6 has the ≤500-char feature paragraph). Sections: title + feature paragraph · Install (Windows/macOS incl. "Upgrading from Devin Workspaces": auto on Windows, manual on Mac + delete old app + re-enter token/passwords) · First run (short) · Where things live (new paths) · Development (commands) · pointer to `AGENTS.md`. Drop the long per-feature walkthroughs — they move to `docs/` or stay in `AGENTS.md`.
- `AGENTS.md`: every path/env/artifact reference; add the migration + legacy-hook-prefix notes to Conventions; the env table gets the new prefix.
- `plans/README.md`: add this file's row. Existing plan files stay as written (repo rule).
- Release notes for v2.0.0: rename, what migrates automatically, taskbar-pin caveat, Mac re-entry caveat.

### W6 — release choreography (after the PR is green and merged)
1. You rename the GitHub repo → `agent-workspace`; `git remote set-url origin git@github.com:brianwentz/agent-workspace.git`; optionally rename the local folder `C:\Users\brian\source\repos\devin-workspace` → `agent-workspace` (nothing in the build depends on it).
2. `curl -sI https://github.com/brianwentz/devin-workspace/releases.atom | head -1` → expect `301`. This is what keeps 1.x clients updating.
3. Publish release **v2.0.0** from the GitHub UI (not pre-release). `release.yml` builds/uploads `AgentWorkspace-*` + `latest.yml`/`latest-mac.yml`.
4. Real-world check on this machine (1.2.0 installed): wait for the 30 s startup check or trigger Settings → Updates → it downloads 2.0.0 → "Update now" → verify §5 "after" assertions by hand (dir, registry, shortcuts, `%APPDATA%\agent-workspace`, token still works, Cloud still signed in, `events.jsonl` has `profile-migrated`).

## 5. Verification (gates)

- `npm run typecheck` · `npm run lint` · `npm run test:unit` (new `migrateProfile` + `claudeHooks` legacy-prefix cases) · `npm run build`.
- **e2e**: new `tests/e2e/migration.spec.ts` using a test-only `AGENT_WORKSPACE_TEST_MIGRATE_FROM=<dir>` (test mode; stands in for `<dirname(userData)>/devin-workspaces`, since e2e always sets an explicit userData): stage an old-shaped profile (settings.json with a non-default value, `Partitions/devin/`, a `settings.json.devin-workspaces.bak` under the fixture `CLAUDE_CONFIG_DIR`, a settings.json hook block with old URLs), launch, assert: settings value visible in the app, `Partitions/cloud` exists / `devin` gone, backup renamed, hook block rewritten to new URLs, `profile-migrated` logged, second launch logs nothing. Existing `claudeHooks.spec` gains "old-prefix POST is accepted". Full suite once at the end (`npm run test:e2e`).
- **Cross-rename installer smoke** — extend `scripts/smoke-install.ps1` with `-From <old-smoke-installer>` (used by a new `npm run smoke:install:rename`): install `dist/smoke-before/DevinWorkspaces-Smoke-Setup-*.exe` into the *old* default dir, run the old smoke spec phase, then run the new `AgentWorkspace-Smoke-Setup-*.exe` with `/S --updated` (no `/D=`, exactly as electron-updater does) and assert: new exe at `Programs\Agent Workspace Smoke`, old dir gone, registry key `8bc73818-…` DisplayName `Agent Workspace Smoke 2.0.0`, `InstallLocation` = new dir, no `*Devin*` `.lnk` in Start Menu/Desktop, `Agent Workspace Smoke.lnk` present, then the `upgrade` smoke phase, then uninstall → clean. This is the only test that proves steps 2–4 of §3.1; it must be green before the release.
- Regular `npm run smoke:install` (fresh/upgrade with the new identity) and the 180 MB budget unchanged.
- Repo-wide grep gate after W3: `rg -i 'devin.?workspaces?|devinworkspaces|ai\.devin' --glob '!plans/**' --glob '!docs/**' --glob '!CHANGELOG*'` must return only the legacy-prefix constants and the migration source-folder names (which are intentional). CI gets this as a step so the old name cannot creep back.
- Final: the W6 step 4 real upgrade on this machine.

## 6. README feature paragraph (≤ 500 characters)

> Agent Workspace is a desktop client for Windows and macOS (Apple Silicon) that puts your coding agents in one window: Devin Cloud sessions from your tenant, Devin Local and Claude Code sessions on local or WSL folders, a tabbed GitHub pane that catches every link and PR a session produces, a terminal dock, PR and notification panels, usage analytics with limit alerts, and saved SSO logins — with layout and sessions remembered across restarts.

(446 characters; the W5 PR asserts the count with a one-line script in review, not CI.)

## 7. Decisions needed before W1

- **Q1 — appId**: `io.github.brianwentz.agent-workspace` as proposed, or something else (it becomes the AppUserModelId and the mac bundle id; changing it later is another migration).
- **Q2 — partition `persist:devin` → `persist:cloud`**: recommended yes (one `renameSync` inside the already-moved profile; the name is about the Cloud surface, not the product). Saying no leaves `Partitions\devin` on disk forever.
- **Q3 — macOS secrets**: accept that the Mac rename forces re-entering the API token and saved passwords (reset + notification), given the unsigned Mac build is not auto-updated anyway. The alternative (ship a last 1.x "bridge" release that re-encrypts for the new name) is not possible — the old app cannot write to a keychain item the new app will own.
- **Q4 — env-var prefix rename** (`DEVIN_WORKSPACES_*` → `AGENT_WORKSPACE_*`, ~390 sites): recommended yes for consistency; it is mechanical and covered by the full e2e run. If you'd rather not touch the test surface in the same PR, it can be a follow-up — but then "devin" stays in `AGENTS.md`'s env table and every spec.
- **Q5 — version 2.0.0** for the rename release (vs 1.3.0).
- **Q6 — README scope**: the plan collapses the walkthrough sections into a short README; confirm you don't want them preserved elsewhere (e.g. `docs/guide.md`, git-ignored today — would need un-ignoring a subpath).
