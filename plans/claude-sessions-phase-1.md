# Phase 1 — Claude surface skeleton, SDK packaging, registry + sidebar

Status: Done — merged as PRs #56–#59.

Technical plan for Phase 1 of `plans/claude-sessions.md`. Four PRs, each ending green on `typecheck`, `test:unit`, `build`, `test:e2e`; PR 1 additionally gates on `dist:win` + `smoke:install`. Findings referenced below are in `plans/claude-sessions-findings.md`.

## 0. Decisions made in this planning round

| Question (from the master plan) | Decision |
|---|---|
| Recent section: group by cwd or flat? | **Flat**, newest first. Each row shows the cwd basename (full path in the tooltip) and the git branch as meta; the filter box matches title **or** cwd, so typing a project name narrows to it. `buildSessionTree` is reused verbatim — no second grouping axis. |
| Surface the SDK `tag`? | Yes, read-only: a small chip after the title when `tag` is set. No tag editing in Phase 1. |
| Auto-archive after N idle days? | Setting `claude.autoArchiveDays` (0–365, **default 0 = off**), applied in the pure reconcile: a session whose `lastModified` is older than N days and that is not pinned/foldered becomes `archived` in the registry (reversible via Unarchive, which also sets `archivedManually`-style sticky `archived: false` so it isn't re-archived until it is modified again). Exposed in Settings → General. |
| Subagent rows in the sidebar | **Deferred to Phase 2.** Without a chat view a subagent row has nothing to open. Phase 1 only exposes `listSubagents` on the store wrapper. (Decision 6 — nest under parent — still stands; it lands with the view that can show them.) |
| "New session" in Phase 1? | **Not shown.** Only Claude creates transcripts; without the SDK host (Phase 2) there is nothing to create. The header keeps New folder / Refresh / More; `claude:newSession` is defined in Phase 2. Ctrl+N stays the Cloud behaviour on the `claude` surface until Phase 2. |
| "Open in terminal" context item | Phase 3 (needs the claude-kind pty). Not in the Phase 1 menu. |
| Shared sidebar DOM ids | The extracted components keep the Cloud ids/data attributes (`#sessionsPanel`, `#sessionSearch`, `#sessionFolderNew`, `#sessionFolderEdit`, `[data-session-id]`, `[data-section-kind]`…). Only one sidebar renders at a time, so the ids stay unique; the `<section>` gets `data-sidebar="cloud" \| "claude"` so specs can assert which one is up. Cloud-only ids (`#cloudRefresh`, `#cloudStatus`, `#sessionNew`) get Claude counterparts (`#claudeRefresh`, `#claudeStatus`). |
| Confirmations in test mode | `Delete transcript…` and `Delete folder…` show `dialog.showMessageBox` normally; in test mode they proceed as if confirmed (the Cloud folder delete currently always shows the dialog — Claude's version adds the `testMode` short-circuit so e2e can assert the file is gone). |
| Claude home | `CLAUDE_CONFIG_DIR` if set else `~/.claude` — the SDK itself honours `CLAUDE_CONFIG_DIR` (verified in `sdk.mjs`), so e2e points both the SDK and our `fs.watch` at a fixture tree by setting that one env var for the app process. No app-specific env var needed. |

## 1. Packaging facts that shape PR 1 (verified against `claude-workspace/node_modules`)

- `@anthropic-ai/claude-agent-sdk@0.3.296` is 5.4 MB, ESM-only (`sdk.mjs`), honours `CLAUDE_CONFIG_DIR`, memoises the config dir on first use.
- It declares **peerDependencies** `@anthropic-ai/sdk ≥0.93`, `@modelcontextprotocol/sdk ^1.29`, `zod ^4` (npm 7+ auto-installs them) and **optionalDependencies** on platform packages `@anthropic-ai/claude-agent-sdk-{win32-x64,darwin-arm64,…}@0.3.296`. The win32-x64 one is **249 MB** (a bundled `claude.exe`). It must **not** ship in the installer (current installer is 209 MB) and is not needed: we always pass `pathToClaudeCodeExecutable` (user's install). It cannot be omitted at install time (`omit=optional` would also drop esbuild/rollup platform binaries), so it is excluded at packaging.
- `sdk.mjs` bare imports at runtime: node built-ins, `ajv/dist/runtime/*`, `ajv-formats/dist/formats`, `zod/v4`, `zod/v4/core`. (`core.mjs` additionally imports `@modelcontextprotocol/sdk/server/*` — we never import `./core`.) Because the SDK stays external and is ESM, Node's resolver (not esbuild) must find these at runtime from the unpacked location, so they are packaged **and unpacked** alongside it: `@anthropic-ai/claude-agent-sdk`, `ajv`, `ajv-formats`, `fast-deep-equal`, `fast-uri`, `json-schema-traverse`, `require-from-string`, `zod` (zod is bundled into `main.cjs` today, so `node_modules/zod` is not currently in `build.files`). `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` are installed as peers but not imported by `sdk.mjs`; exclude them unless the packaged load test fails without them.
- Dynamic `import()` of an external in esbuild's cjs output is preserved as a real `import()` (that is how Spike A ran under Electron). Keep `target: 'node20'`.

## 2. PR 1 — SDK dependency, packaging, probes, `resolveClaudePath`

Scope: no UI. Done when the installed app can load the SDK and the installer size budget holds.

1. `npm install --save-exact @anthropic-ai/claude-agent-sdk@<newest version ≥ 7 days old at PR time; 0.3.296 if nothing newer qualifies>`. Record in AGENTS.md › Versions: the pin, the CLI version in its `manifest.json`, and that the platform optional packages are install-only.
2. `scripts/build.mjs`: `external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk']` for the main bundle; three new probe builds (`scripts/claude-sdk-probe.ts`, `claude-hooks-probe.ts`, `claude-store-probe.ts` → `out/scripts/*.cjs`, external electron/node-pty/SDK) ported from `claude-workspace/scripts/*-probe.ts` with `CLAUDE_WORKSPACES_` → `DEVIN_WORKSPACES_` and evidence under `docs/evidence/claude-*.jsonl`. package.json scripts `claude:sdk-probe`, `claude:hooks-probe`, `claude:store-probe` (like `acp:contract`: exit 0 when the CLI is missing, reported in the file).
3. `package.json` `build.files` += the §1 list (and `!node_modules/@anthropic-ai/claude-agent-sdk-*/**`, `!node_modules/@anthropic-ai/sdk/**`, `!node_modules/@modelcontextprotocol/**`); `build.asarUnpack` += the same positive set. Use `node_modules/<pkg>/**` globs exactly like the `node-pty` entry.
4. `src/main/claude/claudePath.ts`: port `resolveClaudePath(override)` + `INSTALL_GUIDANCE` from `claude-workspace/src/main/terminal/claudePath.ts` (text: "Claude Code is not installed or was not found on PATH. Install it from https://docs.anthropic.com/en/docs/claude-code or set the path in Settings.").
5. `src/main/claude/sdk.ts`: `loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')>` — single memoised dynamic `import()`, logs `claude-sdk-load { ok, ms, version }` (version from the package's `package.json` read via `createRequire`, or the SDK's exported version if it has one; never the path). On failure rejects with the error and logs `{ ok:false, message }`.
6. Test hook `claudeSdkProbe(): Promise<{ ok: boolean; ms: number; hasListSessions: boolean }>` in `testHooks.ts` (calls `loadSdk`, checks `typeof sdk.listSessions === 'function'`).
7. `tests/smoke/installed.spec.ts`: in the `fresh` phase assert `claudeSdkProbe().ok === true` and that `events.jsonl` has `claude-sdk-load {ok:true}`; assert `resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` exists and `…/claude-agent-sdk-win32-x64` does **not**. `scripts/smoke-install.ps1`: record installer size in the evidence json; fail if `dist/DevinWorkspaces-Setup-*.exe` exceeds **260 MB** (209 MB today + the ~45 MB of unpacked deps budget).
8. Gate: `npm run dist:win && npm run smoke:install` green; `npm run claude:store-probe` runs against the real `~/.claude` (exit 0).

## 3. PR 2 — pure core + shared schemas + unit tests

### 3.1 `src/core/sessionTree.ts` → generic
Port the `claude-workspace` version: `SidebarSession { id, title, folder, parentId, isPinned, isArchived, updatedAt, prs: SessionPrCounts }`, `SidebarListData`, `buildSessionTree(data: SidebarListData, opts)`, mutation helpers typed over `SidebarListData`. `CloudSessionState` satisfies it structurally — the Cloud sidebar and `cloudSessions.ts` compile unchanged (keep the `CloudListData` name as a type alias for `SidebarListData` so `cloudSessions.ts` imports don't churn). `parseSessionPrs` stays where it lives today (`cloudAcp.ts`) — do **not** duplicate it. Port the generic cases from `claude-workspace/tests/unit/sessionTree.test.ts` into the existing `sessionTree.test.ts` (one fixture typed as `SidebarSession`, one as `CloudSessionState`).

### 3.2 `src/core/claudeRegistry.ts` (new, pure)
```ts
export interface ClaudeStoreSession {           // what main/claude/store.ts yields per SDKSessionInfo
  id: string; title: string; cwd: string | null; gitBranch: string | null; tag: string | null;
  createdAt: number | null; lastModified: number; fileSize: number | null;
}
export interface ClaudeRegistryEntry {
  id: string; folder: string | null; pinned: boolean; archived: boolean;
  archivedAt: number | null;            // set by auto-archive; null when archived manually or not archived
  unarchivedAt: number | null;          // manual Unarchive timestamp — suppresses auto-archive until lastModified > unarchivedAt
  removed: boolean; removedAt: number | null;   // "Remove from list"
  lastOpenedAt: number | null; prUrls: string[];   // prUrls filled from Phase 2/4 on
}
export interface ClaudeRegistry { version: 1; folders: string[]; entries: Record<string, ClaudeRegistryEntry>; }
export const emptyRegistry = (): ClaudeRegistry => ({ version: 1, folders: [], entries: {} });
export const ClaudeRegistrySchema: z.ZodType<ClaudeRegistry>;   // zod, for load; unknown fields dropped
export function reconcile(reg: ClaudeRegistry, store: ClaudeStoreSession[], opts: { now: number; autoArchiveDays: number }):
  { registry: ClaudeRegistry; sessions: ClaudeSessionState[]; changed: boolean };
export function setFolder(reg, id, folder: string | null): ClaudeRegistry;   // creates the entry if missing; folder 'pinned' is not a folder here
export function setPinned(reg, id, pinned: boolean): ClaudeRegistry;
export function setArchived(reg, id, archived: boolean, now: number): ClaudeRegistry;
export function setRemoved(reg, id, now: number): ClaudeRegistry;
export function touchOpened(reg, id, now: number): ClaudeRegistry;
export function folderCreate/folderRename/folderDelete/folderReorder(reg, …): ClaudeRegistry;  // mirror sessionTree's rules: rename moves entries; delete unfolders them; reorder keeps unknown names appended
```
Reconcile rules (all unit-tested):
- Output one `ClaudeSessionState` per store session that is not `removed` → fields from the store + `folder/isPinned/isArchived` from the entry (defaults null/false/false), `parentId: null`, `prs` all zero, `missing: false`.
- A `removed` entry whose store `lastModified > removedAt` is **un-removed** (someone resumed it in a terminal) — `changed: true`.
- An entry with no store session: keep (and emit with `missing: true`, `updatedAt = lastOpenedAt ?? 0`, title `'(transcript missing)'`) **only if** pinned or foldered; otherwise drop it from the registry (`changed: true`). Phase 2 may improve the title by caching it in the entry.
- Auto-archive: when `autoArchiveDays > 0`, an entry/session with `!pinned && folder === null && !archived && lastModified < now − N·86400e3 && (unarchivedAt === null || lastModified > unarchivedAt)` becomes `archived: true, archivedAt: now`.
- Entries are created lazily — a store session with no entry does not get one until a mutation touches it (keeps the file small; 46 sessions → 0 entries until organised).
- Idempotent: `reconcile(reconcile(x).registry, …).changed === false` for the same inputs.

### 3.3 `src/shared/ipc.ts`
- `SurfaceSchema = z.enum(['cloud', 'local', 'claude', 'settings', 'analytics'])`.
- `ClaudeSessionSchema`: `{ id, title, cwd: string|null, gitBranch: string|null, tag: string|null, createdAt: number|null, updatedAt: number, folder, parentId: null-able string, isPinned, isArchived, missing: boolean, prs: {open,queued,draft,merged,closed} }`. `ClaudeStateSchema`: `{ status: 'loading'|'ready'|'error', configDir: string, cliPath: string|null, installGuidance: string, error: string|null, lastSyncAt: string|null, folders: string[], sessions: ClaudeSession[], showArchived: boolean, lastError: {op,message}|null }`. `ShellState.claude: ClaudeStateSchema`, `ShellState.claudeSessionId: string|null`.
- Settings: `claude: { path: string|null (default null), collapsedFolders: string[] (max 200), showArchived: boolean (false), autoArchiveDays: int 0..365 (0) }` with the same `.default` nesting style as `sessions`; `SettingsPatch` gains `claude: z.object(ClaudeFields).partial().optional()`. `main/settings.ts`'s legacy `surface` enum is untouched (it only reads old `spike-state.json`).
- Channels (`IpcChannels`): `claudeOpen 'claude:open'`, `claudeRefresh`, `claudeRename`, `claudeFork`, `claudeSessionMove`, `claudeSessionPin`, `claudeSessionArchive`, `claudeSessionRemove`, `claudeSessionDeleteTranscript`, `claudeRevealTranscript`, `claudeFolderCreate/Rename/Delete/Reorder`, `claudeShowArchived`, `claudeContextMenu`. Arg schemas mirror the Cloud ones (`ClaudeSessionId = z.string().uuid()`, `ClaudeFolderName = z.string().trim().min(1).max(100)`, `ClaudeRenameArg { sessionId, title: z.string().trim().min(1).max(200) }`, `ClaudeContextMenuArg { kind: 'session'|'folder'|'header', sessionId?, name?, x, y }`). The sessions-column toggle keeps using `cloud:panel` (it is surface-agnostic: `setSessionsOpen`).
- Preload: one method per channel on `window.devinworkspaces` (`claudeOpen(id)`, …, `claudeContextMenu(arg) → Promise<{action, items?}>`), following the cloud* signatures.
- Unit tests: `settings.test.ts` (defaults + patch merge for `claude`), `tabModel.test.ts` (below).

### 3.4 `src/core/tabModel.ts`
`CLAUDE_SCOPE_PREFIX = 'claude:'`, `claudeScope(id)`, `effectiveScope(surface, cloudId, localId, claudeId)` → `claude:<id>` on `claude` with a selection, else existing behaviour. Update the three call sites (`window.ts syncScope`, tests). `src/core/linkRouter.ts`: `RouteSource` += `'claude'`, routed exactly like `'local'` (shell-rendered → new-window semantics); one routing unit case.

## 4. PR 3 — main process

### 4.1 `src/main/claude/store.ts` — SDK store wrapper + change detection
```ts
export class ClaudeStore {
  constructor(opts: { configDir: string; onChange: () => void; testMode: boolean });
  async list(): Promise<ClaudeStoreSession[]>;          // listSessions({ includeProgrammatic: true }) → map (title = summary; nulls for missing optionals)
  rename(id, title) / fork(id): Promise<{ sessionId }> / deleteTranscript(id) / listSubagents(id);   // thin SDK calls
  transcriptPath(id): Promise<string | null>;           // <configDir>/projects/<encoded cwd>/<id>.jsonl — resolved by scanning the project dirs for `<id>.jsonl` (the SDK exposes no path API); used by Reveal
  start(): void; dispose(): void;
}
```
- `configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')` (computed once in `setupClaude`, passed in, and shown in `ClaudeState.configDir`).
- Watch: `fs.watch(join(configDir,'projects'), { recursive: true })` → 250 ms debounce → `onChange()`. If the directory does not exist, poll `existsSync` every 30 s and start the watch when it appears (fresh machines). If `fs.watch` throws, fall back to a 30 s re-list poll. Log `claude-watch { mode: 'watch'|'poll'|'waiting', events }` (counts only). Watcher errors → restart once after 5 s, then poll.
- The SDK is loaded lazily on the first `list()` via `loadSdk()`; a load failure surfaces as `status: 'error'` with the message (not the path).

### 4.2 `src/main/claude/registry.ts` — `ClaudeRegistryStore`
`userData/claude-sessions.json`; `load()` with `ClaudeRegistrySchema.safeParse` (invalid → `emptyRegistry()` + `claude-registry-load-error`), `save(reg)` = write `claude-sessions.json.tmp` then `renameSync` (atomic; `claude-registry-save-error` on failure). Saves are debounced 200 ms and flushed in `dispose()`.

### 4.3 `src/main/claude/sessions.ts` — `ClaudeSessions` controller (the `cloudSessions.ts` analogue, ~⅓ the size: no sockets/tokens/cache)
- Holds `registry`, last `storeSessions`, `status`, `lastError`, `showArchived` (persisted via `state.settings.merge({claude:{showArchived}})`).
- `refresh(source)`: coalesced (in-flight + one dirty follow-up); `store.list()` → `reconcile(registry, list, { now, autoArchiveDays })` → save if `changed` → `emit()` (= `applyLayout()`, which calls `notifyShell`). Log `claude-list { count, ms, source }`.
- `snapshot(): ClaudeState` — filters archived unless `showArchived`; never includes `removed`.
- Mutations: `open(id)` (sets `state.claudeSessionId`, `touchOpened`, `applyLayout`, log `claude-select {sessionId}`), `rename` (SDK `renameSession` then refresh — the watcher will also fire), `fork` (SDK → new id → copy folder/pin from the source entry → `open(newId)`), `sessionMove/Pin/Archive/Remove`, `deleteTranscript` (confirm → SDK `deleteSession` → `setRemoved`-free: the entry is simply dropped → `forget(id)`), `revealTranscript` (`shell.showItemInFolder(path)`), folder ops. Every mutation: try/catch → `lastError {op, message}` cleared on the next successful refresh; log `claude-mutate { op, ok }` only. In test mode, record `{op, payload-without-titles}` in `mutations` for the `claudeMutations()` hook (mirror `cloudMutations`).
- `forget(id)` (after remove/delete): `state.claudeSessionId === id → null`; `state.tabManager?.closeScope(claudeScope(id))`; `applyLayout()`.
- `contextMenu(arg)`: same shape/test seam as `cloudSessions.contextMenu` (ids `m0…`, `menuItems()`, `clickMenuItem(id)`, `pendingAction`). Items — header: *Show archived sessions* (checkbox), *Refresh*. Folder: *Rename…* (`action:'rename'`), *Delete…*. Session: *Rename…* (`action:'rename-session'`, inline editor in the row), *Fork*, separator, *Move to folder* (submenu: folders as checkboxes, *Remove from folder*, *New folder…* → `action:'new-folder'`), *Pin/Unpin*, *Archive/Unarchive*, separator, *Reveal transcript*, *Copy session id*, separator, *Remove from list*, *Delete transcript…*.
- Settings changes: `claude.autoArchiveDays` change → `refresh('settings')`; `claude.path` change → recompute `cliPath = resolveClaudePath(path)`.

### 4.4 Wiring
- `src/main/claude/ipc.ts`: `setupClaude()` creates the store/registry/controller, registers the channels with `guardedHandle`/`guardedOn` (payload zod → `LocalResult`-style `{ok,value|error}` for invokes, like `local/ipc.ts`'s `handle()` helper — extract that helper to `ipcGuard.ts` as `handleResult` rather than copying it). Called from `main/index.ts` after `setupLocal()`; `claudeSessions().dispose()` in shutdown next to `localHost()?.dispose()`.
- `state.ts`: `claudeSessionId: null as string | null`.
- `window.ts`: `layoutState().sessionsOpen` true on `cloud || claude`; `beginDrag('s')` allowed on `claude`; `syncScope` passes `state.claudeSessionId`; `publicState()` adds `claude: claudeSessions().snapshot()` and `claudeSessionId`. `applyLayout`/`lowerShell` unchanged (no hosted view on `claude`).
- `shortcuts.ts`: Ctrl+Shift+S toggles the column on `claude` too.
- `main/settings.ts` `syncFromState`: nothing new (selection is not persisted in Phase 1; restore of `surface: 'claude'` already works through `SurfaceSchema`). Record `claudeSessionId` persistence as a Phase 2 item (alongside history loading).
- Test hooks: `claudeState()`, `claudeRefresh()`, `claudeSelect(id)`, `claudeMenuItems()`, `claudeMenuClick(id)`, `claudeMutations()`, `claudeConfigDir()`.
- Log events (ids/counts only): `claude-sdk-load`, `claude-list`, `claude-watch`, `claude-select`, `claude-mutate`, `claude-registry-load-error`, `claude-registry-save-error`, `claude-menu` (kind only).

### 4.5 e2e (PR 3, hook-driven; the sidebar spec comes in PR 4)
`tests/fixtures/claude-home/` — a fixture `CLAUDE_CONFIG_DIR` tree: `projects/C--work-alpha/<uuid-a>.jsonl` (4 lines: `user`, `assistant`, `custom-title` → title "Alpha custom"), `projects/C--work-alpha/<uuid-b>.jsonl` (ai-title via `summary` line), `projects/C--work-beta/<uuid-c>.jsonl` (no title → first prompt). Build them by copying a short real transcript, scrubbing text, and verifying with `claude:store-probe` under `CLAUDE_CONFIG_DIR=<fixture>` that all three list with the expected titles — commit the verified files. `tests/e2e/helpers.ts`: `launchApp` accepts env; specs copy the fixture tree into the temp profile and set `CLAUDE_CONFIG_DIR` to the copy (never the committed tree — tests write into it).
`tests/e2e/claudeRegistry.spec.ts`: (1) `claudeState()` reaches `status:'ready'` with 3 sessions and the expected title precedence; (2) copy a 4th jsonl into the tree while running → listed within 1 s (`expect.poll` 1000 ms); (3) `claudeMenuClick` Pin + Move to a created folder → relaunch with the same profile → still pinned/foldered (reads `claude-sessions.json` too); (4) Remove from list hides; appending a line to that jsonl (newer mtime) brings it back; (5) Delete transcript (test mode = confirmed) removes the file and the entry; (6) `autoArchiveDays` via settings → an old fixture (mtime set with `utimes`) flips to archived and `showArchived` reveals it; (7) selecting sets `currentScope()` to `claude:<id>`.

## 5. PR 4 — shell

### 5.1 Sidebar extraction (`src/shell/components/sidebar/`)
Move out of `SessionSidebar.tsx` without behaviour change: `FolderNameInput`, `PrBadges` (+ `PR_BUCKETS`), `SessionRow` (generic over `SidebarSession`; the Cloud-specific bits — status dot colour, `data-unread`, `data-live`, prefetch handlers, `onOpen` — arrive as props/render callbacks), `SectionHeader` (collapse, drag/drop targets, rename editor, optional "new in folder" button via prop), `useRowKeyboardNav` (ArrowUp/Down + Ctrl+C callback), `dnd.ts` (`SESSION_MIME`, `FOLDER_MIME`, `isEditableFolder`, `SECTION_LABELS`), `useOptimisticList` (the override/reset-on-sync pattern). `SessionSidebar.tsx` becomes a composition of these over `state.cloud`. Gate: **`cloudSessions.spec.ts`, `cloudViews.spec.ts`, `sessionTabs.spec.ts` pass unmodified** — the DOM ids/data attributes are the contract.

### 5.2 `ClaudeSidebar.tsx`
Composes the shared pieces over `state.claude` + `claude*` IPC. Header: title "Claude", `#sessionFolderNew`, `#claudeRefresh`, `#sessionsMenu`; `#claudeStatus` shows `ready · N sessions · synced <rel>` / `Loading…` / the error; `lastError` line as Cloud. Row extras: meta = cwd basename (`title` attr = full cwd) · branch · relative time; `tag` chip; `data-missing`, `data-pinned`, `data-cwd` attributes; inline rename editor (`#sessionRenameEdit`) when the menu returns `rename-session`. Filter matches title or cwd. Drag/drop: sessions into folders/recent, folder reorder (same MIME types). Empty states: "No Claude Code sessions found in <configDir>" when ready & empty; "Claude Code CLI not found — set the path in Settings" banner when `cliPath === null` (informational; the list still works).

### 5.3 Surface plumbing
- `App.tsx`: `sessionsOpen` gate becomes `surface === 'cloud' || surface === 'claude'`; render `ClaudeSidebar` in `bounds.sessions` and `ClaudeView` in the main rect on `claude`.
- `Rail.tsx`: `#claudeButton` between Local and Analytics (lucide `Sparkles` or `MessageSquare`, label "Claude").
- `src/shell/claude/ClaudeView.tsx`: placeholder main column — selected session's title, cwd, branch, created/last-modified, id (copy button), and "Chat and terminal for Claude sessions arrive in a later update"; no selection → "Select a session". `data-claude-view` root for e2e.
- Settings → General: "Claude Code path" field (`#claudePathInput`, same validation/not-found pattern as `devinPath`: non-empty and missing → inline error from `cliPath === null` state) and "Auto-archive Claude sessions idle for N days (0 = off)" (`#claudeAutoArchiveInput`). `#sessionsColumnToggle` label → "Show the sessions column (Cloud and Claude)". Draft/commit through the existing `settingsDraft` machinery (`settingsDraft.test.ts` case for the new fields).

### 5.4 e2e `tests/e2e/claudeSessions.spec.ts`
Launch with the fixture tree and `DEVIN_WORKSPACES_TEST_SESSIONS_OPEN=1`; `setSurface('claude')`; assert: `[data-sidebar="claude"]` present and `getSessionsBounds()` non-null; 3 rows with expected titles/`data-cwd`; filter by cwd basename narrows to 2; context menu via `claudeMenuItems/claudeMenuClick` — Pin → Pinned section appears; New folder (inline `#sessionFolderEdit`) + Move → folder section; rename-session → `#sessionRenameEdit` → title updates after the watcher fires (≤ 2 s); Show archived toggles an archived row's visibility; clicking a row → `data-claude-view` shows its title and `currentScope()` is `claude:<id>`; switching to `cloud` → scope reverts, column still open; Settings General fields round-trip into `settings.json`. Add `claude` to `shell.spec.ts`'s rail/surface cycling assertions.

### 5.5 Docs
README: intro bullet, "Claude sessions" section (sidebar, folders/pin/archive, remove vs delete, auto-archive, Claude path setting, where `claude-sessions.json` lives, `CLAUDE_CONFIG_DIR` note). AGENTS.md: surfaces list, env/test hooks (`claudeState`…), log events, `CLAUDE_CONFIG_DIR` behaviour, packaging rules from §1 (platform packages excluded, unpacked set, size gate), probe scripts. Smoke `installed.spec.ts` userData list += `claude-sessions.json` (created on first mutation only — assert absence on fresh, presence after a hook-driven pin).

## 6. Order, verification, and what is **not** in Phase 1
- PR 1 → PR 2 → PR 3 → PR 4; each is one commit on `main` after review (no push).
- Verification per PR: `npm run typecheck && npm run test:unit && npm run build`; PR 1 also `dist:win` + `smoke:install` + `claude:store-probe`; PR 3/4 `npm run test:e2e` (full suite — the sidebar extraction and `effectiveScope` change touch shared code).
- Not in Phase 1: chat/SDK host, terminal tab, hooks/notifications, subagent rows, New session, Open in terminal, PR badges from Claude output, selection persistence across restart, Cloud ↔ Claude drag between surfaces.
