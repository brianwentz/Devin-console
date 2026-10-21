// Title-bar "Ag" tile — geometry mirrors scripts/make-icon.mjs (unit coords ×100); keep in sync.
// The inset ring is shell-only; the "47" accent is omitted (make-icon draws it only at ≥48 px).
export function AgMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" data-ag-mark>
      <rect width="100" height="100" rx="22" fill="#111827" />
      <rect
        x="0.5"
        y="0.5"
        width="99"
        height="99"
        rx="21.5"
        fill="none"
        stroke="#2c3949"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <g fill="none" stroke="#f9fafb" strokeWidth="8.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M36 28 L20 68 M36 28 L52 68" />
        <path d="M25 55.5 H47" />
        <circle cx="69.5" cy="55" r="12.5" />
        <path d="M82 42 V76.5" />
        <path d="M82 76.5 A10.5 10.5 0 0 1 61 76.5" />
      </g>
    </svg>
  );
}
