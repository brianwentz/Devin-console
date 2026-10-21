import { useEffect } from 'react';
import { useShellState } from '../store';

// Autofill account picker — while open, main raises the shell view so the card
// sits over the hosted view, anchored under the field that was focused.
export function AccountPicker() {
  const state = useShellState();
  const picker = state?.autofill.picker ?? null;

  useEffect(() => {
    if (!picker) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.agentworkspace.autofillPickerClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picker]);

  if (!picker) return null;

  const { anchor, accounts } = picker;
  const width = Math.min(360, Math.max(180, anchor.width));
  const maxHeight = 280;
  const x = Math.max(4, Math.min(anchor.x, window.innerWidth - width - 4));
  const y = Math.max(
    4,
    Math.min(anchor.y + anchor.height + 4, window.innerHeight - maxHeight - 4),
  );

  return (
    <div
      id="autofillBackdrop"
      className="absolute inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          window.agentworkspace.autofillPickerClose();
        }
      }}
    >
      <section
        id="autofillPicker"
        className="absolute flex flex-col rounded-lg border border-[#39475a] bg-[#101722] shadow-xl"
        style={{ left: x, top: y, width, maxHeight }}
      >
        <header className="border-b border-[#39475a] px-3 py-2">
          <span className="text-[13px] font-semibold text-[#e8edf3]">Choose an account</span>
        </header>
        <div className="flex-1 overflow-y-auto">
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              data-account-id={account.id}
              className="block w-full px-3 py-2 text-left font-mono text-[12px] text-[#e8edf3] hover:bg-[#2a394d]"
              onClick={() => window.agentworkspace.autofillPick(account.id)}
            >
              {account.username}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
