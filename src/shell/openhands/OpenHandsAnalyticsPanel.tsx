import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { ANALYTICS_USAGE_ROW_HEIGHT } from '../../core/layout';
import { cardValue, emptyOpenHandsUsageState, type Card } from '../../core/openhandsUsage';
import { Gauge } from '../components/analytics/Gauge';
import { summaryRowClass } from '../components/analytics/UsageSummaries';
import { useShellState } from '../store';

// Analytics -> OpenHands (B3): credits, today's sandbox quota, the 30-day
// spend and the most expensive listed conversations. Data rides
// ShellState.usage.openhands; mounting reports the tab visible (60 s cadence,
// and it opens the OpenHands gate — an explicit OpenHands action).

const UNAVAILABLE = 'Not available on this server';
const money = (value: number): string => `$${value.toFixed(2)}`;
const severity = (percent: number) => (percent >= 80 ? 'critical' : percent >= 50 ? 'warning' : 'normal');

function resetsLabel(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return `Resets ${new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function CardShell({
  id,
  title,
  card,
  children,
}: {
  id: 'credits' | 'quota' | 'spend' | 'top';
  title: string;
  card: Card<unknown>['state'];
  children: ReactNode;
}) {
  return (
    <section
      data-card={id}
      data-card-state={card}
      className="flex min-w-[200px] flex-1 flex-col gap-2 rounded-lg bg-[#161f2d] px-4 py-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[#9aa8bb]">{title}</h2>
      {children}
    </section>
  );
}

// The body for a non-ok card (ok bodies are card-specific).
function CardStatus<T>({ card, render }: { card: Card<T>; render: (value: T) => ReactNode }) {
  if (card.state === 'ok') return <>{render(card.value)}</>;
  if (card.state === 'unavailable') return <p className="text-sm text-[#7f8ca0]">{UNAVAILABLE}</p>;
  if (card.state === 'pending') return <p className="text-sm text-[#7f8ca0]">Loading…</p>;
  return (
    <>
      {card.stale !== undefined && render(card.stale)}
      <p className="text-xs text-[#e0a03c]" data-card-error>
        {card.stale !== undefined ? "Couldn't refresh — showing the last value" : "Couldn't load"}
      </p>
    </>
  );
}

function Amount({ value, caption }: { value: number; caption: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xl font-semibold text-[#e8edf5]" data-card-value>
        {money(value)}
      </span>
      <span className="text-xs text-[#7f8ca0]">{caption}</span>
    </div>
  );
}

export function OpenHandsAnalyticsPanel({ style }: { style: CSSProperties }) {
  const shell = useShellState();
  const usage = shell?.usage.openhands ?? emptyOpenHandsUsageState();
  // The top list comes from the conversation list: pending until one is known
  // (a live list or the cached one).
  const listed = shell?.openhands?.status === 'ready' || shell?.openhands?.cached === true;
  useEffect(() => {
    window.agentworkspace.openhandsUsageVisible(true);
    return () => window.agentworkspace.openhandsUsageVisible(false);
  }, []);

  return (
    <div id="openhandsAnalytics" className="overflow-x-hidden overflow-y-auto bg-[#111827] text-[#e8edf5]" style={style}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold">OpenHands usage</h1>
        <div className="flex flex-wrap gap-4">
          <CardShell id="credits" title="Credits" card={usage.credits.state}>
            <CardStatus card={usage.credits} render={(v) => <Amount value={v} caption="Remaining balance" />} />
          </CardShell>
          <CardShell id="quota" title="Daily quota" card={usage.quota.state}>
            <CardStatus
              card={usage.quota}
              render={(q) => (
                <Gauge
                  kind="openhands-quota"
                  percent={q.percent}
                  severity={severity(q.percent)}
                  label="Sandboxes today"
                  sublabel={resetsLabel(q.resetsAt)}
                  dimmed={usage.quota.state !== 'ok'}
                />
              )}
            />
          </CardShell>
          <CardShell id="spend" title="Spend" card={usage.spend30d.state}>
            <CardStatus card={usage.spend30d} render={(v) => <Amount value={v} caption="Last 30 days" />} />
          </CardShell>
        </div>
        <CardShell id="top" title="Most expensive conversations" card={listed ? 'ok' : 'pending'}>
          {!listed ? (
            <p className="text-sm text-[#7f8ca0]">Loading…</p>
          ) : usage.topByCost.length === 0 ? (
            <p className="text-sm text-[#7f8ca0]">No conversation costs reported yet.</p>
          ) : (
            <ol className="flex flex-col gap-1 text-sm">
              {usage.topByCost.map((item) => (
                <li key={item.id} data-top-id={item.id} className="flex justify-between gap-4">
                  <span className="truncate">{item.title}</span>
                  <span className="shrink-0 text-[#9aa8bb]">{money(item.cost)}</span>
                </li>
              ))}
            </ol>
          )}
        </CardShell>
      </div>
    </div>
  );
}

// Row under the tab strip: quota + credits at a glance.
export function OpenHandsUsageSummary() {
  const usage = useShellState()?.usage.openhands ?? emptyOpenHandsUsageState();
  const quota = cardValue(usage.quota);
  const credits = cardValue(usage.credits);
  const parts: string[] = [];
  if (quota) parts.push(`Quota ${Math.round(quota.percent)}% today${usage.quota.state === 'error' ? ' (cached)' : ''}`);
  if (credits !== null) parts.push(`Credits ${money(credits)}`);
  const pending = usage.credits.state === 'pending' && usage.quota.state === 'pending';
  const text = parts.length > 0 ? parts.join(' · ') : pending ? 'Loading usage…' : 'Usage unavailable';
  return (
    <div id="openhandsUsageSummary" className={summaryRowClass} style={{ height: ANALYTICS_USAGE_ROW_HEIGHT }}>
      {text}
    </div>
  );
}
