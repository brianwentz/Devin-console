import { useEffect, useRef, useState } from 'react';
import type { Rect } from '../../core/layout';
import type { AddressBarMode, OpenUserUrlReply } from '../../shared/ipc';

type Reason = Extract<OpenUserUrlReply, { ok: false }>['reason'];

const REASON_TEXT: Record<Reason, string> = {
  empty: 'Type a web address',
  scheme: 'Only http and https addresses can open here',
  'not-a-url': "That doesn't look like a web address",
  'too-long': 'That address is too long',
  invalid: "Couldn't open that address",
  unavailable: "Couldn't open that address",
};

interface AddressBarProps {
  rect: Rect;
  mode: AddressBarMode;
  // Prefill for mode 'current' (the active tab's URL).
  activeUrl: string | null;
}

// Linked Context address bar: a row under the title bar across the pane; main
// shrinks the hosted tab by the same height, so no shell raise is needed.
// Remounted per mode (key) so Ctrl+L / Ctrl+T re-prefill.
export function AddressBar({ rect, mode, activeUrl }: AddressBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(() => (mode === 'current' ? (activeUrl ?? '') : ''));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const submit = async () => {
    const reply = await window.agentworkspace.openUserUrl({
      url: value,
      source: 'typed',
      target: mode,
    });
    if (reply.ok) window.agentworkspace.setAddressBar({ open: false, source: 'enter' });
    else setError(REASON_TEXT[reply.reason]);
  };

  return (
    <div
      id="tabAddressBar"
      className="shell-chrome absolute flex items-center gap-2 border-b border-[#39475a] bg-[#101722] px-2"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <input
        id="tabAddressBarInput"
        ref={inputRef}
        type="text"
        spellCheck={false}
        autoComplete="off"
        aria-label="Web address"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'tabAddressBarError' : undefined}
        placeholder="Type a web address and press Enter"
        value={value}
        className="flex-1 min-w-0 h-6 px-2 rounded bg-[#141d29] border border-[#54749c] text-xs placeholder-[#5c6b80] focus:outline-none"
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            window.agentworkspace.setAddressBar({ open: false, source: 'escape' });
          }
        }}
        onBlur={() => window.agentworkspace.setAddressBar({ open: false, source: 'blur' })}
      />
      {error && (
        <span id="tabAddressBarError" role="alert" className="shrink-0 text-xs text-[#f28b82]">
          {error}
        </span>
      )}
    </div>
  );
}
