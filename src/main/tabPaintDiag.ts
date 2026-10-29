// Blank Linked Context pane diagnostics. A click on the tab that is already
// active is the user's workaround for a pane that shows only the dark
// background, so before that click re-attaches the view we record what the
// window looked like: where the view sits in the stack, its bounds, its
// renderer, and (Windows) the real on-screen pixels of the pane. The log holds
// numbers and booleans only — never the URL, title or pixel data.
import { desktopCapturer, screen, type WebContentsView } from 'electron';
import {
  captureRect,
  pixelStats,
  sameRect,
  stackInfo,
  type PixelStats,
} from '../core/tabPaintDiag';
import { log } from './log';
import { state } from './state';

const VISIBILITY_TIMEOUT_MS = 300;
// The click waits for the snapshot at most this long before re-attaching.
export const DIAG_BUDGET_MS = 1000;

let lastWindowFocusAt = 0;

export function noteWindowFocus(): void {
  lastWindowFocusAt = Date.now();
}

async function pageVisibility(view: WebContentsView): Promise<string> {
  try {
    const result = await Promise.race([
      view.webContents.executeJavaScript('document.visibilityState', false),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), VISIBILITY_TIMEOUT_MS)),
    ]);
    return typeof result === 'string' ? result : 'other';
  } catch {
    return 'error';
  }
}

// Desktop capture is Windows-only here: on macOS it would raise the
// screen-recording permission prompt.
async function panePixels(view: WebContentsView): Promise<PixelStats | { error: string } | null> {
  if (process.platform !== 'win32' || !state.windowRef) return null;
  try {
    const contentBounds = state.windowRef.getContentBounds();
    const viewBounds = view.getBounds();
    const display = screen.getDisplayMatching({
      x: contentBounds.x + viewBounds.x,
      y: contentBounds.y + viewBounds.y,
      width: viewBounds.width,
      height: viewBounds.height,
    });
    const size = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    if (!source) return { error: 'no-source' };
    const image = source.thumbnail;
    const rect = captureRect(contentBounds, viewBounds, display.bounds, display.scaleFactor, image.getSize());
    if (!rect) return { error: 'empty-rect' };
    return pixelStats(image.crop(rect).toBitmap());
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown' };
  }
}

// Logs `tab-reactivate-diag` for the active tab. Never rejects.
export async function diagnoseReactivate(): Promise<void> {
  const started = Date.now();
  const { windowRef, shellView, tabManager } = state;
  const view = tabManager?.activeView ?? null;
  if (!windowRef || !tabManager || !view) return;
  try {
    // Synchronous part first: nothing may restack between the click and this.
    const children = windowRef.contentView.children;
    const stack = stackInfo(
      children.map((child) => ({
        bounds: child.getBounds(),
        isShell: child === shellView,
        isTab: child === view,
      })),
    );
    const bounds = view.getBounds();
    const expected = tabManager.expectedBounds;
    const contents = view.webContents;
    const sync = {
      ...stack,
      width: bounds.width,
      height: bounds.height,
      boundsMatch: sameRect(bounds, expected),
      paneVisible: expected !== null,
      viewVisible: view.getVisible(),
      destroyed: contents.isDestroyed(),
      crashed: !contents.isDestroyed() && contents.isCrashed(),
      loading: !contents.isDestroyed() && contents.isLoading(),
      windowFocused: windowRef.isFocused(),
      windowMinimized: windowRef.isMinimized(),
      sinceAttachMs: tabManager.lastAttachedAt ? started - tabManager.lastAttachedAt : null,
      sinceWindowFocusMs: lastWindowFocusAt ? started - lastWindowFocusAt : null,
      surface: state.surface,
    };
    // Sequential: a screen capture in flight delays the renderer round-trip.
    const visibility = contents.isDestroyed() ? 'destroyed' : await pageVisibility(view);
    const captureStarted = Date.now();
    const pixels = await panePixels(view);
    log('shell', 'tab-reactivate-diag', {
      detail: {
        ...sync,
        visibility,
        pixels,
        captureMs: Date.now() - captureStarted,
        ms: Date.now() - started,
      },
    });
  } catch (error) {
    log('shell', 'tab-reactivate-diag', {
      detail: { error: error instanceof Error ? error.name : 'unknown', ms: Date.now() - started },
    });
  }
}

// Runs the diagnostics (bounded by DIAG_BUDGET_MS), then `then` — the normal
// activation. Only a click on the already-active tab is diagnosed.
export function withReactivateDiag(tabId: string, then: () => void): void {
  if (state.tabManager?.activeId !== tabId) {
    then();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    then();
  };
  setTimeout(finish, DIAG_BUDGET_MS);
  void diagnoseReactivate().finally(finish);
}
