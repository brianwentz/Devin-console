import { useEffect } from 'react';
import { useShellState } from '../store';

const CARD_WIDTH = 340;

// Autofill save/update prompt — while open, main raises the shell view so the
// card sits over the hosted view, anchored to the view's top-right corner.
export function SavePasswordBanner() {
  const state = useShellState();
  const prompt = state?.autofill.prompt ?? null;

  useEffect(() => {
    if (!prompt) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.agentworkspace.autofillPromptResolve('dismiss');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt]);

  if (!prompt) return null;

  const host = new URL(prompt.origin).host;
  const x = Math.max(
    4,
    Math.min(prompt.anchor.x + prompt.anchor.width - CARD_WIDTH - 12, window.innerWidth - CARD_WIDTH - 4),
  );
  const y = Math.max(4, prompt.anchor.y + 12);

  return (
    // The backdrop swallows the first outside click by design — the shell is
    // raised above the hosted view while the prompt is open.
    <div
      id="autofillPromptBackdrop"
      className="absolute inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          window.agentworkspace.autofillPromptResolve('dismiss');
        }
      }}
    >
      <section
        id="autofillPrompt"
        className="absolute flex flex-col gap-2 rounded-lg border border-[#39475a] bg-[#101722] px-3 py-3 shadow-xl"
        style={{ left: x, top: y, width: CARD_WIDTH }}
      >
        <p className="text-[13px] text-[#e8edf3]">
          {prompt.kind === 'update'
            ? `Update password for ${host}?`
            : `Save password for ${host}?`}
        </p>
        <p className="font-mono text-[12px] text-[#7f8ca0]">
          {prompt.username || '(no username)'}
        </p>
        <div className="flex gap-2 pt-1">
          <button
            id="autofillPromptSave"
            type="button"
            className="px-3 py-1.5 rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] text-sm"
            onClick={() => window.agentworkspace.autofillPromptResolve('save')}
          >
            {prompt.kind === 'update' ? 'Update' : 'Save'}
          </button>
          <button
            id="autofillPromptDismiss"
            type="button"
            className="px-3 py-1.5 rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] text-sm"
            onClick={() => window.agentworkspace.autofillPromptResolve('dismiss')}
          >
            Not now
          </button>
        </div>
      </section>
    </div>
  );
}
