import { useEffect, useState } from 'react';
import {
  computeBounds,
  dockSurface,
  RAIL_WIDTH,
  TITLE_BAR_HEIGHT,
} from '../core/layout';
import { addressBarShortcut } from '../core/addressBarKeys';
import { layoutStateFromShellState } from './layoutState';
import { PROVIDERS, providerBySurface } from '../core/providers';
import { PROVIDER_UI } from './providers';
import { renderBadgeDataUrl } from './badge';
import { handleSettingsFlush } from './settingsDraft';
import { useShellState } from './store';
import { Rail } from './components/Rail';
import { NotificationPanel } from './components/NotificationPanel';
import { PrPanel } from './components/PrPanel';
import { AccountPicker } from './components/AccountPicker';
import { SavePasswordBanner } from './components/SavePasswordBanner';
import { RemoteFolderPrompt } from './components/RemoteFolderInput';
import { TitleBar } from './components/TitleBar';
import { Splitter } from './components/Splitter';
import { TerminalDock } from './components/TerminalDock';
import { SettingsPanel } from './components/SettingsPanel';
import { AnalyticsTabs } from './components/AnalyticsTabs';
import { AddressBar } from './components/AddressBar';

// The shell's own Ctrl+T / Ctrl+L (Cmd on macOS). Main deliberately leaves
// them to the renderer: inside the terminal dock they are ^T / ^L for the pty,
// and in any other text field they keep their editing meaning.
function addressBarKeyAllowed(target: Element | null): boolean {
  if (!target || target === document.body) return true;
  if (target.id === 'tabAddressBarInput') return true;
  if (target.closest('#terminalDock, .xterm')) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  return !(
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function useAddressBarShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const kind = addressBarShortcut(
        {
          key: event.key,
          control: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
          alt: event.altKey,
        },
        window.agentworkspace.platform,
      );
      if (!kind || !addressBarKeyAllowed(document.activeElement)) return;
      event.preventDefault();
      window.agentworkspace.setAddressBar({ open: true, mode: kind, source: 'shortcut' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export function App() {
  const state = useShellState();
  const size = useWindowSize();
  useAddressBarShortcuts();

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      window.agentworkspace.openLink(target.href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Quit-time implicit save: main sends settings:flush inside shutdown().
  useEffect(() => window.agentworkspace.onSettingsFlush(handleSettingsFlush), []);

  // Taskbar badge: render the requested PNG here (canvas) and reply until the
  // acknowledged count matches — the reply re-converges a late-mounting shell.
  useEffect(() => {
    let stopped = false;
    const send = async (dataUrl: string | null): Promise<void> => {
      const want = await window.agentworkspace.badgeRendered(dataUrl);
      if (stopped) return;
      const rendered = renderBadgeDataUrl(want.count, want.size);
      if (rendered !== dataUrl) await send(rendered);
    };
    const off = window.agentworkspace.onBadgeRender((request) => {
      void send(renderBadgeDataUrl(request.count, request.size));
    });
    void send(null);
    return () => {
      stopped = true;
      off();
    };
  }, []);

  if (!state) return null;
  const terminalVisible = state.terminalOpen && dockSurface(state.surface);
  const bounds = computeBounds(size, layoutStateFromShellState(state));
  const analyticsTab = state.settings.analytics.tab;
  const paneVisible = state.paneOpen && !bounds.paneCollapsed;
  const mainRect = bounds.devin;
  // computeBounds moved the hosted tab down; the bar fills the gap above it.
  const addressBarRect =
    paneVisible && state.tabs.addressBar.open && bounds.ghTab
      ? {
          x: bounds.ghTab.x,
          y: TITLE_BAR_HEIGHT,
          width: bounds.ghTab.width,
          height: bounds.ghTab.y - TITLE_BAR_HEIGHT,
        }
      : null;
  const activeTabUrl =
    state.tabs.tabs.find((tab) => tab.id === state.tabs.activeId)?.url ?? null;
  const surfaceProvider = providerBySurface(state.surface);
  const Sidebar = surfaceProvider ? PROVIDER_UI[surfaceProvider.id].Sidebar : undefined;
  const Panel = surfaceProvider ? PROVIDER_UI[surfaceProvider.id].Panel : undefined;
  const analyticsProvider = PROVIDERS.find((p) => p.analyticsTab === analyticsTab);
  const AnalyticsPanel = analyticsProvider ? PROVIDER_UI[analyticsProvider.id].AnalyticsPanel : undefined;
  const mainStyle = {
    position: 'absolute' as const,
    left: Math.max(RAIL_WIDTH, mainRect.x),
    top: mainRect.y,
    width: mainRect.width,
    height: mainRect.height,
  };

  return (
    <>
      <Rail
        surface={state.surface}
        paneOpen={state.paneOpen}
        paneCollapsed={bounds.paneCollapsed}
        terminalOpen={state.terminalOpen}
      />
      {Sidebar && bounds.sessions && <Sidebar rect={bounds.sessions} />}
      {bounds.sessionsSplitter && (
        <Splitter axis="s" rect={bounds.sessionsSplitter} enabled={state.sessionsOpen} />
      )}
      <TitleBar
        windowWidth={size.width}
        paneVisible={paneVisible && bounds.ghTab !== null}
        paneX={bounds.ghTab?.x ?? 0}
        paneWidth={bounds.ghTab?.width ?? 0}
        tabs={state.tabs.tabs}
        activeId={state.tabs.activeId}
      />
      {addressBarRect && (
        <AddressBar
          key={state.tabs.addressBar.mode}
          rect={addressBarRect}
          mode={state.tabs.addressBar.mode}
          activeUrl={activeTabUrl}
        />
      )}
      {paneVisible && bounds.splitter && (
        <Splitter axis="x" rect={bounds.splitter} enabled={state.paneOpen} />
      )}
      <TerminalDock
        rect={terminalVisible ? bounds.terminal : null}
        terminals={state.terminals}
        activeTerminalId={state.activeTerminalId}
      />
      {terminalVisible && bounds.terminalSplitter && (
        <Splitter axis="y" rect={bounds.terminalSplitter} enabled={true} />
      )}
      <NotificationPanel />
      <PrPanel />
      <AccountPicker />
      <SavePasswordBanner />
      <RemoteFolderPrompt />
      {state.surface === 'settings' && (
        <SettingsPanel
          settings={state.settings}
          credentials={state.credentials}
          style={{
            position: 'absolute',
            left: Math.max(RAIL_WIDTH, mainRect.x),
            top: mainRect.y,
            width: mainRect.width,
            height: mainRect.height,
          }}
        />
      )}
      {Panel && <Panel style={mainStyle} />}
      {state.surface === 'analytics' && bounds.analyticsTabs && (
        <AnalyticsTabs
          rect={bounds.analyticsTabs}
          active={analyticsTab}
          onSelect={(tab) => void window.agentworkspace.setSettings({ analytics: { tab } })}
        />
      )}
      {state.surface === 'analytics' && AnalyticsPanel && <AnalyticsPanel style={mainStyle} />}
    </>
  );
}
