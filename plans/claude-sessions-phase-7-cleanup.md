# Phase 7 — Cleanup

Status: 7a done (PR #69 — branch `claude/phase7-cleanup`: §1 lint/Markdown, §2 plans index + README tidy, §3 installer budget); 7b in progress (branch `claude/phase7b`: the remaining §1 code hygiene, the §2 AGENTS.md/README consolidation, then §3 SDK bump and §4 repository hygiene).

Housekeeping after the Claude integration (Phases 1–6). Nothing here changes behaviour; every step is verifiable by the existing gates. Destructive steps (branch/repo deletion) are listed with what they delete and are **confirmed with the user before running**.

## 1. Code hygiene (one PR, main stream)

| Item | Action | Gate |
|---|---|---|
| Phase breadcrumbs in code | 26 comments reference "Phase N" (`src/core/claude*.ts` headers, `src/main/claude/*.ts`, `ipc.ts`, `testHooks.ts`, `Rail.tsx`, `NotificationPanel.tsx`, `SectionHeader.tsx`, `state.ts`, `shortcuts.ts`, `terminalHost.ts`). Rewrite each to describe *what* the code does, not when it was written; delete the "Filled by the Phase N …" placeholders that are no longer placeholders (`sessions.ts` versions/agents/hooks). | `grep -rn "Phase [0-9]" src` → 0 |
| `src/main/claude/sessions.ts` size | ~1 000 lines holding registry, store, agents, hooks, activity, PRs, menus. Split along the existing seams without changing behaviour: `sessions.ts` (controller/snapshot/mutations), `contextMenu.ts` (menu building + test seam), `prTracking.ts` (recordPr / refreshPrStates / claudeOpenPullRequests), `hooks.ts` (listener wiring, activity, install). Keep the `claudeSessions()` singleton API identical. | typecheck + Claude e2e specs unchanged |
| `host.ts` subagent fold | The `subagentNotes` merge exists only because `tool_call_update.content` is replace-semantics. Add an `appendContent?: boolean` flag to the reducer's `tool_call_update` handling (core) and drop the host-side map. | `claudeTranslate`/`localModel` unit tests |
| Local ↔ Claude duplication | `useLocalState`/`useClaudeChatState` and `localState.ts`/`chatState.ts` are clones. Factor a generic `createPushedStore<T>(channelInvoke, channelPush, schema)` for main and `usePushedState` for the shell; both callers keep their names. | Local + Claude e2e unchanged |
| `test:hook` IPC bridge | Keep (the installed smoke depends on it) but move its registration next to the other test-only IPC and document it under "Conventions" rather than the smoke bullet. | smoke spec |
| `TerminalView` in `src/shell/chat/` still imports `../local/Markdown` | Move `Markdown.tsx` to `src/shell/chat/` (Local re-exports). | typecheck |
| Dead exports | `knip`-style pass by hand: `grep` each `export` in `src/core/claude*.ts`, `src/main/claude/*.ts` for zero importers outside tests; delete or `@internal`. | typecheck + unit |
| Lint | No linter is configured. Add `eslint` + `typescript-eslint` + `eslint-plugin-react-hooks` with a minimal recommended config and `npm run lint` in CI (`windows.yml`, `macos` job). Fix only what the recommended set flags; no stylistic rules (Prettier is not adopted). | `npm run lint` clean |

## 2. Docs consolidation (same PR)

- **AGENTS.md** (75 very long lines): restructure into sections — `Commands`, `Env vars` (one line per variable group), `Versions`, `Layout & settings`, **`Claude integration`** (sub-bullets: sidebar/registry, chat host, terminal + agents, hooks + notifications, PRs; each ≤ 12 lines), `Conventions`, `Test hooks` (one table: hook → purpose), `Log events` (one table: event → detail keys). Content preserved; duplication removed (the Passwords bullet appears twice today). Keep the "ids/counts only" logging rule and the smoke-isolation rationale verbatim.
- **README.md**: fold the Claude "Known limitations" list into a one-liner (one writer at a time) after Phase 6; check every settings-table row has a matching `#id`; refresh the "Where things live" list (`claude-sessions.json`, `claude-hooks.json`, `settings.json.devin-workspaces.bak` in `~/.claude`).
- **plans/**: add a `plans/README.md` index with status per file (Phase 0 findings, master plan, Phases 1–7: *done / in progress*), and a one-paragraph "how we worked" note (contracts first, parallel streams, integration gate). Keep the plan files as history; don't edit them retroactively except to add a `Status:` line at the top.

## 3. Dependencies

- `@anthropic-ai/claude-agent-sdk` 0.3.296 → the newest version ≥ 7 days old at the time (0.3.302 was published 2026-10-16; qualifies from 2026-10-23). Check its `manifest.json` CLI target vs the installed `claude --version` (2.1.302 today), run `claude:sdk-probe` + `claude:store-probe`, and the Claude e2e. Update the AGENTS.md Versions line.
- Confirm Dependabot's weekly groups cover the SDK (`runtime` group) and that its 7-day cooldown applies — no config change expected.
- Installer budget: re-measure (`smoke-install.ps1` records `installerSizeBytes`); if the real installer is still ~127 MB, lower the budget from 260 MB to 180 MB so a platform-binary leak (249 MB) is caught with margin.

## 4. Repository hygiene (needs user confirmation per line)

| Step | Deletes | Why safe |
|---|---|---|
| `git branch -D backup/claude-phase1` | the pre-rebase copy of the Phase 1 commits | all content merged via #56–#59 |
| `git push origin --delete claude/phase1-pr1 … claude/phase5` (remote) + `git branch -D` (local) | merged feature branches | all merged (#56–#61, #65, Phase 5 PR) |
| Delete the local checkouts of other merged branches: `feat/*`, `fix/*`, `docs/readme-refresh`, `chore/deps-update`, `pr-41` | local refs only | each is in `origin/main` history (`git branch --merged main` to verify before deleting; anything not merged is kept and reported) |
| Remote merged `feat/*`, `fix/*`, `docs/*` branches | remote refs | same check against `origin/main`; Dependabot branches are left to Dependabot |
| `C:\Users\brian\source\repos\claude-workspace` | the standalone-app reference repo (never pushed) | the only artefacts still referenced from it (Phase 0 spikes, `sessionTree` generic refactor, `claudePath.ts`) were ported in Phase 1; `plans/claude-sessions-findings.md` holds the verdicts. Option: push it once to `brianwentz/claude-workspace` as an archive before deleting. **User decides.** |
| `docs/evidence/*` (git-ignored) | local probe/smoke evidence | regenerable; keep the latest smoke JSONs if you like |

## 5. Order and gates
1. Code hygiene + docs + lint in one PR (`claude/phase7-cleanup`); gates: typecheck, lint, unit, build, full e2e, isolated smoke.
2. SDK bump as its own small PR once the 7-day window passes (gates: probes + Claude e2e + smoke).
3. Repository hygiene last, interactively, after the two PRs are merged.
