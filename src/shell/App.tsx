import { useEffect, useState } from 'react';
import { computeBounds, dockSurface, RAIL_WIDTH } from '../core/layout';
import { renderBadgeDataUrl } from './badge';
import { handleSettingsFlush } from './settingsDraft';
import { useShellState } from './store';
import { Rail } from './components/Rail';
import { NotificationPanel } from './components/NotificationPanel';
import { PrPanel } from './components/PrPanel';
import { AccountPicker } from './components/AccountPicker';
import { SavePasswordBanner } from './components/SavePasswordBanner';
import { TitleBar } from './components/TitleBar';
import { Splitter } from './components/Splitter';
import { TerminalDock } from './components/TerminalDock';
import { SettingsPanel } from './components/SettingsPanel';
import { SessionSidebar } from './components/SessionSidebar';
import { ClaudeSidebar } from './components/ClaudeSidebar';
import { ClaudeView } from './claude/ClaudeView';
import { LocalPanel } from './local/LocalPanel';
import { LocalSidebar } from './local/LocalSidebar';
import { AnalyticsTabs } from './components/AnalyticsTabs';
import { ClaudeAnalyticsTab } from './components/analytics/ClaudeAnalyticsTab';

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
  const bounds = computeBounds(size, {
    paneOpen: state.paneOpen,
    paneFraction: state.paneFraction,
    terminalOpen: terminalVisible,
    terminalHeight: state.terminalHeight,
    sessionsOpen:
      state.sessionsOpen &&
      (state.surface === 'cloud' || state.surface === 'claude' || state.surface === 'local'),
    sessionsWidth: state.sessionsWidth,
    analyticsTabs: state.surface === 'analytics',
  });
  const analyticsTab = state.settings.analytics.tab;
  const paneVisible = state.paneOpen && !bounds.paneCollapsed;
  const mainRect = bounds.devin;

  return (
    <>
      <Rail
        surface={state.surface}
        paneOpen={state.paneOpen}
        paneCollapsed={bounds.paneCollapsed}
        terminalOpen={state.terminalOpen}
      />
      {state.surface === 'cloud' && bounds.sessions && <SessionSidebar rect={bounds.sessions} />}
      {state.surface === 'claude' && bounds.sessions && <ClaudeSidebar rect={bounds.sessions} />}
      {state.surface === 'local' && bounds.sessions && <LocalSidebar rect={bounds.sessions} />}
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
        scope={state.tabs.scope}
      />
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
      {state.surface === 'claude' && (
        <ClaudeView
          style={{
            position: 'absolute',
            left: Math.max(RAIL_WIDTH, mainRect.x),
            top: mainRect.y,
            width: mainRect.width,
            height: mainRect.height,
          }}
        />
      )}
      {state.surface === 'analytics' && bounds.analyticsTabs && (
        <AnalyticsTabs
          rect={bounds.analyticsTabs}
          active={analyticsTab}
          onSelect={(tab) => void window.agentworkspace.setSettings({ analytics: { tab } })}
        />
      )}
      {state.surface === 'analytics' && analyticsTab === 'claude' && (
        <ClaudeAnalyticsTab
          style={{
            position: 'absolute',
            left: Math.max(RAIL_WIDTH, mainRect.x),
            top: mainRect.y,
            width: mainRect.width,
            height: mainRect.height,
          }}
        />
      )}
      {state.surface === 'local' && (
        <LocalPanel
          style={{
            position: 'absolute',
            left: Math.max(RAIL_WIDTH, mainRect.x),
            top: mainRect.y,
            width: mainRect.width,
            height: mainRect.height,
          }}
        />
      )}
    </>
  );
}
