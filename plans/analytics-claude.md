# Analytics: Claude tab — plan limits as gauges, tokens per month

Status: Approved — Q1 tokens only, Q2 calendar month (local), Q3 daily bars in, Q4 refresh on Stop hook; implementing

## 0. The ask

The Analytics surface shows Devin's tenant analytics today. Add Claude: the data `claude /usage` prints as text, shown graphically — a gauge of how much of the **week** is left, the **current session** (5-hour window) for the Teams plan, and **total tokens for the current month** (or whatever the per-token plans expose). The Analytics column gets **two tabs**: *Devin* (the existing hosted page) and *Claude* (new).

## 1. What exists and what the data looks like (verified on this machine, 2026-10-20)

### 1.1 The Analytics surface today
- `src/main/analytics.ts`: one `WebContentsView` on `persist:devin` loading `<tenant>/settings/my-analytics`; `window.ts applyBounds` gives it the whole main rect (`bounds.devin`) when `surface === 'analytics'`; re-entering the surface reloads it (`refreshAnalyticsView`). The Rail button is `#analyticsButton`. No shell DOM is involved beyond the title bar.
- There is no charting dependency in `package.json` (react, lucide-react, xterm, dnd-kit, react-markdown only).

### 1.2 Plan limits — what `/usage` reads
- Claude Code calls **`GET https://api.anthropic.com/api/oauth/usage`** with `Authorization: Bearer <claudeAiOauth.accessToken>` + `anthropic-beta: oauth-2025-04-20`, and caches the body in `<configDir>/.usage-cache`. Verified live from WSL: **HTTP 200 in 0.29 s**. Shape (non-null keys on this account):
  - `five_hour { utilization: 0..100, resets_at }` — the "current session" window
  - `seven_day { utilization, resets_at }` — the weekly all-models window; `seven_day_opus/_sonnet/…` are null here, but
  - `limits: [{ kind: 'session'|'weekly_all'|'weekly_scoped', group, percent, severity: 'normal'|…, resets_at, scope: { model: { display_name } }, is_active }]` — the normalised list the CLI renders (`weekly_scoped` carries the per-model share: `display_name: "Fable"`), plus `weekly_scoped_shares[{ limit_index, used_percent_of_weekly, allowance_percent_of_weekly }]`
  - `extra_usage { is_enabled, monthly_limit, used_credits, utilization, currency, disabled_reason }` and `spend { used { amount_minor, currency, exponent }, limit, percent, severity, enabled }` — the credits/overage card
  - `member_dashboard_available: false`, `seven_day_breakdown: null` on this account
