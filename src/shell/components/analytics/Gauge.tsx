import { gaugeArc } from '../../../core/claudeUsage';
import type { ClaudeUsageLimit } from '../../../shared/ipc';

export const SEVERITY_COLOURS: Record<ClaudeUsageLimit['severity'], string> = {
  normal: '#6e9bd0',
  warning: '#e0a03c',
  critical: '#d93a2f',
};
const TRACK = '#2c3949';
const SIZE = 148;
const R = 58;
const CX = SIZE / 2;
const CY = SIZE / 2 + 4;
const STROKE = 11;

interface GaugeProps {
  kind: string;
  percent: number; // 0..100
  severity: ClaudeUsageLimit['severity'];
  label: string;
  sublabel: string | null;
  dimmed?: boolean;
}

// 270° SVG arc gauge (plan D6): track + value arc coloured by severity, the
// percentage in the middle, label and "resets in …" below.
export function Gauge({ kind, percent, severity, label, sublabel, dimmed }: GaugeProps) {
  const value = Math.max(0, Math.min(100, percent));
  const colour = SEVERITY_COLOURS[severity];
  return (
    <div
      className={`flex w-[172px] flex-col items-center rounded-lg bg-[#161f2d] px-3 pb-3 pt-1 ${dimmed ? 'opacity-60' : ''}`}
      data-gauge-kind={kind}
      data-gauge-percent={Math.round(value)}
      data-gauge-severity={severity}
    >
      <svg width={SIZE} height={SIZE - 12} viewBox={`0 0 ${SIZE} ${SIZE - 12}`} role="img" aria-label={`${label}: ${Math.round(value)}%`}>
        <path d={gaugeArc(100, R, CX, CY)} fill="none" stroke={TRACK} strokeWidth={STROKE} strokeLinecap="round" />
        {value > 0 && (
          <path d={gaugeArc(value, R, CX, CY)} fill="none" stroke={colour} strokeWidth={STROKE} strokeLinecap="round" />
        )}
        <text x={CX} y={CY + 10} textAnchor="middle" fill="#e8edf5" fontSize="30" fontWeight="600">
          {Math.round(value)}
          <tspan fontSize="14" fill="#9aa8bb">%</tspan>
        </text>
      </svg>
      <div className="-mt-3 text-center text-xs text-[#e8edf5]">{label}</div>
      <div className="mt-0.5 h-4 text-center text-[11px] text-[#7f8ca0]">{sublabel ?? ''}</div>
    </div>
  );
}
