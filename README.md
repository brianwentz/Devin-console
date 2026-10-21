# Agent Workspace

Agent Workspace is a desktop client for Windows and macOS (Apple Silicon) that puts your coding agents in one window: Devin Cloud sessions from your tenant, Devin Local and Claude Code sessions on local or WSL folders, a tabbed Linked Context pane that catches every link and PR a session produces, a terminal dock, PR and notification panels, usage analytics with limit alerts, and saved SSO logins — with layout and sessions remembered across restarts.

## Install

Builds for both platforms are on the [GitHub Releases](../../releases) page.

### Windows (10/11 x64)

Download `AgentWorkspace-Setup-<version>.exe` and run it. It is a per-user install (no admin rights) and updates itself from subsequent releases. The installer is unsigned, so Windows SmartScreen will warn on first run — choose *More info → Run anyway*.

### macOS (Apple Silicon)

Download `AgentWorkspace-<version>-arm64.dmg`, open it and drag **Agent Workspace** into *Applications*.

The Mac build is ad-hoc signed and not notarized, so the first launch takes an extra step — macOS refuses to open it until you allow it explicitly:

1. Double-click **Agent Workspace** in *Applications*. macOS shows *"Agent Workspace" Not Opened — Apple could not verify "Agent Workspace" is free of malware…* Click **Done** (not *Move to Trash*).
2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. A line reads *"Agent Workspace" was blocked to protect your Mac* — click **Open Anyway** next to it and authenticate with your password or Touch ID.
3. Double-click the app again and click **Open Anyway** in the final confirmation dialog.

This is only needed once; subsequent launches open normally. If you'd rather skip the dialogs, clear the quarantine flag from a terminal instead:

```
xattr -d com.apple.quarantine "/Applications/Agent Workspace.app"
```

Because the build is not notarized, the Mac app does not auto-update: check the Releases page for new versions and install them over the existing app the same way (the first-launch steps above are needed again after each update).

## Upgrading from Devin Workspaces

**Windows:** nothing to do — a 1.x *Devin Workspaces* install auto-updates to the renamed app. The install folder becomes `%LOCALAPPDATA%\Programs\Agent Workspace` and your settings, logins and history move to `%APPDATA%\agent-workspace` on first launch. A taskbar pin made before the upgrade points at the old exe — unpin and re-pin from the Start Menu.

**macOS:** install the new dmg as above, then delete `Devin Workspaces.app`. The profile moves automatically, but the Devin API token and saved passwords must be re-entered — the Keychain encryption key is per app name and can't be carried over. A notification on first launch reminds you.

## Requirements

Everything works out of the box except: the **Devin Local** surface and the terminal's `devin` tab need the [Devin CLI](https://devin.ai) (`devin` on PATH); the **Claude** surface needs the Claude Code CLI; and running sessions *inside* WSL distros is optional — without WSL everything stays on the Windows host.

