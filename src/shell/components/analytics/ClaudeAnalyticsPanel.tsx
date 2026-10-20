import { useEffect, useState, type CSSProperties } from 'react';
import { resetsIn } from '../../../core/claudeUsage';
import type { ClaudeUsageAccount, ClaudeUsageState } from '../../../shared/ipc';
import { DailyBars } from './DailyBars';
import { ago, compact, full, money, monthTitle, tokenSum } from './format';
import { Gauge, SEVERITY_COLOURS } from './Gauge';
import { TokenTable } from './TokenTable';

interface ClaudeAnalyticsPanelProps {
  state: ClaudeUsageState;
  style: CSSProperties;
}

const hostChip = (host: string) => (
  <span
    key={host}
    data-host-chip
    className="shrink-0 rounded bg-[#243447] px-1 text-[10px] leading-[14px] text-[#9fc4ea]"
    title={`Signed in on ${host}`}
  >
    {host.replace(/^wsl:/, '')}
  </span>
);

// Tick once a minute so "resets in …" / "Updated … ago" stay current. In
// test mode AGENT_WORKSPACE_TEST_NOW pins the clock so e2e/screenshots are
// deterministic (mirrors the main-process service's now()).
function useMinuteNow(): number {
  const testNow = (window.agentworkspace as unknown as { testNow?: string | null }).testNow;
  const pinned = testNow ? Date.parse(testNow) : NaN;
  const [now, setNow] = useState(() => (Number.isFinite(pinned) ? pinned : Date.now()));
  useEffect(() => {
    if (Number.isFinite(pinned)) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [pinned]);
  return now;
}

const ALWAYS_SHOWN = new Set(['session', 'weekly_all']);

function visibleLimits(account: ClaudeUsageAccount): ClaudeUsageAccount['limits'] {
  return account.limits.filter(
    (limit) => ALWAYS_SHOWN.has(limit.kind) || limit.active || limit.percent > 0,
  );
}

function AccountBlock({ account, now, showHosts }: { account: ClaudeUsageAccount; now: number; showHosts: boolean }) {
  const limits = visibleLimits(account);
  const credits = account.credits;
  return (
    <section className="flex flex-col gap-3" data-usage-account={account.email ?? ''}>
      {showHosts && (
        <div className="flex items-center gap-2 text-xs text-[#9aa8bb]">
          <span>{[account.email, account.organization, account.plan].filter(Boolean).join(' · ')}</span>
          {account.hosts.map(hostChip)}
        </div>
      )}
      <div className="flex flex-wrap gap-3" data-gauges>
        {limits.map((limit, i) => {
          const until = resetsIn(now, limit.resetsAt);
          return (
            <Gauge
              key={`${limit.kind}-${i}`}
              kind={limit.kind}
              percent={limit.percent}
              severity={limit.severity}
              label={limit.label}
              sublabel={until ? `resets in ${until}` : null}
              dimmed={!limit.active}
            />
          );
        })}
        {credits?.enabled && (
          <div className="flex w-[220px] flex-col justify-between rounded-lg bg-[#161f2d] px-4 py-3" data-credits>
            <div className="text-xs text-[#7f8ca0]">Extra usage credits</div>
            <div className="mt-1 text-xl font-semibold text-[#e8edf5]">
              {money(credits.usedMinor, credits.currency)}
              {credits.limitMinor !== null && (
                <span className="text-sm font-normal text-[#7f8ca0]"> / {money(credits.limitMinor, credits.currency)}</span>
              )}
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded bg-[#2c3949]">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.max(0, Math.min(100, credits.percent ?? 0))}%`,
                  background:
                    (credits.percent ?? 0) >= 90
                      ? SEVERITY_COLOURS.critical
                      : (credits.percent ?? 0) >= 75
                        ? SEVERITY_COLOURS.warning
                        : SEVERITY_COLOURS.normal,
                }}
              />
            </div>
          </div>
        )}
      </div>
      {account.error && (
        <div className="text-xs text-[#e0a03c]" data-usage-error>
          {account.error}
        </div>
      )}
    </section>
  );
}

function statusLine(state: ClaudeUsageState, now: number): { text: string; tone: 'muted' | 'warn' } {
  if (state.status === 'idle' || state.status === 'loading') return { text: 'Loading…', tone: 'muted' };
  const stale = state.accounts.find((a) => a.stale);
  if (stale) {
    const when = ago(now, stale.fetchedAt);
    return { text: `Stale${when ? ` (updated ${when})` : ''} — ${stale.error ?? 'could not refresh'}`, tone: 'warn' };
  }
  if (state.status === 'error') {
    const err = state.accounts.find((a) => a.error)?.error;
    return { text: `Stale — ${err ?? 'could not refresh'}`, tone: 'warn' };
  }
  const latest = [...state.accounts.map((a) => a.fetchedAt), state.tokens.scannedAt]
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  const when = ago(now, latest ?? null);
  return { text: when ? `Updated ${when}` : 'Updated', tone: 'muted' };
}

