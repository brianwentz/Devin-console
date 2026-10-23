import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { ANALYTICS_USAGE_ROW_HEIGHT } from '../../core/layout';
import {
  cardValue,
  emptyOpenHandsUsageState,
  usageAuthHint,
  type Card,
  type UsageAuthHint,
} from '../../core/openhandsUsage';
import { Gauge } from '../components/analytics/Gauge';
import { summaryRowClass } from '../components/analytics/UsageSummaries';
import { useShellState } from '../store';
import { openOpenHandsSettings, openOpenHandsSignIn } from './authActions';

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


const HINT_TEXT: Record<UsageAuthHint, string> = {
  'login-required': 'Sign in to OpenHands to see usage',
  'api-key-rejected': 'API key rejected — update it in Settings',
  'api-key-required': 'API key required — add it in Settings',
};
const hintAction = (hint: UsageAuthHint): (() => void) =>
  hint === 'login-required' ? openOpenHandsSignIn : openOpenHandsSettings;

// The sign-in / API-key way out, same actions as the sidebar banner.
function AuthHint({ hint }: { hint: UsageAuthHint }) {
  const login = hint === 'login-required';
  return (
    <button
      id={login ? 'openhandsAnalyticsLogin' : 'openhandsAnalyticsApiKeyHint'}
      type="button"
      data-auth-hint={hint}
      className={`self-start rounded px-3 py-1.5 text-sm hover:bg-[#1a2735] ${login ? 'text-[#6e9bd0] hover:text-[#9fc4ea]' : 'text-[#e0a03c]'}`}
      onClick={hintAction(hint)}
    >
      {HINT_TEXT[hint]}
    </button>
  );
}

// The body for a non-ok card (ok bodies are card-specific). While the user is
// signed out (`hint`), a card that has nothing to show says so instead of
// "Loading…" / "Couldn't load".
function CardStatus<T>({
  card,
  hint,
  render,
}: {
  card: Card<T>;
  hint: UsageAuthHint | null;
  render: (value: T) => ReactNode;
}) {
  if (card.state === 'ok') return <>{render(card.value)}</>;
  if (card.state === 'unavailable') return <p className="text-sm text-[#7f8ca0]">{UNAVAILABLE}</p>;
  if (card.state === 'pending') {
    return <p className="text-sm text-[#7f8ca0]">{hint ? 'Not signed in' : 'Loading…'}</p>;
  }
  const stale = card.stale !== undefined;
  const signedOut = card.reason !== undefined || hint !== null;
  return (
    <>
      {stale && render(card.stale as T)}
      <p className="text-xs text-[#e0a03c]" data-card-error={card.reason ?? 'error'}>
        {signedOut
          ? stale
            ? 'Not signed in — showing the last value'
            : 'Not signed in'
          : stale
            ? "Couldn't refresh — showing the last value"
            : "Couldn't load"}
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

// The top list comes from the conversation list: ok once one is known (live or
// cached), error when listing failed or the user is signed out, else pending.
function topState(
  oh: { status: string; cached: boolean } | null | undefined,
  hint: UsageAuthHint | null,
): 'ok' | 'error' | 'pending' {
  if (oh?.status === 'ready' || oh?.cached === true) return 'ok';
  if (hint !== null || oh?.status === 'error') return 'error';
  return 'pending';
}

export function OpenHandsAnalyticsPanel({ style }: { style: CSSProperties }) {
  const shell = useShellState();
  const usage = shell?.usage.openhands ?? emptyOpenHandsUsageState();
  const hint = usageAuthHint(usage, shell?.openhands?.connection);
  const top = topState(shell?.openhands, hint);
  useEffect(() => {
    window.agentworkspace.openhandsUsageVisible(true);
    return () => window.agentworkspace.openhandsUsageVisible(false);
  }, []);

  return (
    <div id="openhandsAnalytics" className="overflow-x-hidden overflow-y-auto bg-[#111827] text-[#e8edf5]" style={style}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 p-6">
        <h1 className="text-lg font-semibold">OpenHands usage</h1>
        {hint && <AuthHint hint={hint} />}
        <div className="flex flex-wrap gap-4">
          <CardShell id="credits" title="Credits" card={usage.credits.state}>
            <CardStatus
              card={usage.credits}
              hint={hint}
              render={(v) => <Amount value={v} caption="Remaining balance" />}
            />
          </CardShell>
          <CardShell id="quota" title="Daily quota" card={usage.quota.state}>
            <CardStatus
              card={usage.quota}
              hint={hint}
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
            <CardStatus
              card={usage.spend30d}
              hint={hint}
              render={(v) => <Amount value={v} caption="Last 30 days" />}
            />
          </CardShell>
        </div>
        <CardShell id="top" title="Most expensive conversations" card={top}>
          {top === 'pending' ? (
            <p className="text-sm text-[#7f8ca0]">Loading…</p>
          ) : top === 'error' ? (
            <p className="text-sm text-[#7f8ca0]">{hint ? 'Not signed in' : "Couldn't load conversations"}</p>
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

// Row under the tab strip: quota + credits at a glance; while signed out with
// nothing to show, the sign-in / API-key hint (same action as the panel's).
export function OpenHandsUsageSummary() {
  const shell = useShellState();
  const usage = shell?.usage.openhands ?? emptyOpenHandsUsageState();
  const hint = usageAuthHint(usage, shell?.openhands?.connection);
  const quota = cardValue(usage.quota);
  const credits = cardValue(usage.credits);
  const parts: string[] = [];
  if (quota) parts.push(`Quota ${Math.round(quota.percent)}% today${usage.quota.state === 'error' ? ' (cached)' : ''}`);
  if (credits !== null) parts.push(`Credits ${money(credits)}`);
  const pending = usage.credits.state === 'pending' && usage.quota.state === 'pending';
  const text = parts.length > 0 ? parts.join(' · ') : pending ? 'Loading usage…' : 'Usage unavailable';
  return (
    <div
      id="openhandsUsageSummary"
      data-auth-hint={hint ?? undefined}
      className={summaryRowClass}
      style={{ height: ANALYTICS_USAGE_ROW_HEIGHT }}
    >
      {hint && parts.length === 0 ? (
        <button
          id="openhandsAnalyticsSummaryHint"
          type="button"
          className="truncate text-left text-[#6e9bd0] hover:text-[#9fc4ea]"
          onClick={hintAction(hint)}
        >
          {HINT_TEXT[hint]}
        </button>
      ) : (
        text
      )}
    </div>
  );
}
