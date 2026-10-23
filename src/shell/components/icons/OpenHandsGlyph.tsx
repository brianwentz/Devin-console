import { Hand } from 'lucide-react';

// Source glyph for OpenHands entries (panel rows + banner); the same icon as
// the rail button.
export function OpenHandsGlyph() {
  return (
    <span
      className="openhands-glyph inline-flex align-[-2px] mr-1 text-[#7fd1b9]"
      title="OpenHands"
      aria-label="OpenHands"
    >
      <Hand size={12} />
    </span>
  );
}
