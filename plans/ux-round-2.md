# UX round 2 — composer keys, terminal dock, Settings tabs, workspaces in the session column

Status: Implementing — P0+P4a merged (#77); P1–P3 PRs open; P4b/P5 in flight

## 0. The ask

1. **Ctrl+Enter sends** in the Devin Local and Claude chats (Enter inserts a newline).
2. **Terminal dock shows on the Devin and Claude chat surfaces by default** when it's toggled on; **never on Settings**; the "Show terminal dock on Local and Settings too" setting goes away.
3. **Devin Local settings** move out of General into their own Settings tab.
4. **Claude Code settings** move out of General into their own Settings tab.
5. **Workspaces are managed entirely in the session column** (no Settings UI). They behave like Devin Cloud folders — created, ordered, collapsed, renamed, removed with the same controls the Cloud sidebar uses — and the same holds for Claude Code sessions.

## 1. What the code looks like today (verified)

| Area | Today | Files |
|---|---|---|
| Composer | `ChatView.tsx` is shared by Local and Claude; `onComposerKey` sends on Enter unless Shift. Footer hints say "Enter sends · Shift+Enter newline" (LocalPanel passes it; ClaudeView has its own). | `src/shell/chat/ChatView.tsx`, `src/shell/local/LocalPanel.tsx:446`, `src/shell/claude/ClaudeView.tsx` |
| Dock visibility | `terminalOpen && (surface === 'cloud' \|\| terminal.allSurfaces)` — computed twice: main (`terminalVisible()` drives native bounds) and shell (`App.tsx`). `Rail` greys the toggle on "off" surfaces. | `src/main/window.ts:34`, `src/shell/App.tsx:76`, `src/shell/components/Rail.tsx:95` |
| `terminal.allSurfaces` | Schema + draft field + General checkbox `#terminalAllSurfacesInput` + `terminal.spec.ts:366` + two unit specs. | `src/shared/ipc.ts:292`, `src/core/settingsDraft.ts`, `src/shell/settingsDraft.ts`, `GeneralTab.tsx:423` |
| Settings tabs | `SettingsTabs.tsx` (5 tabs), `SettingsTabId` in `core/settingsDraft.ts` with a **field → tab map** (`FIELD_TAB`) used to jump to the tab holding a validation error; `commitDraft('tab')` on tab switch. General holds: tenant, API base, **workspaces**, tab pool, Cloud pool, sessions-column toggle, **Claude path / auto-archive / permission mode / model**, **terminal allSurfaces** + shell command, **Hosts block** (shared by Claude and Devin). | `src/shell/components/settings/*`, `src/shell/components/SettingsPanel.tsx`, `src/core/settingsDraft.ts` |
| Local-only settings with no UI | `local.devinPath` (README: settings.json only), `claude.keepAliveMinutes`, `claude.maxLiveAgents`. `claude.hooksEnabled` lives on the Notifications tab. | `ipc.ts:341`, `README.md:77,141` |
| Session column | `computeBounds` only reserves the column for `cloud` and `claude`; `SessionSidebar` (Cloud) and `ClaudeSidebar` both render `buildSessionTree` sections through the shared `SectionHeader` (collapse, rename, DnD reorder, move-session drop target, "new in folder"), `SessionRow`, `FolderNameInput`, `useOptimisticList`, `useRowKeyboardNav`. Claude folders are free-form user folders in the Claude registry (`folderCreate/Rename/Delete/Reorder`, `sessionMove`). | `src/shell/App.tsx:83`, `src/core/sessionTree.ts`, `src/shell/components/sidebar/*`, `src/main/claude/sessions.ts:813` |
| Local surface | `LocalPanel` owns a fixed 256 px `<aside>`: flat **Workspaces** list (sorted by path, `+ Add` → folder picker, `×` remove) + **Sessions** list for the *selected* workspace only (listed lazily per workspace via `localListSessions`). No folders, no DnD, no collapse, no sessions column. `acpHost` spawns one agent per configured workspace at start. | `src/shell/local/LocalPanel.tsx`, `src/main/local/acpHost.ts:175-280` |
| `settings.workspaces` | Also the **pty cwd allow-list** (`terminalHost.ts:366`, `terminalIpc.ts:97`) and the Local agent roster. Order is currently meaningless (the UI sorts). | |

## 2. Decisions

- **D1 — Contracts first, then parallel.** Same model as Phases 1–8: one small contracts PR on `main` removes the settings surface everyone else would otherwise fight over (`GeneralTab.tsx`, `core/settingsDraft.ts`, `ipc.ts`), then the feature phases run in **separate git worktrees on disjoint files** and merge in any order.
- **D2 — `settings.workspaces` stays as storage.** It remains the Local agent roster and the pty allow-list; only the Settings UI goes. Its array order becomes the user's workspace order (reorder = rewrite the array). Workspace display labels and collapse state are new keys (`local.workspaceLabels`, `local.collapsedWorkspaces`), not a migration of the array.
- **D3 — Dock rule becomes `terminalOpen && surface ∈ {cloud, local, claude}`.** Settings and Analytics never show it, and the Rail toggle is disabled there. `terminal.allSurfaces` is deleted from the schema (unknown keys already strip on load, so old `settings.json` files need no migration step — to be confirmed by the contracts PR's unit test).
- **D4 — Hosts block stays in General.** It's shared infrastructure for both Claude and Devin; the Devin Local and Claude Code tabs each get a one-line "Per-host paths are under General → Hosts" pointer. (Alternative: a sixth **Hosts** tab. Cheap to change later; not doing it now.)
- **D5 — Tab contents.**
  - **General:** tenant URL, API base, tab pool (keep-alive / max live tabs), Cloud pool (max live views / keep-alive), sessions-column toggle, terminal shell command, Hosts (without the default-distro select).
  - **Devin Local:** `local.devinPath` (new control), **`local.defaultWslDistro`** (new key; the select moves here from Hosts), and a read-only "agents" summary (one line per workspace: status, CLI version) — the thing `AgentBadge` shows today, without opening the surface.
  - **Claude Code:** path, auto-archive days, default permission mode, model, `keepAliveMinutes`, `maxLiveAgents` (new controls), **`claude.defaultWslDistro`** (new key), and a mirror of the hooks toggle that currently lives under Notifications (single source of truth stays `claude.hooksEnabled`; Notifications keeps its copy).
  - `hosts.defaultWslDistro` is removed; P0 migrates its value into both new keys once (so nothing changes for the user on upgrade) and `newSession` on each surface reads its own key.
- **D6 — Local gets the real sessions column.** `computeBounds` reserves the column for `local` too; a new `LocalSidebar` renders workspaces as top-level sections through the same `SectionHeader`/`SessionRow`/DnD/optimistic-list primitives the Cloud sidebar uses, and `LocalPanel` drops its `<aside>` (chat + terminal only, like `ClaudeView`). Sessions for **all** workspaces are listed at start (not lazily per selection) so the tree is complete.
- **D7 — Workspace folders are path-backed, not free-form — on both surfaces.** Creating one = picking a folder (local or `\\wsl.localhost\<distro>\…`); its default label is the basename (+ host chip for WSL); rename edits the label only; delete = remove workspace (sessions remain on disk; the Local agent is stopped). Moving a session between workspaces is **not** a thing (a session belongs to the cwd it was created in), so the move drop-target is disabled — this is the one place the Cloud controls don't map 1:1. Everything else (collapse, DnD reorder, rename, header actions, context menus, filter box) is the same `SectionHeader`/`SessionRow` behaviour and look as the Cloud sidebar.
- **D8 — Claude workspaces are a separate list from Local workspaces, with identical UI.** New key `claude.workspaces: string[]` (+ `claude.workspaceLabels`, reusing `claude.collapsedFolders` keyed by path); `settings.workspaces` stays Local-only. In the Claude sidebar a session files under the workspace whose path equals its `cwd` (host-aware: a `\\wsl.localhost\D\home\…` workspace matches a `wsl:D` session with cwd `/home/…`); sessions whose cwd matches no workspace go to *Recent*; "New session" on a workspace header starts a session in that cwd with no folder picker; the header's *New session* button with no workspace selected keeps today's picker. The free-form folder registry (`folderCreate/Rename/Reorder/Delete`, `sessionMove`, `entry.folder`) is **retired**: P0's migration turns each existing Claude folder into a workspace whose path is the most common `cwd` among its sessions (label = the old folder name); folders with no resolvable cwd are dropped and their sessions fall into *Recent* (logged as `claude-folders-migrated {converted, dropped}`). Pinned stays.
- **D9 — One shared sidebar component, two data adapters.** P4 extracts the workspace-sidebar behaviour into `components/sidebar/WorkspaceSidebar.tsx` (header, filter, sections, context-menu plumbing) parameterised by a small adapter (`listData`, `onAdd`, `onReorder`, `onRename`, `onRemove`, `onNewSession`, `rowOpts`, `contextMenu`). `LocalSidebar` and `ClaudeSidebar` become thin adapters; `SessionSidebar` (Cloud) is **not** refactored in this round (its folders are server-side and free-form).

## 3. Phases

```
P0 contracts (main, serial, small)
 ├─ P1 Ctrl+Enter            ─┐
 ├─ P2 terminal dock rule     │ parallel worktrees, disjoint files, merge in any order
 ├─ P3 Settings tabs          │
 └─ P4 workspaces in column  ─┘  (largest; starts last-but-one, finishes last)
P5 integration + docs gate (main, serial, small)
```

### P0 — Contracts (serial, on `main`, ~1 PR)
Removes the shared-file contention before anything runs in parallel.
- `ipc.ts`: delete `terminal.allSurfaces` and `hosts.defaultWslDistro`; add `local.workspaceLabels: Record<string,string>`, `local.collapsedWorkspaces: string[]`, `local.defaultWslDistro`, `claude.workspaces: string[]`, `claude.workspaceLabels`, `claude.defaultWslDistro`; add the IPC channel names + zod shapes for the workspace-sidebar mutations on both surfaces (`local:workspaceAdd/Reorder/Rename/Remove`, `local:contextMenu`, `claude:workspaceAdd/Reorder/Rename/Remove`; the Claude `folder*`/`sessionMove` channels are marked deprecated here and deleted in P4) and the Settings tab ids `'local' | 'claude'`.
- `main/settings.ts` load-time migrations (one-shot, logged): `hosts.defaultWslDistro` → both new keys; Claude registry folders → `claude.workspaces` per D8.
- `core/settingsDraft.ts` + `shell/settingsDraft.ts`: drop `terminalAllSurfaces`, `workspaces`, `defaultWslDistro` from the draft; add draft fields `devinPath`, `localDefaultWslDistro`, `claudeDefaultWslDistro`, `claudeKeepAliveMinutes`, `claudeMaxLiveAgents` with validation; extend `SettingsTabId` and `FIELD_TAB` (Claude fields → `'claude'`, Local fields → `'local'`).
- `GeneralTab.tsx`: delete the Workspaces block, the allSurfaces checkbox and the default-distro select (the Claude rows stay until P3 moves them — P3 is the only phase that touches `GeneralTab.tsx` after P0).
- `SettingsTabs.tsx`: add the two tabs rendering a placeholder (so P3 can own the content files alone).
- Unit specs updated (`settings.test.ts`, `settingsDraft.test.ts`); `terminal.spec.ts:366` block rewritten to assert the new rule is *pending* (skip with a P2 note) — or simply deleted here and re-added by P2. Decision: delete here, P2 re-adds.
- Gate: typecheck · lint · unit · build · `settings*.spec` + `terminal.spec`.

### P1 — Ctrl+Enter sends (worktree `ux2-keys`, tiny)
- `ChatView.tsx`: send on `Enter` with `ctrlKey || metaKey`; plain Enter inserts a newline; Shift+Enter unchanged (newline). Footer hints → "Ctrl+Enter sends · Enter newline" (`LocalPanel` hint prop, `ClaudeView` hint), platform-aware label (⌘ on darwin via `window.devinworkspaces.platform`).
- e2e: `local.spec.ts:182` and `claudeSessions.spec.ts:120,134` press Ctrl+Enter; one new case asserts plain Enter does **not** send (draft grows a line, no prompt IPC). Inline editors (folder names, session rename) keep plain Enter — they're not composers.
- Files: `src/shell/chat/ChatView.tsx`, hint lines in `LocalPanel.tsx`/`ClaudeView.tsx`, two specs, README. Gate: `local.spec` + `claudeSessions.spec`.

### P2 — Terminal dock on chat surfaces, never on Settings (worktree `ux2-dock`, small)
- One shared predicate `dockSurface(surface)` in `src/core/layout.ts` (`cloud | local | claude`), used by `window.ts: terminalVisible()`, `App.tsx` and `Rail` (which drops the `terminalAllSurfaces` prop and disables the toggle on Settings/Analytics); `terminalToggle` from the shortcut (Ctrl+`) is a no-op there.
- Check the Claude per-session Terminal *tab* and the dock coexist on `claude` (they're independent today because the dock was never shown there — verify focus/`active` handling and the splitter geometry with both).
- e2e: new `terminal.spec` block — dock visible on cloud/local/claude when open, hidden on settings, re-appears when leaving settings, bounds correct on each. Files: `window.ts`, `App.tsx`, `Rail.tsx`, `shortcuts.ts`, `terminal.spec.ts`, README. Gate: `terminal.spec` + `shell.spec`.

### P3 — Devin Local and Claude Code settings tabs (worktree `ux2-tabs`, medium)
- New `settings/LocalTab.tsx`, `settings/ClaudeTab.tsx` per D5; `GeneralTab.tsx` loses the Claude rows; `SettingsPanel` wires the tabs; each new tab renders its own default-WSL-distro select (`local.defaultWslDistro` / `claude.defaultWslDistro`, options from `state.hosts`), and `localNewSession` / `claude newSession` read their own key (main-side one-liners, owned by P3).
- `local.devinPath` becomes a real control (blank = PATH; inline "not found" hint from `local.cliPath`, mirroring `CliPathHint`). Changing it restarts the Local agents — check what `acpHost` does today on a `devinPath` change (hypothesis: nothing until restart; if so, add the restart or a "restart required" note — P3 decides after reading `acpHost`).
- e2e: `claudeSessions.spec.ts` selectors move from `settingsTab-general` to `settingsTab-claude`; new `settings.spec` cases: both tabs render, error routing lands on the right tab, arrow-key tab cycling includes them. README settings table rows re-homed. Files: `src/shell/components/settings/*`, `SettingsPanel.tsx`, specs, README. Gate: `settings*.spec` + `claudeSessions.spec`.

### P4a — Local workspaces in the session column (worktree `ux2-workspaces`, large; sub-streams core / main / shell)
- **core:** `workspaceTree.ts` — maps a workspace list (+ labels, collapsed order) and a session list to `SidebarListData`: each workspace is a `folder` section named by its path, sessions carry `folder = workspace path`, sorted by `createdAt` desc; pure, unit-tested; reorder/rename/remove reducers for optimistic use. Written generic so P4b reuses it (Local passes `session.workspace`; Claude passes a host-aware `cwd → workspace` match).
- **main:** `acpHost`/`local/ipc.ts` — list sessions for every workspace at start (today: on first selection), `workspaceAdd` (picker, already exists as `localPickWorkspace`), `workspaceReorder(paths)`, `workspaceRename(path,label)`, `workspaceRemove`, `localContextMenu` (workspace: *New session*, *Rename…*, *Open terminal here*, *Reveal in Explorer*, *Delete all sessions…*, *Remove workspace*; session: *Delete*, *Open terminal*, *Copy id*). Settings keys from P0. Removing a workspace stops its agent (already does) and prunes its live ptys.
- **shell:** new `components/sidebar/WorkspaceSidebar.tsx` (D9) + `LocalSidebar.tsx` adapter (header: *New session*, *Add workspace* (folder picker), *Refresh*, *More*; filter box; sections = workspaces with `SectionHeader` collapse/rename/DnD-reorder/new-in-folder; rows = `SessionRow` with the agent status dot as `leading`, `>_` terminal-owned marker as badge, date as meta; move drop-target disabled per D7; delete-all dialog moves here). `App.tsx`: `sessionsOpen` applies to `local`; `LocalPanel` drops the `<aside>`, keeps header/Chat/Terminal; selection moves to main (`localActiveSession` already exists) so sidebar and panel agree across remounts. Empty state when no workspaces ("Add a workspace folder…" with the button).
- **e2e:** `local.spec`, `localPr.spec`, `localScope.spec`, `terminal.spec` (Local parts) re-targeted from `#wsList/#sessionList` to the sidebar selectors; new cases: add → section appears; DnD reorder persists in `settings.workspaces`; collapse persists; rename persists label; remove → agent stopped + section gone; sessions listed for a non-selected workspace at start; sessions-column toggle hides it on Local. WSL fake case: a `\wsl.localhost` workspace shows the host chip in its header. Gate: the four specs + `cloudSessions.spec` (shared primitives: prove the Cloud sidebar is unchanged).

### P4b — Claude workspaces (worktree `ux2-claude-workspaces`, medium; starts once P4a's `WorkspaceSidebar` + `workspaceTree` are on `main`)
- **core:** the host-aware `cwd → workspace` matcher in `workspaceTree.ts` (`pathHostId` + `toWindowsPath` from `execHost.ts`); unit-tested for local, UNC and `wsl:` sessions, trailing-slash and case differences on Windows.
- **main:** `claude/sessions.ts` — `workspaceAdd/Reorder/Rename/Remove` on `settings.claude.*`; a session's folder becomes *derived* (matching workspace path) instead of stored; `newSession(cwd)` from a header passes the path straight through (no picker); context menu gains *Add workspace…*, *New session here*, *Rename…*, *Reveal*, *Open terminal here*, *Remove workspace*; the `folder*`/`sessionMove` IPC, registry reducers and their unit tests are deleted; `fork` keeps the forked session in the same cwd so it files itself.
- **shell:** `ClaudeSidebar` → thin `WorkspaceSidebar` adapter; keeps its extras (subagent rows, background-agents section, host chip, activity dots) through `rowOpts` / an `extraSections` slot.
- **e2e:** `claudeSessions.spec` / `claudeDeferrals.spec` folder cases rewritten as workspace cases (add via `DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD`, auto-filing by cwd, reorder/collapse/rename/remove persist in `settings.claude.*`); migration fixture: a registry with two folders → one converted, one dropped, `claude-folders-migrated` asserted; WSL fake case: a `\wsl.localhost` workspace files a `wsl:Fake` session whose cwd is the matching Linux path. Gate: both Claude specs + `cloudSessions.spec`.

### P5 — Integration + docs (serial, on `main` after P1–P4 merge, small)
- README: layout section (dock rule, sessions column on Local), settings table (new tabs, removed rows), workspaces section rewritten for both surfaces; AGENTS.md settings keys (removed `terminal.allSurfaces`, `hosts.defaultWslDistro`; added `local.*`/`claude.*` keys, new log events, new IPC); `plans/README.md` row.
- Full gate once: typecheck · lint · unit · build · **full e2e** · `smoke:install` (settings schema changed → required).

## 4. Parallel execution

- Worktrees: `git worktree add ../devin-workspace-wt/<name> -b feat/<name> main` after P0 merges; each has its own `node_modules` (`npm ci`) so builds/e2e don't collide; e2e in each worktree uses its own temp profile (already the default) and its own `out/` dir, so Playwright `_electron` runs can overlap.
- Streams and file ownership (no two streams edit the same file after P0):

| Stream | Owns | Must not touch |
|---|---|---|
| P1 | `chat/ChatView.tsx`, the two hint lines, `local.spec`/`claudeSessions.spec` composer cases | anything else |
| P2 | `core/layout.ts` (`dockSurface` only), `main/window.ts`, `App.tsx` (dock lines only), `Rail.tsx`, `shortcuts.ts`, `terminal.spec` dock block | `computeBounds` |
| P3 | `components/settings/*`, `SettingsPanel.tsx`, the two `newSession` default-distro reads, `settings*.spec`, `claudeSessions.spec` settings cases | `core/settingsDraft.ts` (P0 already did it) |
| P4a | `core/workspaceTree.ts`, `main/local/*`, `shell/local/*`, new `WorkspaceSidebar.tsx` + `LocalSidebar.tsx`, `App.tsx` (sessions lines only), Local specs | existing `components/sidebar/*` (if a primitive needs a prop, add it **optional** and default-preserving); `ClaudeSidebar.tsx` |
| P4b | `main/claude/*`, `ClaudeSidebar.tsx`, `workspaceTree.ts` (matcher only), Claude specs | `WorkspaceSidebar.tsx` beyond adding optional slots |

- `App.tsx` is touched by P2 (one expression) and P4a (one expression): known trivial conflict, whoever merges second rebases. `claudeSessions.spec.ts` is touched by P1 (two key presses), P3 (tab selectors) and P4b (folder cases): separate `test.describe` blocks, conflicts expected to be line-local.
- Each stream is a sidekick/subagent handoff with the per-phase plan as the brief; the lead reviews each diff and runs the real-WSL check for P4a/P4b (a `\wsl.localhost` workspace end to end on each surface) on this machine, since CI has no WSL.
- Order of dispatch: P0 (lead-reviewed, merge) → P1 + P2 + P3 + P4a in parallel → merge P1/P2/P3 as they land → P4a merges → P4b → P5.

## 5. Decisions taken in round 1 (were open questions)

- **Q1 → (b).** Claude folders are path-bound workspaces, exactly like Devin Local's. (D7, D8, P4b.)
- **Q2 → two lists** (`settings.workspaces` for Local, `claude.workspaces` for Claude) with the same UI controls and feel on both surfaces. (D8, D9.)
- **Q3 → per-surface default distro** on the Devin Local and Claude Code tabs, removed from General → Hosts; values may differ. (D5.)
- **Q4 → dock on chat surfaces + Cloud only**, never on Analytics or Settings. (D3.)

## 6. Implementation notes

Deviations from the plan above, as implemented:

- **P0 inlined the dock rule.** The contracts PR replaced `terminal.allSurfaces` with the literal `surface === 'cloud' || 'local' || 'claude'` in `window.ts`, `App.tsx` and `Rail.tsx`; P2 extracted it into `dockSurface()` in `src/core/layout.ts` (unit-tested) and made the shortcut honour it.
- **The Rail dock toggle was only dimmed off-surface before P2.** P0 left the button clickable with `opacity-50` on Settings/Analytics; P2 made it `disabled` (and the Ctrl+` shortcut a no-op there, logging `terminal-toggle {open, source:'shortcut'}` only when it acts). The persisted `layout.terminalOpen` is never touched by a visit to an off-surface.
- **Claude folder → workspace migration runs in `ClaudeSessions`, not at settings load.** D8/P0 placed it in `main/settings.ts`, but the conversion needs each session's `cwd` (most common cwd per folder), which only the store knows — so it runs once after the first store refresh, and logs `claude-folders-migrated {converted, dropped}` from there. P0 only shipped the `hosts.defaultWslDistro` migration (`migrateSettingsRaw` in `src/core/settings.ts`, `settings-migrated {from:'hosts.defaultWslDistro'}`).
- **`local.devinPath` changes need an app restart.** `DevinLocalHost` resolves the command once at construction; P3 did not add a live restart and instead shows a "restart the app to apply a changed path" hint under the field (the P3 open question in §3 resolved as "restart required").
- **e2e: `page.keyboard.press` never reaches Electron's `before-input-event`.** Main-process shortcuts (Ctrl+`) are driven with `webContents.sendInputEvent` from `app.evaluate` — `ctrlBacktick` in `tests/e2e/terminal.spec.ts`.
- **Local context menu gained a `header` kind** (*Add workspace…*, *Refresh all*) beyond the workspace/session kinds listed in P4a, and *Copy id* shipped as *Copy session id* (`local-session-copy-id`).
