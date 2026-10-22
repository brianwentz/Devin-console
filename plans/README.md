# plans/

Design history of the Claude Code integration (Phases 0–7). The files are kept as written; each phase file carries a `Status:` line under its title, and nothing else is edited retroactively.

| File | Purpose | Status |
|---|---|---|
| `claude-sessions-findings.md` | Phase 0 — spike findings and verdicts (Agent SDK inside Electron, hooks, the `~/.claude` session store) that every later phase relies on | Done |
| `claude-sessions.md` | Master plan — goals, architecture, the phase split and the gates each phase must pass | Reference |
| `claude-sessions-phase-1.md` | Phase 1 — Claude surface skeleton, SDK packaging, session registry + sidebar | Done (PRs #56–#59) |
| `claude-sessions-phase-2.md` | Phase 2 — chat view via the Agent SDK (host, translate, cards) | Done (PR #60) |
| `claude-sessions-phase-3.md` | Phase 3 — terminal tab + background agents | Done (PR #61) |
| `claude-sessions-phase-4.md` | Phase 4 — notifications via Claude Code hooks | Done (PR #65) |
| `claude-sessions-phase-5.md` | Phase 5 — Claude PRs in the PR panel, sidebar PR badges, final docs | Done (PR #66) |
| `claude-sessions-phase-6.md` | Phase 6 — limitations and deferrals from Phases 1–5 | Done (PR #68) |
| `claude-sessions-phase-7-cleanup.md` | Phase 7 — code hygiene, lint, docs consolidation, dependency/installer budget, repository hygiene | 7a done (PR #69); 7b in progress |
| `exec-hosts-wsl.md` | Phase 8 — execution hosts: Claude Code and Devin Local sessions inside WSL distros | Implemented — PR pending |
| `ux-round-2.md` | UX round 2 — composer keys, dock rule, Settings tabs, workspaces in the session column | In progress — P0/P4a merged (#77); P1–P3, P4b, P5 open |
| `quiet-tests.md` | Quiet e2e runs — invisible, never-activated test window | Implemented — PR pending |
| `analytics-claude.md` | Analytics Claude tab — plan-limit gauges + monthly token totals | Implemented — PR pending |
| `ux-round-3.md` | UX round 3 — session/folder reorder, Devin Cloud tab, picker start folder, store passthrough, local configDir fix | Implemented — PR pending |
| `usage-alerts.md` | Usage alerts — Devin Cloud monthly ACUs + Claude plan limits, 50%/80% notifications, rail badge, strip summary | Implemented — PR pending |

## How we worked

Each phase started with contracts: the IPC schemas, settings keys, log events and test hooks were written down in the plan (§1 of each phase file) before any code. The implementation then ran as parallel streams — `core` (pure logic + unit tests), `main` (Electron process) and `shell` (React) — on disjoint files, so the streams never touched the same module and could land independently. Every phase closed with a single integration pass on one branch: typecheck, unit, build, the full Playwright e2e suite and the isolated installer smoke (`npm run smoke:install`) had to be green before the PR was opened. Spikes and probes (`scripts/claude-*-probe.ts`) produced git-ignored evidence under `docs/evidence/`; their verdicts live in `claude-sessions-findings.md`.
| `rename-agent-workspace.md` | Rename to Agent Workspace — identity, installer GUID carry-over, profile/hooks migration, docs | Implemented — PR pending |
| `wsl-helper-transport.md` | Phase 9 — in-distro helper over one `wsl.exe` stdio channel (and SSH) replacing `\\wsl.localhost` UNC access; P0 hotfix first | P0 merged (#90); P1 implemented — PR pending |
| `provider-architecture-openhands.md` | Provider architecture + OpenHands — provider registry (A1), cloud kit, runtime seam; spec `docs/superpowers/specs/2026-10-22-provider-architecture-openhands-design.md`, plan `docs/superpowers/plans/2026-10-22-provider-architecture-openhands.md` (both local-only, git-ignored) | A1 implemented — PR pending |
