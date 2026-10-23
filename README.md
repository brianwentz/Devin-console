# Agent Workspace

Agent Workspace is a desktop client for Windows and macOS (Apple Silicon) that puts your coding agents in one window: Devin Cloud sessions from your tenant, OpenHands Cloud conversations, Devin Local and Claude Code sessions on local or WSL folders, a tabbed Linked Context pane that catches every link and PR a session produces, a terminal dock, PR and notification panels, usage analytics with limit alerts, and saved SSO logins — with layout and sessions remembered across restarts.

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

Sessions inside a WSL distro need **Node.js 18 or newer installed in that distro** — see [Running sessions in WSL](#running-sessions-in-wsl). Claude sessions on another machine over SSH need the Windows OpenSSH client (`ssh.exe`, built in) and Node.js 18 or newer on that machine — see [SSH hosts](#ssh-hosts).

## Getting started

- The window opens on the **Cloud** surface — your Devin tenant's web app, hosted. Change the tenant under **Settings → Devin → Tenant URL**; SSO sign-in runs inside the hosted view, nothing is intercepted.
- Click any GitHub link in a session — it opens in the tabbed **Linked Context** pane on the right (`Ctrl+Shift+G` toggles it). **Settings → Link Handling → Linked Context** holds the tab pool (keep-alive, max live tabs) and the toggle that opens a tab when a session creates a PR.
- Toggle the **terminal dock** with the **>_** rail button or `` Ctrl+` ``.
- The **Local** and **Claude** surfaces manage workspaces from the session column — add a folder and start sessions on it (each surface keeps its own list).
- **Notifications** and the **PR panel** poll the Devin API — create a personal or service-user token and save it under **Settings → Devin**.
- **Settings → OpenHands** configures the OpenHands Cloud connection: **OpenHands URL** (OpenHands Cloud by default, or your own server — https only, a sub-path is allowed), an optional **OpenHands API key** (Save / Clear; stored encrypted and never shown again — without one the app uses your OpenHands web sign-in), how often to check for conversation updates (10–600 seconds), how many conversations stay loaded (1–20) and how long hidden ones stay live (0–168 hours). The line under the key shows how the app is connected. The OpenHands rail button opens the OpenHands surface: your conversations are listed in the session column, grouped by repository (right-click a conversation to rename it, copy its ID, open it in your browser or delete it), and picking one shows it in the main column. The home page behind the **+** button is where new conversations start. Sign-in hops to GitHub, GitLab or Bitbucket stay inside the OpenHands view instead of opening a tab. If sign-in or the API key is missing, a hint above the list takes you to the right place.
- The **Analytics** rail button shows your Devin ACU usage and Claude plan limits; the rail dot warns at 50 %/80 % of a limit. Claude token totals include your WSL distros, counted inside each distro.

## Running sessions in WSL

Add a workspace inside a distro on the **Local** or **Claude** surface and its sessions run inside that distro. Enable or disable distros under **Settings → General → Hosts**.

- **Picking a folder in a distro** happens in the app, not in Windows' folder dialog: set a default WSL distro for the surface (**Settings → Devin Local / Claude Code**), or right-click the session column header → **Add WSL workspace…** (Local) / **Add remote workspace…** (Claude). Type a path — matching folders in the distro are suggested as you type (Tab or a click completes one) — and press **Choose folder**. Folders on this PC still use Windows' folder dialog: with a default distro set, pick **This PC (browse…)** at the end of the host list to open it.

- **Node.js 18 or newer must be installed in the distro.** The app runs a small helper there with the distro's own Node.js; it lists Claude sessions, loads their history, renames/forks/deletes transcripts, writes the Claude hook settings, lists background agents, reads the distro's Claude sign-in details and counts its Claude usage totals for the Analytics page, checks a "Folder pickers start in" folder that points into the distro, and lists folders for the in-app folder picker — all inside the distro rather than through the `\\wsl.localhost` network share.
- The helper is copied to `~/.agent-workspace/` in the distro on first use (one file per app version; copies unused for a week are cleaned up). Deleting the folder is safe — it is copied again on the next start.
- Without Node.js (or with a version older than 18) the distro's row says **Node 18 or newer is required** and that distro's sessions don't load. Install Node in the distro, then press **Re-check**.
- The app never starts a stopped distro. While a distro is stopped its helper shows as **paused** and its sessions keep their last state; they refresh once the distro runs again. If the helper keeps failing the row shows it stopped — **Re-check** tries again.
- Turning off *Report Claude Code sessions started from other terminals* removes the hook block from every running, enabled distro that has Node.js 18 or newer (the helper does the removal — in a distro without it, remove the block from `~/.claude/settings.json` yourself), and also from a running distro you disabled since the app started. A distro that was already disabled when the app started is cleaned up when you enable it again; until then the app ignores the reports it sends. A stopped distro is never started for this. While the toggle is off, the app ignores reports from terminals it did not open itself.

## SSH hosts

Claude Code sessions can also run on another machine you reach over SSH (a Linux box, a VM, a WSL distro with its own sshd).

- **Add the host:** **Settings → General → Hosts → Add SSH host…** and enter a `Host` alias from your `~/.ssh/config` (letters, digits, `.`, `_`, `-`; aliases are not case-sensitive). The names `ssh`, `local` and `wsl` are reserved — give such a host a different alias in your SSH config; an existing entry with one of these names is ignored (left untouched in the settings file). The folder picker refuses a folder that does not exist on the host. The app connects with the Windows OpenSSH client using that alias — user, port, key and jump hosts all come from your SSH config.
- **Key or agent authentication only.** The app runs `ssh` in batch mode (`BatchMode=yes`): it never shows a password or passphrase prompt, and the host key must already be known — connect once with `ssh <alias>` in a terminal first. If the connection fails, the host's row shows the error; fix the config and press **Re-check**. If the OpenSSH client is not installed, install it (Windows **Optional features → OpenSSH Client**) and restart the app.
- **No connection reuse.** The app turns off OpenSSH connection sharing (`ControlMaster`/`ControlPath`) and opens several connections per host (setup, the helper, the hook forward, each chat and terminal). A security key (FIDO / `sk-` keys) or an MFA bastion therefore asks for a touch or code on every one of them.
- **Node.js 18 or newer is required on the remote machine**, the same helper as for WSL is copied to `~/.agent-workspace/` there, and the row shows **Node 18 or newer is required** when it is missing. The remote login shell must be bash, zsh, sh or fish — csh/tcsh login shells are not supported (set a shell under the host's **Overrides**), and neither is a machine whose `/bin/sh` is ksh93.
- **Workspaces:** right-click the Claude session column header → **Add remote workspace…**, pick the SSH host and type the folder (suggestions come from the remote machine). The workspace is stored as `ssh://<alias>/<path>`. Chats, the terminal tab (`ssh -t`) and background agents run on the remote machine; **Reveal in Explorer** and **Reveal transcript** are not available for SSH sessions. Devin Local sessions run on this PC and in WSL only.
- **Hooks:** *Report Claude Code sessions started from other terminals* covers this PC and WSL distros only — the app never writes its hook block into a remote machine's `~/.claude/settings.json` (a block an earlier version wrote there is removed when the host connects). Claude sessions on an SSH host report activity to the app only when opened in the app's terminal tab. For those, the app forwards its hook listener's port to the remote machine over a separate SSH connection (`ssh -R`, bound to the remote's loopback) that closes when the app exits. The forward fails closed: if the port is already taken on the remote machine the connection ends instead of reporting to whoever holds it, and the app only trusts the forward after the listener at its far end proves it is this app. Until then the host's row says **Hooks unavailable** and terminals opened on that host get no hook settings. The app retries the forward on its own while the host is connected.
- **Shared machines:** other users on the same remote machine can see which ports are open and the names of the programs you run. The app keeps secrets off command lines (the hook token reaches a terminal through a private file the shell reads and deletes) and writes `~/.claude/settings.json` readable by you only, but a machine whose administrators or other users you do not trust is not a good place for any credentials — including Claude Code's own.
- **Connection drops:** after sleep or a network change, a host whose connection failed is retried when the computer wakes or is unlocked, when you return to the window (at most once a minute) and every five minutes; **Re-check** retries at once.
- Disabling the host (checkbox) stops its helper and the app no longer connects to it; **Remove** forgets it, including its **Overrides**. The event log never contains the alias — only a short hash of it.

