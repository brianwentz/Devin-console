import { useEffect, useRef, useState } from 'react';
import type { Rect } from '../../core/layout';
import type { ShellState } from '../../shared/ipc';
import { TerminalView } from '../chat/TerminalView';

type TerminalEntry = ShellState['terminals'][number];

interface TerminalDockProps {
  // null/absent when the dock is hidden — the dock stays mounted so ptys and
  // scrollback survive toggles and surface switches.
  rect: Rect | null;
  terminals: TerminalEntry[];
  activeTerminalId: string | null;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function TerminalDock({ rect, terminals, activeTerminalId }: TerminalDockProps) {
  // Track dock visibility so a re-shown dock refocuses its active terminal.
  const visible = Boolean(rect);
  // Devin-kind ptys belong to LocalPanel's Terminal tab — the dock only hosts
  // user shell terminals.
  const shells = terminals.filter((entry) => entry.kind === 'shell');
  const activeId = shells.some((entry) => entry.id === activeTerminalId)
    ? activeTerminalId
    : (shells.at(-1)?.id ?? null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuLeft, setMenuLeft] = useState(0);
  const [cwdOptions, setCwdOptions] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<
    { guid: string; name: string; default: boolean; available: boolean }[]
  >([]);
  const sectionRef = useRef<HTMLElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !chevronRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const openMenu = () => {
    // The tab strip is an overflow-x scroller, so the menu lives as a sibling
    // (child of the absolute-positioned section) at top:30px, aligned to the
    // chevron — anything rendered inside the strip is clipped to nothing.
    const sectionRect = sectionRef.current?.getBoundingClientRect();
    const chevronRect = chevronRef.current?.getBoundingClientRect();
    if (sectionRect && chevronRect) {
      setMenuLeft(chevronRect.left - sectionRect.left);
    }
    setMenuOpen(true);
    void window.agentworkspace.terminalCwdOptions().then(setCwdOptions);
    void window.agentworkspace.terminalProfiles().then(setProfiles);
  };

  const openShell = (cwd: string | undefined, profile?: string) => {
    setMenuOpen(false);
    void window.agentworkspace
      .terminalOpen({
        kind: 'shell',
        ...(cwd === undefined ? {} : { cwd }),
        ...(profile === undefined ? {} : { profile }),
      })
      .then((result) => {
        if (result.ok) window.agentworkspace.terminalActivate(result.id);
      });
  };

  return (
    <section
      id="terminalDock"
      aria-label="Terminal dock"
      ref={sectionRef}
      className="shell-chrome absolute flex flex-col bg-[#0d141d] border-t border-[#39475a]"
      style={{
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        display: rect ? 'flex' : 'none',
      }}
    >
      <div
        id="terminalDockTabs"
        role="tablist"
        aria-label="Terminals"
        className="flex items-stretch h-[30px] flex-none min-w-0 bg-[#101722] border-b border-[#39475a] overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {shells.map((entry) => (
          <div
            key={entry.id}
            role="tab"
            aria-selected={entry.id === activeId}
            aria-label={entry.title}
            title={`${entry.profile ?? entry.title} — ${entry.cwd}`}
            className={`tab terminal-tab${entry.id === activeId ? ' active' : ''}`}
            data-terminal-tab={entry.id}
            onClick={(event) => {
              event.currentTarget.blur();
              window.agentworkspace.terminalActivate(entry.id);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                window.agentworkspace.terminalClose(entry.id);
              }
            }}
          >
            <span className="tabTitle">
              {baseName(entry.cwd)}
              {entry.exitCode !== null ? ` (exited)` : ''}
            </span>
            <button
              type="button"
              className="closeMark"
              aria-label={`Close ${entry.title}`}
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                window.agentworkspace.terminalClose(entry.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          id="terminalNew"
          type="button"
          aria-label="New terminal"
          title="New terminal (right-click for directory)"
          className="px-2.5 text-[#aeb9c8] hover:text-white self-stretch"
          tabIndex={-1}
          onClick={(event) => {
            event.currentTarget.blur();
            openShell(undefined);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu();
          }}
        >
          +
        </button>
        <button
          id="terminalNewCwd"
          type="button"
          aria-label="New terminal in…"
          aria-expanded={menuOpen}
          title="Choose directory"
          ref={chevronRef}
          className="px-1 text-[10px] text-[#7d8a99] hover:text-white self-stretch"
          tabIndex={-1}
          onClick={(event) => {
            event.currentTarget.blur();
            if (menuOpen) setMenuOpen(false);
            else openMenu();
          }}
        >
          ▾
        </button>
      </div>
      {menuOpen && (
        <div
          id="terminalNewMenu"
          ref={menuRef}
          className="absolute z-10 min-w-56 max-w-md overflow-y-auto rounded-md border border-[#39475a] bg-[#1a2330] py-1 shadow-lg"
          style={{
            top: 30,
            left: menuLeft,
            // Cap to the dock body (dock height minus the 30px tab strip).
            maxHeight: Math.max(60, (rect?.height ?? 0) - 34),
          }}
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[#7f8ca0]">
            Open in…
          </div>
          {cwdOptions.map((cwd) => (
            <button
              key={cwd}
              type="button"
              className="block w-full truncate px-3 py-1.5 text-left text-xs text-[#e8edf5] hover:bg-[#2a394d]"
              title={cwd}
              onClick={() => openShell(cwd)}
            >
              {baseName(cwd)}
              <span className="ml-2 text-[#7f8ca0]">{cwd}</span>
            </button>
          ))}
          {profiles.some((p) => p.available) && (
            <>
              <div className="mt-1 border-t border-[#39475a] px-3 py-1 text-[10px] uppercase tracking-wide text-[#7f8ca0]">
                Shell
              </div>
              {profiles
                .filter((p) => p.available)
                .map((p) => (
                  <button
                    key={p.guid}
                    type="button"
                    className="block w-full truncate px-3 py-1.5 text-left text-xs text-[#e8edf5] hover:bg-[#2a394d]"
                    title={p.name}
                    onClick={() => openShell(undefined, p.guid)}
                  >
                    {p.name}
                    {p.default && <span className="ml-2 text-[#7f8ca0]">(default)</span>}
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {shells.map((entry) => (
          <div
            key={entry.id}
            className="absolute inset-0 flex flex-col"
            style={{ display: entry.id === activeId ? 'flex' : 'none' }}
          >
            <TerminalView id={entry.id} active={visible && entry.id === activeId} />
            {entry.exitCode !== null && (
              <div className="absolute right-3 top-1.5 text-[11px] text-[#e0a03c]">
                exited (code {entry.exitCode})
              </div>
            )}
          </div>
        ))}
        {shells.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-[#7d8a99]">
            No terminals — press + to open a shell.
          </div>
        )}
      </div>
    </section>
  );
}
