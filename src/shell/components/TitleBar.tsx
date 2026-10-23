import { useEffect, useState } from 'react';
import { RAIL_WIDTH, TITLE_BAR_HEIGHT } from '../../core/layout';
import type { ShellState } from '../../shared/ipc';
import { NotificationBanner } from './NotificationBanner';
import { TabStrip } from './TabStrip';
import { useTabDrop } from './useTabDrop';
import { AgMark } from './icons/AgMark';

type Tab = ShellState['tabs']['tabs'][number];

interface TitleBarProps {
  windowWidth: number;
  paneVisible: boolean;
  paneX: number; // ghTab.x when the pane is visible
  paneWidth: number; // ghTab.width when the pane is visible
  tabs: Tab[];
  activeId: string | null;
}

interface WindowControlsOverlayLike {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

function windowControlsOverlay(): WindowControlsOverlayLike | null {
  const candidate = (navigator as { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay;
  return candidate ?? null;
}

const isMac = window.agentworkspace.platform === 'darwin';

// Width of the strip the OS caption buttons cover on the right. Measured from the
// overlay's titlebar rect when available; 138px is the standard win32 caption width.
// macOS has no caption buttons on the right (traffic lights are on the left).
const OVERLAY_FALLBACK = 138;

function measureOverlayReserve(): number {
  if (isMac) return 0;
  const overlay = windowControlsOverlay();
  if (!overlay) return OVERLAY_FALLBACK;
  const rect = overlay.getTitlebarAreaRect();
  return Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)));
}

function useOverlayReserve(): number {
  const [reserve, setReserve] = useState(measureOverlayReserve);
  useEffect(() => {
    const update = () => setReserve(measureOverlayReserve());
    window.addEventListener('resize', update);
    windowControlsOverlay()?.addEventListener('geometrychange', update);
    const overlay = windowControlsOverlay();
    return () => {
      window.removeEventListener('resize', update);
      overlay?.removeEventListener('geometrychange', update);
    };
  }, []);
  return reserve;
}

const navButton =
  'min-w-[29px] min-h-[26px] rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] leading-none disabled:hover:bg-[#1a2330]';

export function TitleBar({
  windowWidth,
  paneVisible,
  paneX,
  paneWidth,
  tabs,
  activeId,
}: TitleBarProps) {
  const overlayReserve = useOverlayReserve();
  const drop = useTabDrop();
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const dragRight = paneVisible ? paneX : windowWidth - overlayReserve;
  const paneSegmentWidth = paneVisible ? Math.max(0, paneWidth - overlayReserve) : 0;

  return (
    <header
      id="titleBar"
      className="shell-chrome app-drag absolute top-0 left-0 bg-[#101722]"
      style={{
        width: windowWidth,
        height: TITLE_BAR_HEIGHT,
      }}
    >
      <div
        className="absolute left-0 top-0 flex items-center justify-center text-[#7d8a99] text-[11px] font-semibold tracking-wide select-none"
        style={{ width: RAIL_WIDTH, height: '100%' }}
        title="Agent Workspace"
      >
        {/* the macOS traffic lights cover the left rail */}
        {!isMac && <AgMark size={20} />}
      </div>
      {/* drag space over the main column (extends to the overlay gap when the pane is hidden) */}
      <div
        className="absolute top-0 h-full"
        style={{ left: RAIL_WIDTH, width: Math.max(0, dragRight - RAIL_WIDTH) }}
      />
      <div
        className="pointer-events-none absolute top-0 h-full flex items-center justify-center [&>*]:pointer-events-auto"
        style={{ left: RAIL_WIDTH, width: Math.max(0, dragRight - RAIL_WIDTH) }}
      >
        <NotificationBanner />
      </div>
      {paneVisible && (
        <div
          className="app-no-drag absolute top-0 h-full flex items-stretch gap-1.5 pr-1.5"
          style={{ left: paneX, width: paneSegmentWidth }}
          {...drop.handlers}
        >
          <button
            id="backButton"
            type="button"
            aria-label="Back"
            className={navButton}
            disabled={!active?.canGoBack}
            onClick={() => window.agentworkspace.navigate('back')}
          >
            ←
          </button>
          <button
            id="forwardButton"
            type="button"
            aria-label="Forward"
            className={navButton}
            disabled={!active?.canGoForward}
            onClick={() => window.agentworkspace.navigate('forward')}
          >
            →
          </button>
          <button
            id="reloadButton"
            type="button"
            aria-label="Reload"
            className={navButton}
            disabled={!active}
            title="Reload (right-click: reload all tabs in this session)"
            onClick={() => window.agentworkspace.navigate('reload')}
            onContextMenu={(e) => {
              e.preventDefault();
              window.agentworkspace.openReloadMenu(e.clientX, e.clientY);
            }}
          >
            ↻
          </button>
          <TabStrip tabs={tabs} activeId={activeId} />
          {/* Outside the strip's scroll/sortable area; #tabFavorites follows it. */}
          <button
            id="tabNew"
            type="button"
            aria-label="New tab"
            title="New tab (Ctrl+T)"
            className={`app-no-drag shrink-0 self-center ${navButton}`}
            onClick={() =>
              window.agentworkspace.setAddressBar({ open: true, mode: 'new', source: 'button' })
            }
          >
            +
          </button>
          {drop.hint && (
            <div
              id="tabDropHint"
              role="status"
              data-state={drop.hint.state}
              className={`tabDropHint ${drop.hint.state} pointer-events-none absolute inset-0 flex items-center justify-center rounded-md text-[12px]`}
            >
              {drop.hint.state === 'drop' ? 'Drop to open in a new tab' : drop.hint.text}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
