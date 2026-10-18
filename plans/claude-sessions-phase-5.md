# Phase 5 — Claude PRs in the PR panel, sidebar PR badges, final docs

Technical plan for Phase 5 of `plans/claude-sessions.md`. Based on `main` after Phase 4. Three concurrent streams (core / main / shell+README) against the §1 contracts, then one integration pass (full e2e + isolated smoke).

## 0. Decisions

| Question | Decision |
|---|---|
| Where Claude PRs come from | Every PR URL the app already detects for a Claude session — chat `LinkScanner` (host), claude-pty output (terminalHost), `PostToolUse gh pr` hook — is **recorded in the registry entry** (`entry.prs`) in addition to the existing auto-open. One funnel: `claudeSessions().recordPr(sessionId, url, source)`. |
| PR state | Claude has no API for PR state, so it is read from the GitHub PR page we already fetch for the title: `parsePrState(html)` (`open` / `draft` / `merged` / `closed`, null when not recognisable). The title cache becomes a title+state cache. Claude PRs whose state is unknown count as open. |
| State refresh cadence | Title/state entries for **Claude** PRs that are not merged/closed are refreshed every 10 min while the window is focused or the PR panel is open (existing concurrency cap 3); merged/closed are final (6 h as today). Devin PRs keep today's behaviour (state comes from the API). |
| Panel list | `openPrs()` = Devin open PRs (unchanged) **+** Claude open PRs (`claudeOpenPullRequests()`): `SessionPrLink { sessionId, sessionTitle (sidebar title), ref: prTitle(url), url, state, source: 'claude' }`, newest-recorded first, from **non-removed, non-missing** sessions (archived included — a merged PR on an archived session still matters until it leaves the open list). `PrStore.reconcile` receives the merged list, so read/dismiss records work identically. |
| Opening | `openPr(sessionId, url)`: main looks the URL up in the merged list; `source === 'claude'` → the same routing as Claude notifications (surface `claude`, `claudeSessions().open(id)`, tab in `claude:<id>` scope). |
| `pr-completed` | When a recorded Claude PR's state flips to merged/closed → one `pr-completed` notification (`source: 'claude'`, gated by `notifications.kinds.prCompleted`), the entry keeps the PR with its final state (`completedAt` set, so it's notified once), and it drops out of the open list. |
| Sidebar badges | `ClaudeSessionState.prs` counts come from `entry.prs` states (`open` incl. unknown, `draft`, `merged`, `closed`; `queued` always 0) — the shared `PrBadges` component renders them without changes. |
| Registry schema | `ClaudeRegistryEntry.prUrls: string[]` → `prs: { url, state: 'open'\|'draft'\|'merged'\|'closed'\|null, seenAt, completedAt: number\|null, source: 'chat'\|'terminal'\|'hook' }[]` (max 20 per session, oldest dropped). `ClaudeRegistry.version` stays `1` — the zod schema accepts both shapes: `prUrls` strings are migrated to `prs` items on load (`state: null, seenAt: 0`). |
| Polish | `TerminalView` restart label already per kind (Phase 3). Subagent rows, fork-from-chat and stream-delta message ids stay deferred and are listed in the README "Known limitations" so expectations are set. |

## 1. Contracts (lead-authored, land first)

- `src/core/notifyModel.ts`: `SessionPrLink.source?: 'devin' | 'claude'`.
- `src/shared/ipc.ts`: `SessionPrSchema.source: z.enum(['devin','claude']).default('devin')`.
- `src/core/prTitle.ts`: `export type PrState = 'open' | 'draft' | 'merged' | 'closed'; export function parsePrState(html: string): PrState | null` (core stream implements; signature fixed here).
- `src/core/claudeRegistry.ts` (core stream implements; signatures fixed here):
  ```ts
  export type ClaudePrState = 'open' | 'draft' | 'merged' | 'closed';
  export interface ClaudeRegistryPr { url: string; state: ClaudePrState | null; seenAt: number; completedAt: number | null; source: 'chat' | 'terminal' | 'hook' }
  // ClaudeRegistryEntry.prs: ClaudeRegistryPr[]   (replaces prUrls)
  export const MAX_PRS_PER_SESSION = 20;
  export function recordPr(reg, id, url, source, now): { registry: ClaudeRegistry; added: boolean };
  export function setPrState(reg, id, url, state: ClaudePrState | null, now): { registry: ClaudeRegistry; completed: boolean };  // completed=true exactly once when state becomes merged|closed and completedAt was null
  export function prCountsFor(entry: ClaudeRegistryEntry | undefined): SessionPrCounts;
  export function openPrsOf(reg): Array<{ sessionId: string; pr: ClaudeRegistryPr }>;   // non-removed entries, state not merged/closed, newest seenAt first
  ```
- `src/main/prTitles.ts` (main stream): `getInfo(url): { title: string | null; state: PrState | null } | null`, `ensure(urls, opts?: { maxAgeMs?: number })`, `onChange?: () => void` hook so the panel/sidebar re-render when a fetch lands.
- Test hooks: `claudeRecordPr(sessionId, url)`, `claudePrs(sessionId)`, `prTitlesSeed(url, { title, state })` (test-mode cache seed so e2e can flip a state without GitHub).

