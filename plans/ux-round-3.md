# UX round 3 — reorder everywhere, Devin Cloud tab, picker start folder, store passthrough, analytics check

Status: Planned — awaiting go

Reports from testing the round-2 + analytics builds, plus one hazard found while investigating them. Four
code streams run in parallel after one small contracts commit; the analytics item is a verification pass.

## 0. Findings that shape the plan

- **Session reordering never existed anywhere.** `buildSessionTree` sorts roots `byUpdatedDesc` in every
  section (`src/core/sessionTree.ts:82,101`); session rows are `draggable` (`SESSION_MIME`) only so they can be
  dropped on a *folder header* to move between folders (`SectionHeader.onDrop`). Round 2 disabled that drop
  for path-bound workspaces (D7 `moveDisabled`), so on Local and Claude a session drag now does nothing at
  all. Cloud has the between-folder move and no in-folder reorder either.
- **Workspace (folder) header drag-reorder works on current `main`** — verified with genuine OS-level
  pointer input (`SendInput`, not CDP), not just the synthetic DragEvent helper: Local header B→A fires
  `dragstart → dragover(preventDefault) → drop → dragend` with `dataTransfer.types =
  ['application/x-devin-folder']`, logs `local-workspace-reorder`, and the DOM + `settings.workspaces`
  order flip; the Cloud sidebar (same `SectionHeader`) reorders too, and Claude uses the identical
  `WorkspaceSidebar` path. The installed build (below) has `SectionHeader` but no `WorkspaceSidebar` at
  all — its headers are `draggable` yet nothing handles the drop, which looks exactly like "drag does
  nothing". The round-2 dev run on the 20th can't be told apart in the log (one workspace, no reorder
  attempt), so folder reorder is a **verification + hardening** item (S1b), not a rewrite.
- **"Devin Cloud" rows in General today:** Tenant URL, API base, Cloud sessions kept loaded, Keep hidden
  Cloud sessions live. The two *GitHub pane* rows (Keep hidden tabs live, Max live tabs) are **not**
  Cloud-specific: tab scopes exist per Cloud, Local *and* Claude session (`src/main/tabs.ts setScope`,
  `local/prAutoOpen.ts`, Claude PR tabs), so they stay in General. Truly general too: sessions-column
  toggle, Shell command, Hosts. `DRAFT_TAB` (`src/core/settingsDraft.ts`) already routes validation errors
  to a tab, so the move is a table edit plus a new tab component.
- **Folder pickers today:** Local has one — *Add workspace* (`src/main/local/ipc.ts:101`); Claude has two —
  *New session* with no workspace (`src/main/claude/sessions.ts:677`) and *Add workspace*
  (`sessions.ts:762`). All three start in the configured default WSL distro's home when one is set,
  otherwise wherever the OS dialog last was. There is no user-chosen start folder.
- **Analytics Claude tab:** the build that was tested did not contain it. Evidence from the shared
  profile log (`%APPDATA%\devin-workspaces\events.1.jsonl`): the 13:39–13:44 run that produced the
  `claude-workspace-add` event (so a round-2 build) opened Analytics at 13:43:07 and logged only
  `analytics-view-created` / `analytics-refresh` — no `usage-fetch` / `usage-scan` / `usage-cache-load`,
  which `src/main/claude/usage.ts` emits unconditionally when the Claude tab exists. The installed app
  (`%LOCALAPPDATA%\Programs\Devin Workspaces`, exe dated Oct 6, running since 13:45) predates round 2
  entirely: its `app.asar` contains neither `claudeWorkspaces` nor `analyticsTab`. #79 merged after that
  test. So item 4 is "verify on a current build" (S4).
