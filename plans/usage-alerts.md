# Usage alerts — Devin Cloud monthly ACUs + Claude plan limits

Status: Implemented — PR pending

## 0. The ask

Warn before a usage limit bites: when the Devin Cloud monthly ACU consumption crosses 50 % and 80 % of the billing-cycle limit, and when a Claude plan limit (session / weekly) does the same — one persisted notification per crossing, a rail badge on Analytics, and a one-line summary inside the Analytics tab strip.

## 1. What exists and what the data looks like (spike, verified live 2026-10-31)

### 1.1 The Devin usage endpoint
- `GET <tenant>/api/personal-analytics/usage-limit` → `{ tier_name, tier_max_limit, auto_increase_eligible, cycle_usage_limit, cycle_usage, estimated_cycle_usage, cycle_start, cycle_end }` — one number for "used this billing month", its limit, a projection and the period bounds. Companion `GET /api/personal-analytics/acu-limits` exists but with different key names (`cycle_acu_*`); the implementation uses `usage-limit`.
- **Auth (verified):** the analytics page exposes `window.devinDebug` → `{ getAccessToken(), getOrgId() }`; a `net.fetch` from main with `Authorization: Bearer <token>` **plus `x-cog-org-id: <orgId>`** returns 200. Bearer alone → 401 `No organizations found for auth1 user`; the org header is required. The `persist:devin` session cookies alone did not authenticate (the spike profile's cookie DBs could not be copied — this variant is untested rather than disproven).
- The hosted analytics page itself carries no stable selectors for the usage card — the API is the only sane source. DOM scraping was rejected.
- Measured live: `cycle_usage 1404.88 / cycle_usage_limit 12000` (11.7 %), tier "Power".

### 1.2 The Claude side already exists
- `claudeUsage()` (analytics-claude.md) already polls each account's plan limits; `runFetch` now additionally emits `UsageReading`s into the alert store — no second fetcher.

## 2. Decisions

- **D1 — One alert engine, several meters.** `src/core/usageAlerts.ts` is pure: `deriveUsageAlerts(ledger, readings)` over thresholds `{50, 80}` keyed `metric:account`, where `account` is '' for Devin and the Claude account key (email, else `host:<first>`) for Claude so accounts alert independently. Semantics: highest-only per reading (a 40→85 jump fires 80 and marks `[50,80]` fired), a new `periodKey` re-arms, dips below a threshold never un-fire inside a period, non-finite percents skip, untouched keys carry over.
- **D2 — The ledger survives mute.** `UsageAlertStore` (`userData/usage-alerts.json`, cache-class file — a rebuilt ledger is harmless) persists whenever `deriveUsageAlerts` changes it, even when `notifications.kinds.usage` or `collect` is off — re-enabling never back-fires old crossings. Alerts that pass the kind gate become `usage`-kind entries in the notification store.
- **D3 — DevinUsageService is a Cloud-view client.** Started right after `cloudSessions().start()`; identity via `cloudSessions().readIdentity()` → `{ identity, reason }` (reuses `readPageIdentity`'s `devinDebug` read — no separate auth path, token held in memory only). Cadence `usage.devinPollMinutes` (5–240, default 15; first poll +5 s; `refreshAnalyticsView()` and IPC `devin:usageRefresh` force polls). Failures keep the last good body (`stale: true`, backoff 1→16 min like the Claude service). **Transient identity failures** (`view-not-ready`/`timeout`/`error` — the view still loading) leave status/backoff alone and retry in 30 s for at most 6 consecutive tries before resuming the normal cadence; `login-required`/`no-devindebug` set status `login-required`. `userData/devin-usage-cache.json` (`{version,tenantUrl,savedAt,body}`, tenant-gated) seeds a stale `ready` on launch.
- **D4 — `usage` is a quiet notification kind.** Persisted, superseding (`itemKey` `usage:<metric>:<account>`), **no banner** (user decision), opens the Analytics surface on the matching tab (`analytics.tab` ← `source === 'claude' ? 'claude' : 'devin'`). Titles `Devin Cloud monthly ACUs: N% used` / `Claude … limit: N% used`.
- **D5 — ShellState carries the summary.** `ShellState.usage { level: 'none'|'warn'|'critical', items: [{metric, accountKey, label, percent}], devin: DevinUsageState }` computed in `publicState` — no pushed channel; `devinUsage` state changes call `notifyShell()`. Rail `#usageBadge` dot: amber `#e0a03c` ≥50, red `#d93a2f` ≥80. `ANALYTICS_TABS_HEIGHT = 36 + 24` — the strip now contains a second row: `#devinUsageSummary` (usage/limit, projection, reset date, `cached`) on the Devin tab, `#claudeUsageSummary` (`Session N% · Week N%` per account) on the Claude tab; the tab row keeps its position on both tabs.
- **D6 — `claudeUsage().start()` is now eager.** Alerts can't wait for an Analytics visit; the hidden cadence (10 min) already exists.

## 3. File map

| File | Change |
|---|---|
| `src/core/devinUsage.ts` | `parseUsageLimit`, `fmt`, `shortDate` (pure) |
| `src/core/usageAlerts.ts` | thresholds, ledger, `deriveUsageAlerts`, `usageLevel`, titles (pure) |
| `src/core/notificationModel.ts` | `usage` kind, `metric`/`accountKey`, `itemKey` |
| `src/shared/ipc.ts` | `DevinUsageStateSchema`, `ShellState.usage`, `usage` settings block, `kinds.usage`, `devin:usageRefresh` |
| `src/main/devinUsage.ts` | `DevinUsageService` — poll/identity/backoff/transient rule/cache |
| `src/main/usageAlerts.ts` | `UsageAlertStore` — ledger file + notification emission |
| `src/main/cloudSessions.ts` | `readIdentity()` → `{identity, reason}` |
| `src/main/claude/usage.ts` | emits readings per account/limit |
| `src/main/window.ts` | `usageSummary()` in `publicState` |
| `src/main/notifications.ts` / `notifier.ts` | `usage` entries persisted + no banner; open → Analytics tab |
| `src/shell/components/{Rail,AnalyticsTabs,NotificationSettings}.tsx` | badge, summary rows, kind toggle |
| `src/core/{settings,settingsDraft}.ts`, `src/shell/{settingsDraft,components/settings/GeneralTab}` | `usage.devinPollMinutes` |
| `tests/e2e/usageAlerts.spec.ts`, `tests/fixtures/http.ts` (`setUsageLimit`/`setUsageStatus`) | e2e + fixtures |

## 4. Test plan

- Unit: `devinUsage` (parse edges, percent unclamped, fmt/shortDate), `usageAlerts` (threshold/refire/re-arm/multi-account/NaN), `notificationModel` (usage itemKey + supersession), storePreserve/settingsDraft/schema drift tests.
- e2e `usageAlerts.spec.ts` (poll 400 ms): 55 % warn → badge + one 50 % entry + no banner → 85 % critical supersedes to the 80 % entry → restart keeps the ledger (no refire) → new `cycle_start` re-arms; summary row + hosted-view geometry on both tabs; HTTP 500 keeps last good (`cached`, `stale`) and recovers; Claude session alert opens the Claude tab marked read; `kinds.usage = false` advances the ledger without adding an entry.
