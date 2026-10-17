import { useEffect, useState } from 'react';

// Optimistic-edit overlay: applyOptimistic(f) maps the base list into an
// override that renders immediately; any change to `resetOn` (a successful
// server state or a mutation failure landing in lastError) clears it.
export function useOptimisticList<D>(
  baseData: D,
  resetOn: readonly unknown[],
): { data: D; applyOptimistic: (fn: (d: D) => D) => void } {
  const [override, setOverride] = useState<D | null>(null);
  useEffect(() => {
    setOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetOn);
  return {
    data: override ?? baseData,
    applyOptimistic: (fn) => setOverride(fn(override ?? baseData)),
  };
}
