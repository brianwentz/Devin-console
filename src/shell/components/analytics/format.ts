import type { ClaudeTokenTotals } from '../../../shared/ipc';

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat(undefined);

/** "153M", "1.2K", "48". */
export function compact(value: number): string {
  return compactFormat.format(value);
}

export function full(value: number): string {
  return fullFormat.format(value);
}

/** input + output + cache read + cache write. */
export function tokenSum(totals: ClaudeTokenTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/** Minor units (cents) → "$12.34" in the given ISO currency. */
export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** "October 2026" for a 'yyyy-mm' key. */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** "2m ago", "3h ago", "just now". */
export function ago(nowMs: number, iso: string | null): string | null {
  if (!iso) return null;
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 45_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