- **Stores strip what they don't know.** `settings.json` is parsed with plain `z.object` at every nesting
  level (unknown keys removed), `parseSettingsFile` additionally *drops* a known key whose value fails
  validation (logged `settings-repaired` — e.g. `surface: 'claude'` on a build that predates the Claude
  surface), and `save()` serialises only the in-memory object. The old installed build did exactly this to
  the shared profile: `settings.json` now has no `claude` block, so the workspace added at 13:41 is gone.
  Same pattern in `claude-sessions.json` (`ClaudeRegistrySchema.safeParse` → `JSON.stringify(registry)`),
  `local-sessions.json`, `notifications.json`, `pr-ledger.json`. Caches that are rebuilt from their
  source (`cloud-cache.json`, `claude-usage-cache.json`, `prs.json`, `identity.json`) are exempt;
  `credentials.json`/`secrets.json` are encrypted blobs with their own format.

## 1. Contracts (S0 — serial, tiny, on the integration branch first)

Everything the streams share, so they never touch the same lines afterwards.

| Key | Type | Default | Used by |
|---|---|---|---|
| `local.sessionOrder` | `Record<sectionKey, sessionId[]>` (`z.record(z.string().max(1024), z.array(z.string().max(128)).max(500))`) | `{}` | S1 |
| `claude.sessionOrder` | same shape | `{}` | S1 |
| `sessions.sessionOrder` | same shape (Cloud) | `{}` | S1 |
| `local.pickerFolder` | `string \| null` — where Local's folder picker starts | `null` | S3 |
| `claude.pickerFolder` | `string \| null` — where Claude's folder pickers start | `null` | S3 |
| `SettingsTabId` | add `'cloud'` | — | S2 |
| `SettingsDraft` | add `localPickerFolder: string`, `claudePickerFolder: string` (`''` = unset); `DRAFT_TAB` rows `'local'` / `'claude'` | — | S3 |
| `DRAFT_TAB` | `tenantUrl, apiBase, sessionsMaxLiveViews, sessionsKeepAliveHours` → `'cloud'` | — | S2 |

`sectionKey` = the section's `name` as `buildSessionTree` emits it: a workspace path / Cloud folder name for
`folder` sections, `pinned`, `recent`, `participated` for the system sections.

IPC (schema + preload in S0; handlers in the streams): `localSessionReorder {section, ids}`,
`claudeSessionReorder {section, ids}`, `cloudSessionReorder {section, ids}`,
`dialogPickFolder {title, defaultPath?} → string | null` (generic folder dialog for the Browse buttons).

Log events: `local-session-reorder`, `claude-session-reorder`, `cloud-session-reorder` (all `{section:
'folder'|'pinned'|'recent'|'participated', count}`), `store-preserved {store, keys}` (S6).

Gate: tsc · lint · unit · build · `settings.spec` + `claudeSessions.spec` + `local.spec` + `cloudSidebar`
specs still green (nothing visible changes yet).

## 2. S1 — drag to reorder sessions in every section (Local, Claude, Cloud) + header reorder hardening

Design (D1): manual order is **per section, captured in full at drop time**. On drop we write the complete
id list of that section's root rows; at render time `buildSessionTree` lists sessions *not* in the stored
list first (newest first, as today — so a brand-new session still appears at the top), then the stored ids
in stored order, skipping ids that no longer exist. A section with no stored order behaves exactly as
today. Every section is reorderable (D4): workspace/user folders, Pinned, Recent, Participated. Only root
rows reorder — Claude subagent children stay under their parent. Cross-section row drops are refused: on
Local/Claude because of D7, on Cloud because "move to folder" already exists on the header and mixing the
two gestures in one drop makes the indicator ambiguous.

Pieces:
- `core/sessionTree.ts`: `buildSessionTree(data, { …, sectionOrder?: Record<string, string[]> })` applied
  to every section kind; pure `reorderSection(ids, draggedId, targetId, place: 'before'|'after')`; unit
  tests (unknown ids dropped, new sessions first, drag onto self no-op, drop after last, pinned section).