## 2. Core stream
- `prTitle.ts`: `parsePrState` — recognise GitHub's PR header: `class="State State--merged"` / `State--open` / `State--closed` / `State--draft` (also `title="Status: Merged"` etc.) within the first 256 KB; `reviewable`/comment states ignored. Unit tests with representative snippets for all four + null.
- `claudeRegistry.ts` per §1: schema accepts legacy `prUrls` (migrated) and new `prs`; `recordPr` dedupes by URL (touches `seenAt`), caps at 20 (drop oldest non-completed first); `setPrState`; `prCountsFor`; `openPrsOf`; `reconcile` fills each row's `prs` from `prCountsFor(entry)` (missing-transcript rows too). Tests: migration, dedupe/cap, `completed` exactly once, counts mapping (unknown → open), `openPrsOf` ordering/exclusions, reconcile carries counts.
- `notifyModel.ts`: no logic change beyond the contract field.

## 3. Main stream (sidekick)
- `prTitles.ts`: cache `{ title, state, fetchedAt }`, `parsePrState` on the same HTML, `getInfo`, `ensure(urls, { maxAgeMs })`, `onChange` (debounced `notifyShell`). Log `pr-title` gains `state` (enum only).
- `sessions.ts`: `recordPr(id, url, source)` (registry `recordPr` → save → emit → `prTitles.ensure([url])`); `claudeOpenPullRequests(): SessionPrLink[]` from `openPrsOf` + sidebar titles + `getInfo(url)?.state`; `refreshPrStates(reason)` every 10 min while focused / when the PR panel opens: `ensure(openClaudeUrls, { maxAgeMs: 10 min })`; on each cache change → `setPrState` for changed states → `completed` → `notificationStore().add({ kind: 'pr-completed', source: 'claude', … prState })` (respect `collect` + `kinds.prCompleted`) → save/emit. Funnel every existing PR path (host `onPullRequestUrl`, hook `prUrls`, and `index.ts`'s terminal handler for `source === 'claude-terminal'` — parse the session id from the `claude:` scope) through `recordPr` **before** `autoOpenLocalPr`.
- `notifier.ts`: `allOpenPullRequests()` = `openPullRequests(state.apiSessions)` (source devin) + `claudeSessions().claudeOpenPullRequests()`; `openPrs()` and `unreadPrCount`/`openPrCount` in `publicState()` and `PrStore.reconcile` (after every poll **and** after every Claude recordPr/state change) use the merged list; `openPr(sessionId, url)` routes by `source`. Make sure `reconcile` is also triggered when there is no Devin poller running (no token) — Claude PRs must work standalone.
- `ipc.ts`/`testHooks.ts`: hooks per §1.
- e2e `tests/e2e/claudePrs.spec.ts`: fixture tree + fake SDK: (1) `claudeRecordPr(A, <fixture PR url>)` → `#prsPanel` row `[data-pr-url][data-source="claude"]` with the sidebar title, `unreadPrCount` 1, sidebar row A PR badge shows 1 open; (2) open the row → surface `claude`, `claudeSessionId === A`, hidden tab in `claude:<A>` scope; (3) `prTitlesSeed(url, { title: 'T', state: 'merged' })` + `claudeRefreshPrStates()` → row leaves the panel, badge shows merged, one `pr-completed` notification with `source: 'claude'`; (4) relaunch → `claude-sessions.json` carries the PR with `state: 'merged'`, no second notification; (5) chat path: fake SDK `FAKE_CLAUDE_PR_URL` emits a PR link in the echo text → recorded + auto-open tab (extend the fake with that env var); (6) legacy registry with `prUrls` migrates on load.

## 4. Shell + README stream
- `PrPanel.tsx`: row `data-source={pr.source}` + the Claude glyph (reuse `ClaudeGlyph` from `NotificationPanel.tsx`) before the title for Claude rows; rail PR button unchanged.
- README: the "Claude sessions" section gets "Pull requests" (how PRs are detected, the panel, state from the GitHub page, merged → pr-completed, badges) and a short **Known limitations** list (subagent transcripts not shown, fork only from the sidebar, consecutive assistant messages in one turn render as one bubble, `auto` permission mode caveat, PR state only for URLs the GitHub session can load). Settings table unchanged. Verify every claim against the code.
- `tests/smoke/installed.spec.ts`: no change needed unless userData file names changed (they didn't).

## 5. Integration + docs
`typecheck`, `test:unit`, `build`, full `test:e2e`, isolated `smoke:install` (registry file shape changed; settings didn't — smoke still worth one run as the final Phase gate). AGENTS.md: a "Claude PRs (Phase 5)" bullet (registry `prs`, funnel, state cache, merged list, routing, hooks, log events). After this phase the Claude integration plan is complete; remaining deferrals are tracked in README "Known limitations".
