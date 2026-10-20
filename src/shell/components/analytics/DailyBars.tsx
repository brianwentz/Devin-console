import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ClaudeUsageState } from '../../../shared/ipc';
import { compact } from './format';

// Fixed palette, one colour per model (assigned in `models` order).
export const MODEL_PALETTE = ['#6e9bd0', '#c58af9', '#5fbf9a', '#e0a03c', '#e07a7a', '#8fd1e8', '#b9c56a', '#d98fc2'];

export function modelColour(index: number): string {
  return MODEL_PALETTE[index % MODEL_PALETTE.length] ?? '#6e9bd0';
}

interface DailyBarsProps {
  month: string; // yyyy-mm
  byDay: ClaudeUsageState['tokens']['byDay'];
  models: string[]; // palette order (same as the table)
}

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return 31;
  return new Date(y, m, 0).getDate();
}

const H = 160;
const PAD_L = 44;
const PAD_B = 18;
const PAD_T = 6;

// Measured container width so the chart is drawn in pixel space (no
// aspect-ratio stretching of the labels).
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(120, Math.floor(el.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Stacked SVG bars, one per calendar day of the month (empty when no data),
// one colour per model; legend underneath (plan D6 / Q3).
export function DailyBars({ month, byDay, models }: DailyBarsProps) {
  const [ref, W] = useWidth();
  const days = daysInMonth(month);
  const perDay = new Map(byDay.map((d) => [d.date, d.byModel]));
  const totals: number[] = [];
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const entry = perDay.get(date);
    totals.push(entry ? Object.values(entry).reduce((a, b) => a + b, 0) : 0);
  }
  const max = Math.max(1, ...totals);
  const plotW = W - PAD_L - 4;
  const plotH = H - PAD_B - PAD_T;
  const slot = plotW / days;
  const barW = Math.max(2, slot - 3);
  const ticks = [0, 0.5, 1].map((f) => ({ f, value: max * f }));

  return (
    <div data-daily-bars ref={ref} className="w-full min-w-0">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Tokens per day">
        {ticks.map(({ f, value }) => {
          const y = PAD_T + plotH - plotH * f;
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - 4} y1={y} y2={y} stroke="#2c3949" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#7f8ca0">
                {compact(value)}
              </text>
            </g>
          );
        })}
        {totals.map((_, i) => {
          const day = i + 1;
          const date = `${month}-${String(day).padStart(2, '0')}`;
          const entry = perDay.get(date) ?? {};
          const x = PAD_L + i * slot + 1.5;
          let yCursor = PAD_T + plotH;
          return (
            <g key={date} data-day={date}>
              {models.map((model, mi) => {
                const v = entry[model] ?? 0;
                if (v <= 0) return null;
                const h = (v / max) * plotH;
                yCursor -= h;
                return (
                  <rect key={model} x={x} y={yCursor} width={barW} height={h} fill={modelColour(mi)}>
                    <title>{`${date} · ${model}: ${compact(v)}`}</title>
                  </rect>
                );
              })}
              {(day === 1 || day % 5 === 0) && (
                <text x={x + barW / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="#7f8ca0">
                  {day}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#9aa8bb]" data-daily-legend>
        {models.map((model, i) => (
          <span key={model} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: modelColour(i) }} />
            {model}
          </span>
        ))}
      </div>
    </div>
  );
}