- `sidebar/ReorderableRow.tsx` (new): wraps a root row; handles `dragover`/`drop` for `SESSION_MIME` using
  a module-level "current drag" record `{ id, section }` set from a `dragstart` listener on the wrapper
  (dataTransfer payloads are unreadable during `dragover`); `data-drop-before` / `data-drop-after`
  indicator (2 px border, the folder indicator colour). Used by **both** `WorkspaceSidebar` (default
  `SessionRow` and Claude's `renderRow` output) and `SessionSidebar` (Cloud).
- `WorkspaceSidebar` / `SessionSidebar`: new props `sessionOrder`, `onReorderSessions(section, ids)`; order
  goes through `useOptimisticList` like folder reorder, so the row moves before the settings round-trip.
- Adapters: Local (`shell/local/LocalSidebar.tsx`, `main/local/ipc.ts`), Claude (`ClaudeSidebar.tsx`,
  `main/claude/ipc.ts` + `sessions.ts`), Cloud (`SessionSidebar.tsx`, `main/ipc.ts` next to the folder
  handlers). Each handler merges `<surface>.sessionOrder[section]`, republishes, logs. Removing a
  workspace / deleting a Cloud folder deletes its key; deleted sessions need no cleanup (skipped on read).
- e2e: one case each in `local.spec`, `claudeSessions.spec`, `cloudSidebar.spec` using the synthetic DnD
  helper (`tests/e2e/helpers.ts:631`): three sessions, drag the third above the first → DOM order changes
  immediately, `settings.json` carries the list, relaunch preserves it, a new session lands above; the
  Claude case also reorders inside Pinned.

### S1b — workspace header reorder: verify + harden

- `SectionHeader`: `draggable` only when the header can actually be reordered (`onReorder` wired and more
  than one editable folder) — a lone or non-reorderable header offers no ghost drag.
- Real-pointer e2e (`page.mouse` down/move/up — the probe showed it drives Chromium's native DnD here) for
  header reorder on Local and Claude, in the headed-opt-in group next to `tabstrip.spec` (native DnD needs
  an activated window). The synthetic-event cases stay as the fast default-path tests.
- Manual check on the fresh `dist:win` (S4 step 2) with ≥2 workspaces per column incl. a
  `\\wsl.localhost\…` one; recorded in the PR.

Owned files: `src/core/sessionTree.ts`, `src/shell/components/sidebar/{WorkspaceSidebar,SectionHeader,
ReorderableRow,dnd}.tsx|ts`, `src/shell/components/SessionSidebar.tsx`, `src/shell/local/LocalSidebar.tsx`,
`src/shell/components/ClaudeSidebar.tsx`, `src/main/local/ipc.ts`, `src/main/claude/ipc.ts`,
`src/main/claude/sessions.ts`, `src/main/ipc.ts` (cloud reorder handler only), `tests/unit/sessionTree*`,
the three specs.

## 3. S2 — "Devin Cloud" settings tab

- New `settings/CloudTab.tsx` holding the four moved rows verbatim (same element ids so existing specs keep
  working: `#tenantUrlInput`, `#apiBaseInput`, `#sessionsMaxLiveViews`, `#sessionsKeepAliveHours`). Hints
  unchanged.
- `SettingsTabs.tsx` order: General · **Devin Cloud** · Devin Local · Claude Code · Link Handling ·
  Passwords · Notifications · Updates. `SettingsPanel.tsx` renders the new tab.
- `GeneralTab.tsx` keeps: GitHub pane (keep-alive hours, max live tabs — relabel the group "GitHub pane"
  so it's clear they apply to every surface), sessions-column toggle, Shell command, Hosts.
- Error routing: a bad tenant URL committed from another tab lands on the Cloud tab (`DRAFT_TAB` does this
  once S0 flips the rows — add a `settings.spec` assertion).
- e2e: `settings.spec` cases that open General and type into the moved inputs switch to the Cloud tab
  first. Docs: README settings section.

Owned files: `src/shell/components/settings/{GeneralTab,CloudTab,SettingsTabs}.tsx`,
`src/shell/components/SettingsPanel.tsx`, `tests/e2e/settings.spec.ts` (+ any spec reaching the moved
inputs via General), README.

## 4. S3 — where the folder picker starts (Local + Claude)

Design (D2): a per-surface **start folder** for the OS folder dialog — nothing is auto-selected; the
dialog just opens there.

- `local.pickerFolder` → Local *Add workspace* dialog. `claude.pickerFolder` → Claude *New session* (no
  workspace) and *Add workspace* dialogs. Precedence: explicit folder if set and it still exists → else the
  default-WSL-distro home (today's behaviour) → else OS default. A folder that no longer exists is skipped
  (logged `picker-folder-missing`), not cleared.
- UI: on *Devin Local* and *Claude Code* tabs, a text field "Folder pickers start in" with a **Browse…**
  button (uses `dialogPickFolder`, starting in the current value) and a Clear affordance (blank = unset).
  Validation: blank or an absolute path (`\\wsl.localhost\…` UNC allowed); relative paths error on the tab.
- e2e: the dialog can't be driven, so the test seam is the existing one — `showOpenDialog` options are
  observable through a test hook `__devinworkspaces.lastOpenDialogOptions()` (added in S0 alongside the
  IPC): set `local.pickerFolder` via Settings, trigger *Add workspace* with
  `DEVIN_WORKSPACES_TEST_PICKER_CANCEL=1` (new test-mode var: dialog returns canceled immediately), assert
  `defaultPath` equals the setting; same for Claude *New session* with `DEVIN_WORKSPACES_TEST_CLAUDE_NEW_CWD`
  unset. Missing-folder fallback case asserts the distro-home `defaultPath` instead.

Owned files: `src/shell/components/settings/{LocalTab,ClaudeTab,fields}.tsx`, `src/core/settingsDraft.ts`
(draft↔settings mapping for the two fields), `src/main/local/ipc.ts` (picker options),
`src/main/claude/sessions.ts` (both pickers), `src/main/testHooks.ts`, the two specs, README/AGENTS env table.

Overlap with S1: `src/main/local/ipc.ts`, `src/main/claude/sessions.ts` and the two specs — different
functions/cases, additive. Integration merges S1 first, S3 second.

## 5. S4 — Claude analytics: verify on a current build

No code change expected. Work item:
1. Build `main` (post-#79), launch it against the real profile in quiet mode (same throwaway-spec approach
   as the pre-merge check), open Analytics → Claude tab; attach a screenshot and the `usage-fetch` /
   `usage-scan` log lines as evidence.
2. `npm run dist:win` from the integration branch once S1–S3/S6 are in and install it, so the desktop runs
   a build that contains round 2 + analytics — otherwise the same reports recur.
3. If step 1 shows an empty Claude tab anyway, that becomes a bug stream with the log evidence.

## 6. S6 — stores preserve unknown data across upgrade/downgrade

Rule: **a build may only rewrite what it understands; everything else in the file comes back out exactly
as it went in.** Applies to the user-data stores: `settings.json`, `claude-sessions.json`,
`local-sessions.json`, `notifications.json`, `pr-ledger.json`. Caches rebuilt from source are exempt (§0).

Design (D5):
- One pure helper in `src/core/storePreserve.ts`: `overlayKnown(raw, parsed, structural)`. Walks `parsed`;
  for keys marked *structural* (objects whose children are individually schema'd — `routing`, `pane`,
  `local`, `tabs`, `notifications` (+ `kinds`), `prs`, `layout`, `terminal`, `sessions`, `claude`, `hosts`,
  `analytics`) it recurses so unknown nested keys survive; for everything else (scalars, arrays, records
  like `workspaceLabels`, `overrides`, `windowPlacements`, registry `entries`) it writes the parsed value
  wholesale, because for those "absent" is a legitimate deletion. Unknown top-level and nested keys from
  `raw` are carried through untouched. A unit test introspects the zod schema and fails if the structural
  list drifts from the set of `ZodObject` fields.
- **Invalid-but-known values are preserved, not repaired away:** `parseSettingsFile` keeps returning the
  default in memory for a key that fails validation, but the store remembers the raw value and writes it
  back unless that key was *changed in this run* (tracked per top-level + structural path by `merge()`
  and `syncFromState()`). So an old build that doesn't know `surface: 'claude'` runs on `cloud` and leaves
  the file saying `claude`, unless the user actually switches surface. `settings-repaired` keeps logging,
  with `preserved: true`.
- `SettingsStore` keeps `raw` (the parsed JSON as read) and `touched`; `save()` writes
  `overlayKnown(raw, value, STRUCTURAL)` with the untouched-invalid keys restored, then replaces `raw` with
  what it wrote. Same shape for `ClaudeRegistryStore` (structural: root + per-entry objects, so a newer
  build's extra per-session fields survive an older build editing the same registry), the Local session
  index, notifications (array of objects: per-item overlay keyed by `id`), PR ledger.
- Legacy *intentional* strips stay intentional and explicit: the P4b Claude `folders` migration and the
  `hosts.defaultWslDistro` → per-surface move already delete their source keys on purpose after migrating;
  they must do so by name, after the overlay, with a `settings-migrated` log — the helper never deletes.
- Tests: unit (round-trip of a file with unknown top-level, nested and per-entry keys; invalid known value
  preserved when untouched, overwritten when touched; records replaced wholesale) and one e2e: write a
  `settings.json` with a fake future block `{"future": {"x": 1}, "claude": {"futureField": true}}`, launch,
  change a setting, quit → both survive, `store-preserved {store:'settings', keys:[...]}` logged.
- Docs: AGENTS "Layout & settings" gets the rule; the smoke spec's upgrade phase gains the same fake-future
  check (it already reads `settings.json` directly).

Owned files: `src/core/storePreserve.ts`, `src/core/settings.ts`, `src/main/settings.ts`,
`src/main/claude/registry.ts`, `src/main/local/acpHost.ts` (index load/save only), `src/main/notifications.ts`,
`src/main/prLedger.ts`, `tests/unit/storePreserve*`, `tests/e2e/settings.spec.ts` (one new case),
`tests/smoke/installed.spec.ts`, AGENTS.

No overlap with S1–S3 (they add schema keys in S0 and never touch the store classes).

## 7. Out of scope / follow-ups

- Session drag *between* workspaces stays off (D7): a Local/Claude session belongs to its cwd.
- A "default workspace for New session" (skip the picker entirely) — not asked for; the picker start folder
  covers the request. Easy to add on top of S3 later.

## 8. Execution

```
S0 contracts  (integration branch, serial, sidekick, lead reviews)
 ├─ S1 reorder everywhere + header hardening   worktree ux3-reorder    (largest; sidekick)
 ├─ S2 Devin Cloud tab                         worktree ux3-cloudtab   (subagent)
 ├─ S3 picker start folder                     worktree ux3-picker     (subagent)
 └─ S6 store passthrough                       worktree ux3-preserve   (subagent)
S4 analytics verification runs alongside (lead), evidence only
S5 integration: merge S6 → S1 → S3 → S2, docs, full e2e + smoke:install (schema changed), dist:win + install
```

Branches: `feat/ux3-integration` off `main`; stream branches off the S0 commit. Test runs use the
quiet-window branch (`fix/quiet-tests`, PR open) merged into the integration branch so the suite doesn't
take over the desktop; if that PR lands first it's a no-op merge.

Gate per stream: tsc · lint · unit · build · the stream's specs. Final gate: full e2e (quiet) +
`smoke:install` (incl. the new fake-future check) + the S4 screenshot + the S1b manual check on the
installed build.

## 9. Decisions

- **D1** new sessions appear *above* a manually ordered list. (confirmed)
- **D2** the setting is where the folder *picker starts*; nothing is auto-selected. (confirmed; replaces the
  earlier "default workspace" idea)
- **D3** General keeps the two GitHub-pane rows — they apply to Cloud, Local and Claude tab scopes alike;
  only the four Cloud-only rows move. (corrected after checking `tabs.ts`)
- **D4** every section is reorderable — workspace/user folders, Pinned, Recent, Participated — on Local,
  Claude and Cloud. (confirmed; Cloud added)
- **D5** store passthrough: unknown keys preserved recursively through structural objects; records/arrays
  replaced wholesale; invalid-but-known values written back unless changed in this run; only named
  migrations may delete. Applies to the five user-data stores, not to rebuildable caches.
