import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { resolveTerminalKey } from '../../core/terminalKeys';
import { useShellState } from '../store';
import { buttonClass } from './Cards';

interface TerminalViewProps {
  // Host-owned pty id (see terminalHost). The view never opens or closes it.
  id: string;
  // When true, focus the xterm once it is displayed — callers pass it so typed
  // input lands in the terminal instead of staying on the invoking button.
  active?: boolean;
  // When provided, an exit banner offers to restart (LocalPanel's devin pty).
  onRestart?: () => void;
}

export function TerminalView({ id, active = false, onRestart }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<string>(id);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const kind =
    (useShellState()?.terminals ?? []).find((t) => t.id === id)?.kind ?? 'devin';

  useEffect(() => {
    idRef.current = id;
  }, [id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setExitCode(null);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      theme: {
        background: '#0d141d',
        foreground: '#e8edf5',
        cursor: '#83b6ff',
        selectionBackground: '#31455f',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Clickable URLs: routed like a chat markdown link (gh-tab / external),
    // never a window.open. Plain click activates.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        window.agentworkspace.localOpenLink(uri);
      }),
    );
    term.open(container);
    // Copy/paste go through the main-process clipboard; term.paste() emits the
    // (bracketed-paste wrapped) text through onData → terminalInput.
    const copySelection = () => {
      if (term.hasSelection()) {
        window.agentworkspace.clipboardWriteText(term.getSelection());
        term.clearSelection();
      }
    };
    const pasteClipboard = () => {
      void window.agentworkspace.clipboardReadText().then((text) => {
        if (text) term.paste(text);
      });
    };
    term.attachCustomKeyEventHandler((event) => {
      const action = resolveTerminalKey(event, {
        platform: window.agentworkspace.platform,
        hasSelection: term.hasSelection(),
      });
      if (action === 'copy') {
        copySelection();
        event.preventDefault();
        return false;
      }
      if (action === 'paste') {
        pasteClipboard();
        // Prevent the browser's native textarea paste — xterm would forward
        // it a second time on top of term.paste().
        event.preventDefault();
        return false;
      }
      return true;
    });
    termRef.current = term;
    term.onData((data) => {
      window.agentworkspace.terminalInput(idRef.current, data);
    });
    // OSC 0/2 titles become dock tab labels; never logged.
    term.onTitleChange((title) => {
      window.agentworkspace.terminalTitle(idRef.current, title);
    });
    try {
      fit.fit();
    } catch {
      // zero-size container
    }

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      window.agentworkspace.terminalResize(idRef.current, term.cols, term.rows);
    });
    observer.observe(container);

    const offData = window.agentworkspace.onTerminalData((payload) => {
      if (payload.id === idRef.current) term.write(payload.data);
    });
    const offExit = window.agentworkspace.onTerminalExit((payload) => {
      if (payload.id === idRef.current) setExitCode(payload.exitCode);
    });

    window.agentworkspace.terminalResize(id, term.cols, term.rows);

    return () => {
      offData();
      offExit();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      // The host pty stays alive — it is keyed by id and reused on remount.
    };
  }, [id]);

  // Focus after a rAF: the container may have just flipped display:none→flex.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {exitCode !== null && onRestart && (
        <div
          id="terminalExitBar"
          className="flex items-center gap-3 border-b border-[#39475a] bg-[#1a2330] px-3 py-1.5 text-xs text-[#e0a03c]"
        >
          {kind} exited (code {exitCode})
          <button type="button" className={buttonClass} onClick={onRestart}>
            Restart
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 px-1 pt-1"
        data-terminal-id={id}
        // Windows Terminal convention: right-click copies the xterm selection,
        // otherwise pastes. xterm's selection is not DOM selection, so the
        // shell context menu can't see it — and copy/paste go through the
        // main-process clipboard, not navigator.clipboard.
        onContextMenu={(event) => {
          event.preventDefault();
          const term = termRef.current;
          if (!term) return;
          if (term.hasSelection()) {
            window.agentworkspace.clipboardWriteText(term.getSelection());
            term.clearSelection();
          } else {
            void window.agentworkspace.clipboardReadText().then((text) => {
              if (text) term.paste(text);
            });
          }
        }}
      />
    </div>
  );
}