For a WSL distro the app runs a small helper inside the distro (it is copied to `~/.agent-workspace/` in that distro on first use and started with the distro's own Node.js), so **Node.js 18 or newer must be installed in the distro**. Without it the distro's row under **Settings → General → Hosts** says the helper needs Node. The helper is only started for distros that are already running — the app never boots a stopped distro — and if it keeps failing the row shows it stopped; **Re-check** tries again.

## Getting started

- The window opens on the **Cloud** surface — your Devin tenant's web app, hosted. Change the tenant under **Settings → Devin Cloud → Tenant URL**; SSO sign-in runs inside the hosted view, nothing is intercepted.
- Click any GitHub link in a session — it opens in the tabbed **Linked Context** pane on the right (`Ctrl+Shift+G` toggles it).
- Toggle the **terminal dock** with the **>_** rail button or `` Ctrl+` ``.
- The **Local** and **Claude** surfaces manage workspaces from the session column — add a folder and start sessions on it (each surface keeps its own list).
- **Notifications** and the **PR panel** poll the Devin API — create a personal or service-user token and save it under **Settings → Notifications**.
- The **Analytics** rail button shows your Devin ACU usage and Claude plan limits; the rail dot warns at 50 %/80 % of a limit. Claude token totals cover this PC only for now — totals for WSL distros are paused.

## Where things live

`%APPDATA%\agent-workspace\` on Windows, `~/Library/Application Support/agent-workspace/` on macOS — `settings.json` (plain settings and layout), `secrets.json` (API token, encrypted), `credentials.json` (saved logins, encrypted), `notifications.json` (notification history), `prs.json` (PR panel read/dismissed state), `pr-ledger.json` (PRs already seen, for catch-up after an outage), `identity.json` (resolved user id for service-user tokens), `local-sessions.json` (Devin Local session index), `claude-sessions.json` (Claude sidebar pin/archive/removed state and recorded PRs), `claude-hooks.json` (hook listener port + bearer token, mode 0600), `claude-usage-cache.json` (usage fetch caches + transcript-scan offsets), `events.jsonl` (the event log), and the two browser profiles (`persist:cloud`, `persist:github`). Uninstalling removes the app; delete this folder to remove all data.

Claude session transcripts stay where Claude Code keeps them (`~/.claude/projects/`). The one Claude config file the app edits is `~/.claude/settings.json`, and only when *Report Claude Code sessions started from other terminals* is on: the original is copied once to `~/.claude/settings.json.agent-workspace.bak` before the hook block is added, and the block is removed again when the toggle is turned off.

The event log records URLs, ids and sizes only — never page content, terminal output, or secrets. It is the first place to look if notifications or PR tabs don't appear.

## Keyboard shortcuts

On macOS, `Cmd` works everywhere `Ctrl` is listed (`Ctrl` works too).

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+G` | Toggle Linked Context |
| `Ctrl+Shift+[` / `]` | Shrink / grow the pane |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous GitHub tab |
| `Ctrl+W` | Close the active GitHub tab |
| `Alt+←` / `Alt+→`, `Ctrl+R` / `F5` | Back / forward / reload in the focused view |
| `Ctrl+N` | New Devin session |
| `` Ctrl+` `` | Toggle terminal dock (Cloud, Local and Claude surfaces; inert on Settings and Analytics) |
| `Ctrl+Enter` | Send the message in a Devin Local or Claude chat composer (`Enter` inserts a newline) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom the focused view |

GitHub tabs can be dragged to reorder; right-click a tab for *Copy address*, or the strip for *Reload all tabs in this session*.

In the terminal: `Ctrl+C` copies when text is selected (otherwise it is sent to the shell), `Ctrl+Shift+C` copies, `Ctrl+V` / `Ctrl+Shift+V` paste; right-click copies the selection or pastes when nothing is selected. On macOS use `Cmd+C` / `Cmd+V` — plain `Ctrl+C` / `Ctrl+V` keep their terminal meaning.

## Development

```
npm ci
npm run typecheck      # tsc
npm run lint           # eslint (typescript-eslint + react-hooks, recommended sets)
npm run test:unit      # vitest (pure core logic)
npm run test:e2e       # build + Playwright against local fixture servers
npm run test:e2e:headed # same, with the app window visible
npm start              # build + run
npm run dist:win       # NSIS installer -> dist/
npm run dist:mac       # arm64 dmg + zip (ad-hoc signed) -> dist/, macOS only
npm run smoke:install  # install, smoke-test, upgrade, uninstall the built installer
```

By default every e2e launch runs **quiet**: the app window is invisible (opacity 0, hidden from the taskbar) and never activated, so a full run doesn't take over your desktop or keyboard focus — specs drive the app through CDP and test hooks, so nothing they assert needs the window seen. `npm run test:e2e:headed` (`AGENT_WORKSPACE_TEST_QUIET=0`) shows the window for debugging.

Node ≥ 22.12 is required. See `AGENTS.md` for architecture notes, environment variables and project conventions.
