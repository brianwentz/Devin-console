# Devin Workspaces

A desktop client for [Devin](https://devin.ai) — Windows and macOS (Apple Silicon) — that keeps your Devin sessions, the GitHub pages they produce, and a local terminal in one window.

The Cloud surface is the real Devin web app (your tenant) hosted in a Chromium view, so sessions, folders, worklogs and approvals behave exactly as they do in the browser. Around it the app adds what the web app can't do on its own:

- **GitHub pane** — every GitHub link a session produces (PR cards, worklog links, `_blank` popups, iframes) opens in a tabbed pane docked to the right instead of a separate browser. Tabs are scoped to the session you're viewing, persist across restarts, and can be reordered, closed and resized.
- **Link rules** — your own prefix / regex rules (Settings → Link Handling) make other sites — Jira, GitLab, internal tools — open as pane tabs too.
- **PR auto-open** — when a session creates a pull request, a tab for it appears in that session's pane automatically.
- **PR panel** — the open pull requests across your sessions in one list with GitHub titles and unread markers; one click opens the PR in its session.
- **Notifications** — an in-app notification center (plus a taskbar badge on Windows) when a session is waiting for your input or approval.
- **Analytics** — your tenant's analytics page as its own surface in the rail.
- **Terminal dock** — a tabbed shell (your Windows Terminal default profile or PowerShell on Windows, your login shell on macOS) under the Devin view, with per-workspace working directories.
- **Devin Local** — run the `devin` CLI against local workspace folders from the same window (requires the Devin CLI).
- **Claude sessions** — a sidebar for your local Claude Code sessions (`~/.claude`) with folders, pinning, archive and transcript management (requires the Claude Code CLI).
- **Saved passwords** — logins for SSO/IdP origins, encrypted with the OS credential store (DPAPI on Windows, Keychain on macOS), filled automatically on the sign-in page.
- **Layout memory** — the pane split, terminal height, and window size/position (per display configuration) are remembered without any settings to manage.

## Install

Builds for both platforms are on the [GitHub Releases](../../releases) page. The Devin CLI is only needed for the Local surface and the terminal's `devin` tab.

### Windows (10/11 x64)

Download `DevinWorkspaces-Setup-<version>.exe` and run it. It is a per-user install (no admin rights) and updates itself from subsequent releases.

The installer is currently unsigned, so Windows SmartScreen will warn on first run — choose *More info → Run anyway*.

### macOS (Apple Silicon)

Download `DevinWorkspaces-<version>-arm64.dmg`, open it and drag **Devin Workspaces** into *Applications*.

The Mac build is ad-hoc signed and not notarized, so the first launch is a little odd — macOS refuses to open it until you allow it explicitly:

1. Double-click **Devin Workspaces** in *Applications*. macOS shows *"Devin Workspaces" Not Opened — Apple could not verify "Devin Workspaces" is free of malware…* Click **Done** (not *Move to Trash*).
2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. A line reads *"Devin Workspaces" was blocked to protect your Mac* — click **Open Anyway** next to it and authenticate with your password or Touch ID.
3. Double-click the app again and click **Open Anyway** in the final confirmation dialog.

This is only needed once; subsequent launches open normally. If you'd rather skip the dialogs, clear the quarantine flag from a terminal instead:

```
xattr -d com.apple.quarantine "/Applications/Devin Workspaces.app"
```

If you see *"Devin Workspaces" is damaged and can't be opened* rather than the dialog above, you have a build from before v0.1.4 — download the current release.

Because the build is not notarized, the Mac app does not auto-update: check the Releases page for new versions and install them over the existing app the same way (the first-launch steps above are needed again after each update).

## First run

1. The window opens on the **Cloud** surface (☁ in the left rail) pointing at the default tenant. If you use a different Devin tenant, open **Settings** (⚙) and change *Tenant URL*, then sign in as you normally would — SSO flows run inside the hosted view, nothing is intercepted. Settings fields save on their own when you switch tabs or leave the page.
2. Click any GitHub link in a session; it opens in the pane on the right. Toggle the pane with the **GH** rail button or `Ctrl+Shift+G`, drag the splitter to resize.
3. Toggle the terminal dock with the **>_** rail button or `` Ctrl+` ``; use **+** in the dock to open a shell in a workspace folder or your home directory. On Windows the shell is your Windows Terminal default profile when available (WSL distros included); the **▾** menu lists other launchable profiles. On macOS it is your login shell (`$SHELL`, normally `zsh`).
4. The **Analytics** rail button shows your tenant's *My analytics* page in the main column; the **PR** and bell buttons open the pull-request and notification panels.

## Notifications and PR auto-open

Both features poll the Devin API, so they need an API token:

1. In the Devin web app go to **Settings → API Keys** and create a personal access token, or use a **service-user token** (Organization Settings → Devin API — the only kind many enterprise tenants allow). Legacy v1 keys are not supported. The app only calls `GET /v3/self`, `GET /v3/organizations/{org}/sessions` and `GET /v3/organizations/{org}/sessions/{id}`.
2. In Devin Workspaces open **Settings → Notifications**, paste the token into the token field and click **Save**. The token is encrypted with the OS credential store (DPAPI on Windows, Keychain on macOS) and stored in `secrets.json` in the app's data folder (see [Where things live](#where-things-live)); it is never written to `settings.json`, the log, or shown in the UI again.
3. Leave *Organization ID* blank — it is resolved from `/v3/self`. Only fill it in if the status line reports that no organization could be determined for your token.
4. *API base* stays `https://api.devin.ai` unless your enterprise tenant uses a different API host. Note the Devin CLI may report `Devin API: https://api.devinenterprise.com` for your tenant — that is the CLI's endpoint, not the app's; `api.devin.ai` answers service-user tokens correctly either way.

Once a token is set the poller runs continuously (10 s while a session is active, 60 s when idle). Three things hang off it:

- **Notification center** — the bell in the rail. New events (a session waiting for your reply, needing approval or blocked; a PR opened or merged/closed; a downloaded app update) land in the panel with unread highlighting, a taskbar overlay count (Windows) and an optional title-bar banner. Clicking an entry opens its session (or the PR tab, or installs the update). *Collect notifications*, *Show banner* and the per-kind toggles live in Settings → Notifications; "Session finished" is off by default. History persists across restarts (last 50).
- **Open a tab when a session creates a PR** — a background tab for the PR opens in that session's pane within one poll interval. PRs that already existed when the token was saved are not opened, and closing an auto-opened tab does not bring it back.
- **PR panel** — the `PR` rail button lists open pull requests across your sessions with their GitHub titles. New PRs show as unread (the badge counts them); clicking one switches to that session and opens the PR in its pane. Mark-as-read, delete and *Clear all* work like the notification panel — a deleted PR stays hidden while it is open.

If the token is rejected (401/403) or your user can't be determined, the bell shows an amber dot and a notification points you to Settings; the poller retries and polls immediately when the window regains focus. PRs created while the app was closed or the poller was down are still opened (last 24 h, at most 10) once it recovers.

The poller only lists sessions created by the token's user (`GET /v3/self` → `user_ids` filter). With a **personal access token** the user id comes straight from `/v3/self`. A **service-user token** has no user id, so the app determines yours automatically: first from the Devin CLI sign-in (`devin auth login` / `devin auth status` — the same `devin` binary used by Devin Local), then by inferring it from the sessions you open in the app. If neither works, set the **User ID override** in Settings → Notifications; the resolved identity is shown there (masked, e.g. `user-…705c6`) and can be cleared with the **Reset** button. The first poll after a resolution confirms the id against the sessions list and falls back to the next strategy if it doesn't match.

## Devin Local

1. Install the Devin CLI and make sure `devin` is on your `PATH`. If it isn't, the Local surface shows install guidance; you can also point at a specific binary with `"local": { "devinPath": "C:\\path\\to\\devin.exe" }` (or `"/path/to/devin"` on macOS) in `settings.json`.
2. Switch to the **Local** surface (⌘ in the rail), click **+ Add** and pick a workspace folder.
3. Start a session; prompts, tool calls, plans and permission requests appear in the chat panel, with a thinking indicator and elapsed time while a turn runs and the turn's token usage once it finishes. Each session has its own **Terminal** tab, which resumes that session in the interactive CLI (`devin -r <session>`), and its own set of GitHub tabs in the pane. While a session is open in its terminal it belongs to the CLI — it shows a `>_` marker in the list and chat for it is disabled until you close the terminal, after which the chat panel reloads with the turns you made there. Opening a terminal restarts the workspace's agent, so it is refused while any session in that workspace is still running — finish or cancel it first. PR links the CLI prints open as background tabs just like Cloud sessions (same *Open a tab when a session creates a PR* toggle). Type `/handoff` in a local session to move it to Devin Cloud.
4. Hover a session in the list to delete it (running sessions must be cancelled first); the trash icon next to **Sessions** deletes every session in the workspace after a confirmation.

## Claude sessions

The **Claude** surface (sparkle icon in the rail) lists the Claude Code sessions on this machine, read from `~/.claude` through the Claude Agent SDK — the same list `claude -r` shows, including titles, working directories and branches. It needs the Claude Code CLI installed (`claude` on `PATH`); if it isn't found an informational banner shows and you can set **Claude Code path** in Settings → General.

- **Folders, pin, archive** — sessions can be pinned, moved into named folders (created via the `+` header button, a folder's menu, or a session's *Move to folder* submenu) and archived. The order of folders, collapsed state and the *Show archived sessions* toggle are kept between launches.
- **Remove from list vs Delete transcript** — *Remove from list* hides a session until the transcript changes again (if a session is resumed elsewhere it reappears). *Delete transcript…* removes the `.jsonl` file from disk permanently after a confirmation.
- **Auto-archive** — *Auto-archive Claude sessions idle for N days (0 = off)* in Settings → General archives sessions whose transcript hasn't changed in that many days. Unarchiving manually marks a session so it isn't auto-archived again.
- **Rename / Fork** — a session's menu renames its title (writes a custom title into the transcript) or forks it into a new resumable session that inherits folder/pin.
- **Where it lives** — folder, pin, archive and removed state is stored per-app in `claude-sessions.json` inside the app's data folder (see [Where things live](#where-things-live)); transcripts stay in `~/.claude` untouched unless you delete one. Setting `CLAUDE_CONFIG_DIR` before launch points the app at a different Claude home (used by the test suite).

**Chat.** Selecting a session loads its transcript history into the chat view; type in the composer (Enter sends, Shift+Enter newline) and the session answers through the bundled Claude Agent SDK — text, thinking and tool calls stream in live, with a turn summary and token usage after each turn. Start a new session with the sidebar `+`, the *New session* button on the empty view, or Ctrl+N on the Claude surface — a folder picker asks for the session's working directory.

- **Permissions** — when Claude asks to run a tool, a card in the chat offers *Allow* / *Always allow* (when the CLI suggests a rule) / *Reject*. The header's permission-mode select (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`) and model field apply live to the running session; *Default permission mode* and *Model* in Settings → General are the starting values. Under `auto` the card may never appear — the header always shows the active mode.
- **Live limits** — a session keeps its agent process open for *keep-alive* minutes after the last turn (default 15); at most *max live agents* (default 3) run at once, oldest idle first. Both live in Settings → General.
- **Version warning** — a badge in the header appears when `claude --version` differs from the CLI version the bundled SDK targets.
- PR URLs printed in a Claude session open as lazy background tabs in its GitHub scope, like Cloud and Local sessions (same *Open a tab when a session creates a PR* toggle).

**Terminal tab.** The view header's *Terminal* tab opens `claude -r <id>` (or `claude attach <agent>`) in the session's working directory — a real interactive Claude Code session, not a transcript. Only one writer at a time: opening the terminal closes the chat's SDK query, disables the composer with a banner (*close the terminal to chat here*), and closing the pty re-syncs the transcript so terminal turns appear in chat. Opening the terminal while a prompt is running is refused — cancel first.

**Background agents.** `claude --bg` agents are polled (`claude agents --json --all`, faster while the window is focused). An agent tied to a listed session puts a running badge on its row; others appear in a *Background agents* section at the top of the sidebar with *Attach* (opens its terminal in the dock) and *Stop* on their menu.

**Activity, hooks and notifications.** A dot on each session row shows live activity — blue while a prompt runs, amber while Claude waits for permission — fed by the chat itself and, for sessions running in terminals, by Claude Code's hook system: the app runs a loopback listener (`127.0.0.1`, bearer-token auth, random per-profile port) that our embedded terminals and a global settings block POST to. Chat sessions report the same states to the notification center too (*waiting for permission*, *finished a turn*, errors — the same Settings → Notifications toggles apply), and `gh pr create` output from any Claude session raises a *pr-opened* entry and auto-opens the PR tab like everywhere else. The *Report Claude Code sessions started from other terminals* toggle in Settings → Notifications writes the hook block into `~/.claude/settings.json` (backup kept once as `settings.json.devin-workspaces.bak`, foreign hooks and keys preserved, block removed on off) so external terminals report activity too; its status line shows whether the block is installed and which port the listener is on.

**Pull requests.** PR links that show up in a Claude session — in its chat output, in its terminal, or in a `gh pr` command reported by hooks — are recorded per session (in `claude-sessions.json`) and listed in the PR panel (rail button) alongside Devin PRs; a sparkle glyph marks the Claude rows. Opening one selects the session on the Claude surface and opens the PR in that session's tab scope. Each PR's state (open, draft, merged, closed) is read from its GitHub page using the app's GitHub sign-in and refreshed about every 10 minutes while the app is focused; a PR that merges or closes leaves the panel and raises a *pr-completed* notification once. Session rows in the sidebar show the same PR badges as Cloud sessions.

**Known limitations.**

- Subagent transcripts are not shown yet.
- *Fork* is available from the sidebar menu only.
- Consecutive assistant messages within one turn render as one message.
- Under permission mode `auto` Claude rarely prompts, so permission notifications for terminal/external sessions are best-effort.
- PR state is only available for PRs the signed-in GitHub session can load.
- One writer at a time — the chat composer is disabled while that session's Terminal tab is open.

## Settings reference

Settings is split into five tabs: **General**, **Link Handling**, **Passwords**, **Notifications** and **Updates**. Fields save automatically when you switch tabs, leave Settings or quit; invalid values are flagged inline and block the save. The API token Save/Clear and password Add/Edit buttons are explicit actions.

| Setting | Tab | Notes |
|---|---|---|
| Tenant URL / API base | General | Must be `https` |
| Workspaces | General | Folders for Devin Local and terminal working directories |
| Keep hidden tabs live for (hours) / Max live tabs | General | Memory controls for GitHub tabs of sessions you're not viewing — the session you're viewing keeps its tabs loaded; hidden sessions' tabs are discarded after the keep-alive window and the live cap only ever applies to them |
| Cloud sessions kept loaded / Keep hidden Cloud sessions live for (hours) | General | The same two controls for the Cloud session views opened from the sessions column (1–20 live views, default 6; 0–168 h, default 24, 0 = discard on switch) |
| Show the sessions column (Cloud and Claude) | General | Same as `Ctrl+Shift+S` on the Cloud surface |
| Show terminal dock on Local and Settings too | General | Dock is Cloud-only by default |
| Claude Code path | General | Blank = find `claude` on PATH; a non-empty path that doesn't resolve is flagged inline |
| Auto-archive Claude sessions idle for (days) | General | 0 = off; unarchiving manually suppresses it per session |
| Default permission mode | General | Starting mode for new Claude chat sessions (switchable per session in the header) |
| Model | General | Claude chat model override; blank = the CLI's default |
| Claude keep-alive / max live agents | *(settings.json only)* | `claude.keepAliveMinutes` (1–240, default 15) — how long an idle Claude agent stays warm — and `claude.maxLiveAgents` (1–10, default 3) — how many run at once. No control in Settings yet; edit the file while the app is closed |
| Shell command | General | Blank = Windows Terminal default profile (else PowerShell) on Windows, `$SHELL` on macOS; e.g. `wsl.exe -d Ubuntu` or `/bin/zsh -l` |
| Open non-GitHub links in system browser | Link Handling | GitHub, tenant and rule-matched links always stay in the pane |
| Link rules | Link Handling | Up to 100 prefix or regular-expression rules; matching http(s) links open as pane tabs instead of the system browser (GitHub and your tenant are matched first). *Test a URL* shows where a link would go |
| Passwords | Passwords | Origin + username + password, encrypted with DPAPI (Windows) / Keychain (macOS); autofill fills a single match on load, offers an account picker when several match, and asks to save/update after a sign-in; rows support show/copy/edit/delete |
| Collect notifications / Show banner / Notify me for / Open a tab when a session creates a PR | Notifications | See above |
| Devin API token / Organization ID / User ID override | Notifications | Token Save/Clear are explicit; both overrides are optional — see above for when they are needed |
| Report Claude Code sessions started from other terminals | Notifications | Writes an http hook block into `~/.claude/settings.json` (one-time `.devin-workspaces.bak` backup; block removed on off) so external Claude sessions also report activity; off = only app-spawned terminals/chat report |
| Version, update status, release notes | Updates | Shows the installed version, whether an update is downloading or ready (**Update now** installs it), and the release notes for the current and the available version |

Pane width, terminal height, window placement and the open tab list are saved automatically.

## Keyboard shortcuts

On macOS, `Cmd` works everywhere `Ctrl` is listed (`Ctrl` works too).

| Keys | Action |
|---|---|
| `Ctrl+Shift+G` | Toggle GitHub pane |
| `Ctrl+Shift+[` / `]` | Shrink / grow the pane |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous GitHub tab |
| `Ctrl+W` | Close the active GitHub tab |
| `Alt+←` / `Alt+→`, `Ctrl+R` / `F5` | Back / forward / reload in the focused view |
| `Ctrl+N` | New Devin session |
| `` Ctrl+` `` | Toggle terminal dock |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom the focused view |

GitHub tabs can be dragged to reorder; right-click a tab for *Copy address*, or the strip for *Reload all tabs in this session*.

In the terminal: `Ctrl+C` copies when text is selected (otherwise it is sent to the shell), `Ctrl+Shift+C` copies, `Ctrl+V` / `Ctrl+Shift+V` paste; right-click copies the selection or pastes when nothing is selected. On macOS use `Cmd+C` / `Cmd+V` — plain `Ctrl+C` / `Ctrl+V` keep their terminal meaning.

## Where things live

`%APPDATA%\devin-workspaces\` on Windows, `~/Library/Application Support/devin-workspaces/` on macOS — `settings.json` (plain settings and layout), `secrets.json` (API token, encrypted), `credentials.json` (saved logins, encrypted), `notifications.json` (notification history), `prs.json` (PR panel read/dismissed state), `pr-ledger.json` (PRs already seen, for catch-up after an outage), `identity.json` (resolved user id for service-user tokens), `local-sessions.json` (Devin Local session index), `claude-sessions.json` (Claude sidebar folder/pin/archive state — created on the first mutation), `claude-hooks.json` (hook listener port + bearer token, mode 0600), `events.jsonl` (the event log), and the two browser profiles (`persist:devin`, `persist:github`). Uninstalling removes the app; delete this folder to remove all data.

Claude session transcripts stay where Claude Code keeps them (`~/.claude/projects/`); the app only renames or deletes one when you ask it to from the sidebar. The one Claude config file it edits is `~/.claude/settings.json`, and only when *Report Claude Code sessions started from other terminals* is on: the original is copied once to `~/.claude/settings.json.devin-workspaces.bak` before the hook block is added, and the block is removed again when the toggle is turned off.

The event log records URLs, ids and sizes only — never page content, terminal output, or secrets. It is the first place to look if notifications or PR tabs don't appear (`poll`, `poll-error`, `notification-added`, `notification-open`, `pr-auto-open` events).

## Development

```
npm ci
npm run typecheck      # tsc
npm run lint           # eslint (typescript-eslint + react-hooks, recommended sets)
npm run test:unit      # vitest (pure core logic)
npm run test:e2e       # build + Playwright against local fixture servers
npm start              # build + run
npm run dist:win       # NSIS installer -> dist/
npm run dist:mac       # arm64 dmg + zip (ad-hoc signed) -> dist/, macOS only
npm run smoke:install  # install, smoke-test, upgrade, uninstall the built installer
```

Node ≥ 22.12 is required. See `AGENTS.md` for architecture notes, environment variables and project conventions.