- Credentials: `<configDir>/.credentials.json` → `claudeAiOauth { accessToken, refreshToken, expiresAt (ms), scopes, subscriptionType: 'team', rateLimitTier }`; `~/.claude.json` → `oauthAccount { emailAddress, organizationName: 'Cloudbeds Engineering', billingType: 'stripe_subscription', hasExtraUsageEnabled, seatTier, organizationRateLimitTier, … }`. **Both the Windows and the WSL store are signed into the same team account**; tokens are separate and short-lived (the CLI refreshes them; ours expire within hours).
- The stale fallback exists already: `.usage-cache` (WSL has one; Windows doesn't yet because `/usage` was never run there).

### 1.3 Tokens — where to get a month total
- `<configDir>/stats-cache.json` has `dailyModelTokens`/`modelUsage` but is **stale** (`lastComputedDate: 2026-09-01`, written by the CLI's `/stats` on its own cadence) → not usable for "current month".
- Transcripts carry the truth: every `type: 'assistant'` line has `message.model` and `message.usage { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, … }`, `timestamp`, `requestId` (same `requestId` can appear on several lines of one streamed message → dedupe on it). **Subagent transcripts** (`<id>/subagents/*.jsonl`) carry their own usage and are 3× the volume of the main ones this month (WSL: 104 main files / 67 MB vs 361 subagent files / 231 MB since 1 Oct).
- Measured scan of this month's main transcripts (same aggregator, identical totals both ways): **WSL over UNC from Windows: 67 MB in 2.8 s**; inside WSL: 0.36 s; Windows store: 14 MB in 0.7 s. Extrapolated cold scan incl. subagents over UNC ≈ 12 s; with per-file incremental caching the steady state is sub-second (only files whose size/mtime changed are re-read from their last offset).
- This month on this machine: opus-5-5 894 k output / 153 M cache-read tokens, fable-5-1 86 k / 15.7 M, sonnet-5 85 k / 15.4 M (WSL); the Windows store adds opus 27 k / 4.8 M and sonnet-4-6 13 k / 0.9 M.

## 2. Decisions

- **D1 — Two data sources, one service.** `src/main/claude/usage.ts` (`ClaudeUsageService`) owns both: (a) **plan limits** from the OAuth usage endpoint; (b) **token totals** from an incremental transcript aggregator over every enabled host's store. It publishes one pushed state (`ClaudeUsageState`, same `createPushedStore` pattern as the other Claude state) and is started lazily on first entry to the Claude analytics tab, not at app start.
- **D2 — Credentials are read, never refreshed.** The bearer is read from `.credentials.json` at request time (the file the CLI rotates); the app never calls the token-refresh endpoint (refresh tokens rotate; racing the CLI would log the user out). Account = `oauthAccount.emailAddress` from `~/.claude.json`; when several hosts share the account (the normal case here) one request is made using the host whose token expires latest. On `expiresAt` passed / 401: serve the newest `.usage-cache` across hosts as **stale** (badge with its age) and show "Run `claude` to refresh sign-in". 429 → exponential backoff, keep last good. The token is held only in main, never in state/log/IPC; log events carry `{ ok, status, ms, stale }` only. Requests go only to `api.anthropic.com` (fixture override in test mode).
- **D3 — Cadence.** Limits: fetch on tab entry, then every 60 s while the Claude tab is visible, every 10 min otherwise once started; also after each app-driven turn finishes (`result` message) because that's when utilization moves. Tokens: incremental re-scan on tab entry and every 60 s while visible (changed files only); first scan runs in chunks and reports progress (`scanning: { files, done }`). Cache in `userData/claude-usage-cache.json` `{ version, files: { [host:path]: { size, mtime, offset, counted: {requestIds…?} } } }` — no: store per-file **month buckets** `{ [yyyy-mm]: { [model]: Tokens } }` + `size/mtime/offset`, and dedupe `requestId` only within a file (the ids never cross files). Month = calendar month in local time; the previous month stays available for one "last month" comparison line.
- **D4 — Per-token plans.** When no `claudeAiOauth` exists (API-key or Bedrock/Vertex users), the limits card says "No subscription limits — this account is billed per token" and only the tokens card shows. A **cost estimate** needs a model pricing table we'd have to maintain; deferred (Q1).
- **D5 — Tabs on the Analytics surface.** A shell-rendered tab strip (`AnalyticsTabs`, same look as `SettingsTabs`, ids `analyticsTab-devin` / `analyticsTab-claude`) occupies the top `ANALYTICS_TABS_HEIGHT = 36` px of the main rect; `computeBounds` gains `analyticsTabs` + the hosted view's rect shrinks by that height (`bounds.devin` unchanged for the other surfaces). Devin tab → hosted view attached with the reduced rect; Claude tab → hosted view detached + zero bounds, `ClaudeAnalyticsPanel` (shell) fills the rect. Persist `analytics.tab` (`'devin' | 'claude'`, default `devin`). The Rail's Analytics entry keeps reloading the Devin page only when the Devin tab is shown; the Claude tab's header has its own Refresh (forces both fetch + scan).
- **D6 — Rendering, no new dependency.** SVG arc gauges (`Gauge.tsx`: value 0–100, severity colour, label, sublabel "resets in 1d 3h"), a stacked bar per day for the month (`DailyBars.tsx`, buckets from the aggregator), and a by-model table. Numbers formatted with `Intl.NumberFormat` compact (`153 M`). Colours follow severity: normal = accent blue, warning (≥ 75 %) amber `#e0a03c`, critical (≥ 90 %) red `#d93a2f`, same palette the sidebars use.
- **D7 — Hosts.** Token totals are tagged by host (chip, as in the sidebars) and summed; the account line names the org/email once. If hosts ever hold *different* accounts, the limits card shows one block per account (rare; built as a list from day one so it's not a special case).
- **D8 — Nothing moves to the tenant page.** The Devin tab stays the hosted `/settings/my-analytics` view exactly as today; no scraping, no cross-origin tricks.

## 3. Contracts (written first, in the contracts PR)

```ts
// shared/ipc.ts
export const ClaudeUsageLimitSchema = z.object({
  kind: z.enum(['session', 'weekly_all', 'weekly_scoped', 'other']),
  label: z.string(),                 // "Current session" | "Current week (all models)" | "Current week (Fable)"
  percent: z.number().min(0).max(100),
  severity: z.enum(['normal', 'warning', 'critical']),
  resetsAt: z.string().nullable(),   // ISO
  active: z.boolean(),
});
export const ClaudeUsageAccountSchema = z.object({
  email: z.string().nullable(), organization: z.string().nullable(),
  plan: z.string().nullable(),       // subscriptionType
  hosts: z.array(HostIdSchema),      // hosts signed into this account
  limits: z.array(ClaudeUsageLimitSchema),
  credits: z.object({ enabled: z.boolean(), usedMinor: z.number(), limitMinor: z.number().nullable(), currency: z.string(), percent: z.number().nullable() }).nullable(),
  fetchedAt: z.string().nullable(), stale: z.boolean(), error: z.string().nullable(),
});
export const ClaudeTokenTotalsSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), messages: z.number() });
export const ClaudeUsageStateSchema = z.object({
  status: z.enum(['idle', 'loading', 'ready', 'error']),
  accounts: z.array(ClaudeUsageAccountSchema),       // [] → per-token plan / not signed in
  perToken: z.boolean(),                              // no OAuth creds on any host
  month: z.string(),                                  // 'yyyy-mm' (local)
  tokens: z.object({
    total: ClaudeTokenTotalsSchema,
    byModel: z.record(z.string(), ClaudeTokenTotalsSchema),
    byHost: z.record(z.string(), ClaudeTokenTotalsSchema),
    byDay: z.array(z.object({ date: z.string(), byModel: z.record(z.string(), z.number()) })), // output+input+cache, per model
    previousMonthTotal: ClaudeTokenTotalsSchema.nullable(),
    scannedAt: z.string().nullable(),
    scanning: z.object({ files: z.number(), done: z.number() }).nullable(),
  }),
});
// channels: claudeUsageState 'claude:usageState' (invoke), claudeUsageRefresh 'claude:usageRefresh', push 'claude:usage'
// settings: analytics: { tab: z.enum(['devin','claude']).default('devin') }
// test env: DEVIN_WORKSPACES_TEST_CLAUDE_USAGE_URL (fixture replacing api.anthropic.com), FAKE_USAGE_JSON / FAKE_USAGE_STATUS read by the fixture route
// log events (channel 'claude'): usage-fetch {ok,status,ms,stale,accounts}, usage-scan {files,changed,ms,months}, usage-cache-load {files}
// test hooks: claudeUsageState(), claudeUsageRefresh()
```

Core (pure, `src/core/claudeUsage.ts`): `parseUsageResponse(json) → { limits, credits }` (normalises `limits[]`, falls back to `five_hour`/`seven_day` when `limits` is absent, labels from `scope.model.display_name`, severity from `percent` when the API's `severity` is missing); `aggregateUsageLines(lines, { since, until, file })` (dedupe on `requestId`, month buckets, by model/day); `mergeTokenBuckets`; `gaugeArc(percent) → SVG path`; `resetsIn(now, resetsAt) → "1d 3h"`.

## 4. Phases and parallel streams

```
A0 contracts + plan (main, serial, small)
 ├─ A1 core: parser, aggregator, gauge math + unit tests          (worktree an-core)
 ├─ A2 main: ClaudeUsageService (fetch, scanner, cache, IPC, hooks) (worktree an-main)   — depends on A1's function names only (stubs allowed until merge)
 └─ A3 shell: AnalyticsTabs + layout + ClaudeAnalyticsPanel (gauges, bars, table) on fake state (worktree an-shell)
A4 integration: wire, e2e with the usage fixture + claude-home transcripts fixture, real-account check on this machine, README/AGENTS (main, serial)
```

- **A1 (core)** — `src/core/claudeUsage.ts` + `tests/unit/claudeUsage.test.ts`: parse the real response shape recorded in §1.2 (a scrubbed copy becomes `tests/fixtures/claude-usage.json`); aggregator cases: dedupe repeated `requestId`, month boundary in local time, subagent lines counted, lines before `since` skipped, malformed line skipped, incremental merge from an offset; `resetsIn` rounding; severity thresholds.
- **A2 (main)** — `src/main/claude/usage.ts`: credentials reader per host (`<configDir>/.credentials.json` via `hosts().configDir(host)`), account grouping by email, fetch with timeout 10 s + backoff, `.usage-cache` stale fallback, incremental scanner (walk `projects/**` incl. `subagents`, size/mtime gate, offset resume, chunked with `setImmediate` yields, UNC-friendly `createReadStream`), on-disk cache, cadence timers tied to a `visible(bool)` signal from the shell, publish via pushed store; IPC + preload + `testHooks`. Fixture: `tests/fixtures/http.ts` gains a `/api/oauth/usage` route (status/body from env) and `launchApp` sets `DEVIN_WORKSPACES_TEST_CLAUDE_USAGE_URL` to it by default (so no spec ever hits the network); `tests/fixtures/claude-home` gains a `.credentials.json` with a fake token + two transcripts with known usage lines (one with a subagent) for deterministic totals.
- **A3 (shell)** — `src/core/layout.ts` (`analyticsTabs` rect, `ANALYTICS_TABS_HEIGHT`), `window.ts applyBounds` (hosted view below the strip; detached on the Claude tab), `AnalyticsTabs.tsx`, `ClaudeAnalyticsPanel.tsx` (+ `Gauge.tsx`, `DailyBars.tsx`), `settings.analytics.tab`, `analytics.spec.ts` geometry cases (strip height, hosted rect, Claude tab hides the hosted view, tab persists across restart). Built against a hand-written `ClaudeUsageState` until A2 lands.
- **A4 (integration)** — wire A2 → A3, e2e: fixture usage → three gauges with the right percentages and reset labels; `FAKE_USAGE_STATUS=401` → stale badge from the fixture `.usage-cache`; no credentials → per-token message; token totals equal the fixture transcripts' sums (incl. the subagent); Refresh re-fetches (`usage-fetch` count). Lead runs the real-account check here (Windows + WSL stores, one team account, gauges match `claude /usage`). Docs: README Analytics section + settings row, AGENTS env/log/hook tables, plans index.

Ownership: A1 `src/core/claudeUsage.ts` + its unit spec; A2 `src/main/claude/usage.ts`, `src/main/claude/ipc.ts` (new handlers only), `preload.ts` (+types), `testHooks.ts`, `tests/fixtures/http.ts` + `claude-home` additions, `shared/ipc.ts` (A0 did the schemas; A2 may add nothing); A3 `core/layout.ts`, `main/window.ts` (analytics lines), `main/analytics.ts`, `shell/components/Analytics*`, `shell/App.tsx` (analytics lines), `analytics.spec.ts`. No two streams share a file after A0.

Gates: per stream typecheck · lint · unit · build · its spec; A4 full e2e once (smoke not required unless packaging changes — it doesn't; the settings schema gains one key with a default, so `smoke:install` runs anyway per the repo rule).

## 5. Open questions

- **Q1 — Cost estimate for per-token accounts.** Tokens × a pricing table gives dollars, but the table ages (new models monthly) and this machine can't verify API-key accounting. Recommendation: **ship tokens only** now; add an opt-in estimate later if you use an API-key account anywhere.
- **Q2 — Month definition.** Calendar month, local time (the only thing derivable from transcripts). The subscription's weekly windows come from the API with their own `resets_at`. OK?
- **Q3 — Daily stacked bars** for the month: in, or keep the Claude tab to gauges + totals + by-model table for round one? Recommendation: in — the aggregator produces the buckets anyway and it's ~80 lines of SVG.
- **Q4 — Trigger a limits refresh when a hook reports a turn ending** (`Stop` hook) for terminal-started sessions too, not just app-driven turns? Cheap; recommendation: yes.
