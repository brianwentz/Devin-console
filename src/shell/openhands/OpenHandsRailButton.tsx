import { Hand } from 'lucide-react';
import type { RailButtonProps } from '../providers';
import { requestSurface } from '../surface';

export function OpenHandsRailButton({ surface, buttonClass }: RailButtonProps) {
  return (
    <button
      id="openhandsButton"
      type="button"
      aria-label="OpenHands"
      aria-pressed={surface === 'openhands'}
      title="OpenHands"
      className={`${buttonClass} flex items-center justify-center`}
      onClick={() => void requestSurface('openhands')}
    >
      <Hand size={18} strokeWidth={1.8} />
    </button>
  );
}