// Claude tab of the Analytics surface (plans/analytics-claude.md D5–D7):
// account line, plan-limit gauges, month token totals, daily bars, by-model table.
export function ClaudeAnalyticsPanel({ state, style }: ClaudeAnalyticsPanelProps) {
  const now = useMinuteNow();
  const status = statusLine(state, now);
  const first = state.accounts[0];
  const allHosts = Array.from(new Set(state.accounts.flatMap((a) => a.hosts)));
  const multiHost = allHosts.length > 1;
  const models = Object.entries(state.tokens.byModel)
    .sort((a, b) => tokenSum(b[1]) - tokenSum(a[1]))
    .map(([model]) => model);
  const total = state.tokens.total;
  const totalSum = tokenSum(total);
  const previous = state.tokens.previousMonthTotal;
  const previousSum = previous ? tokenSum(previous) : null;
  const delta =
    previousSum !== null && previousSum > 0 ? Math.round(((totalSum - previousSum) / previousSum) * 100) : null;
  const loading = state.status === 'idle' || state.status === 'loading';

  return (
    <div
      id="claudeAnalyticsPanel"
      data-usage-status={state.status}
      className="overflow-x-hidden overflow-y-auto bg-[#111827] text-[#e8edf5]"
      style={style}
    >
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 p-6">
        <header className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-lg font-semibold">Claude usage</h1>
            <span
              className={`text-xs ${status.tone === 'warn' ? 'text-[#e0a03c]' : 'text-[#7f8ca0]'}`}
              data-usage-status-line
            >
              {status.text}
            </span>
          </div>
          {first && state.accounts.length === 1 && (
            <div className="flex items-center gap-2 text-xs text-[#9aa8bb]" data-usage-account-line>
              <span>{[first.email, first.organization, first.plan].filter(Boolean).join(' · ')}</span>
              {multiHost && first.hosts.map(hostChip)}
            </div>
          )}
        </header>

        {state.perToken ? (
          <p className="rounded-lg bg-[#161f2d] px-4 py-3 text-sm text-[#9aa8bb]" data-per-token>
            No subscription limits — this account is billed per token.
          </p>
        ) : loading && state.accounts.length === 0 ? (
          <div className="flex gap-3" data-gauges-loading>
            {[0, 1].map((i) => (
              <div key={i} className="h-[180px] w-[172px] animate-pulse rounded-lg bg-[#161f2d]" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {state.accounts.map((account, i) => (
              <AccountBlock
                key={account.email ?? i}
                account={account}
                now={now}
                showHosts={state.accounts.length > 1}
              />
            ))}
          </div>
        )}

        <section className="flex flex-col gap-4" data-tokens>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-[#e8edf5]">Tokens · {monthTitle(state.month)}</h2>
            {state.tokens.scanning && (
              <span className="text-[11px] text-[#7f8ca0]" data-usage-scanning>
                Scanning transcripts… {state.tokens.scanning.done} / {state.tokens.scanning.files}
              </span>
            )}
          </div>
          <div className="grid grid-cols-[220px_1fr] gap-3">
            <div className="flex flex-col gap-2 rounded-lg bg-[#161f2d] px-4 py-3" data-token-total>
              <div className="text-xs text-[#7f8ca0]">Total this month</div>
              <div className="text-3xl font-semibold tabular-nums" title={full(totalSum)}>
                {loading && totalSum === 0 ? '—' : compact(totalSum)}
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px] text-[#9aa8bb]">
                <dt>Input</dt>
                <dd className="text-right tabular-nums">{compact(total.input)}</dd>
                <dt>Output</dt>
                <dd className="text-right tabular-nums">{compact(total.output)}</dd>
                <dt>Cache read</dt>
                <dd className="text-right tabular-nums">{compact(total.cacheRead)}</dd>
                <dt>Cache write</dt>
                <dd className="text-right tabular-nums">{compact(total.cacheWrite)}</dd>
                <dt>Messages</dt>
                <dd className="text-right tabular-nums">{full(total.messages)}</dd>
              </dl>
              {previousSum !== null && (
                <div className="mt-1 text-[11px] text-[#7f8ca0]" data-token-previous>
                  vs last month: {compact(previousSum)}
                  {delta !== null && (
                    <span className={delta > 0 ? ' text-[#e0a03c]' : ' text-[#5fbf9a]'}>
                      {' '}
                      ({delta > 0 ? '+' : ''}
                      {delta}%)
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="min-w-0 overflow-hidden rounded-lg bg-[#161f2d] px-4 py-3">
              {state.tokens.byDay.length === 0 && loading ? (
                <div className="flex h-full items-center justify-center text-xs text-[#7f8ca0]">Loading…</div>
              ) : (
                <DailyBars month={state.month} byDay={state.tokens.byDay} models={models} />
              )}
            </div>
          </div>
          {models.length > 0 && (
            <div className="rounded-lg bg-[#161f2d] py-1">
              <TokenTable models={models} byModel={state.tokens.byModel} byHost={state.tokens.byHost} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
