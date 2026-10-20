import type { ClaudeTokenTotals } from '../../../shared/ipc';
import { modelColour } from './DailyBars';
import { compact, full, tokenSum } from './format';

interface TokenTableProps {
  models: string[]; // sorted by total desc (palette order)
  byModel: Record<string, ClaudeTokenTotals>;
  byHost: Record<string, ClaudeTokenTotals>;
}

const hostName = (host: string) => host.replace(/^wsl:/, '');

// By-model table (plan D6): one row per model with the four token columns,
// plus a per-host breakdown line when more than one host contributed (D7).
export function TokenTable({ models, byModel, byHost }: TokenTableProps) {
  const hosts = Object.keys(byHost);
  const cell = 'px-3 py-1.5 text-right tabular-nums';
  return (
    <table className="w-full border-collapse text-xs" data-token-table>
      <thead>
        <tr className="text-[#7f8ca0]">
          <th className="px-3 py-1.5 text-left font-normal">Model</th>
          <th className={`${cell} font-normal`}>Input</th>
          <th className={`${cell} font-normal`}>Output</th>
          <th className={`${cell} font-normal`}>Cache read</th>
          <th className={`${cell} font-normal`}>Cache write</th>
          <th className={`${cell} font-normal`}>Total</th>
        </tr>
      </thead>
      <tbody>
        {models.map((model, i) => {
          const totals = byModel[model];
          if (!totals) return null;
          return (
            <tr key={model} className="border-t border-[#243040] text-[#e8edf5]" data-token-model={model}>
              <td className="px-3 py-1.5 text-left">
                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: modelColour(i) }} />
                {model}
              </td>
              <td className={cell} title={full(totals.input)}>{compact(totals.input)}</td>
              <td className={cell} title={full(totals.output)}>{compact(totals.output)}</td>
              <td className={cell} title={full(totals.cacheRead)}>{compact(totals.cacheRead)}</td>
              <td className={cell} title={full(totals.cacheWrite)}>{compact(totals.cacheWrite)}</td>
              <td className={`${cell} font-semibold`} title={full(tokenSum(totals))}>{compact(tokenSum(totals))}</td>
            </tr>
          );
        })}
        {hosts.length > 1 && (
          <tr className="border-t border-[#243040] text-[#7f8ca0]" data-token-hosts>
            <td className="px-3 py-1.5 text-left" colSpan={6}>
              By host:{' '}
              {hosts.map((host) => {
                const totals = byHost[host];
                if (!totals) return null;
                return (
                  <span key={host} className="mr-3" data-token-host={host}>
                    <span className="rounded bg-[#243447] px-1 text-[10px] leading-[14px] text-[#9fc4ea]">{hostName(host)}</span>{' '}
                    <span className="tabular-nums text-[#e8edf5]">{compact(tokenSum(totals))}</span>
                  </span>
                );
              })}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