## Where things live

`%APPDATA%\agent-workspace\` on Windows, `~/Library/Application Support/agent-workspace/` on macOS — `settings.json` (plain settings and layout), `secrets.json` (Devin API token and OpenHands API key, encrypted), `credentials.json` (saved logins, encrypted), `notifications.json` (notification history), `prs.json` (PR panel read/dismissed state), `pr-ledger.json` (PRs already seen, for catch-up after an outage), `identity.json` (resolved user id for service-user tokens), `local-sessions.json` (Devin Local session index), `claude-sessions.json` (Claude sidebar pin/archive/removed state and recorded PRs), `claude-hooks.json` (hook listener port + bearer token, mode 0600), `claude-usage-cache.json` (usage fetch caches + transcript-scan offsets), `openhands-cache.json` (the last OpenHands conversation list, so the sidebar renders at once), `events.jsonl` (the event log), and the two browser profiles (`persist:cloud`, `persist:github`). Uninstalling removes the app; delete this folder to remove all data.

Claude session transcripts stay where Claude Code keeps them (`~/.claude/projects/`). The one Claude config file the app edits is `~/.claude/settings.json` (on this PC and in WSL distros — never on an SSH host, except to remove a hook block an earlier version left there), and only when *Report Claude Code sessions started from other terminals* is on: the original is copied once to `~/.claude/settings.json.agent-workspace.bak` before the hook block is added, and the block is removed again when the toggle is turned off.

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
| `Ctrl+N` | New session on the current surface (Devin Cloud by default; Claude; the OpenHands home page) |
| `Ctrl+Shift+S` | Show / hide the sessions column (Cloud, Claude and OpenHands) |
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
