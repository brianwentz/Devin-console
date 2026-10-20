# Quiet test runs — the e2e window must not take over the desktop

Status: Approved (quiet on for CI too; Dock icon untouched); implementing

## 0. The ask

Running the Playwright suite pops the app window up and tears it down for every spec (≈ 140 launches in ~8 min), each time on top of whatever the user is doing and taking keyboard focus. Make test runs invisible and non-intrusive — don't bring the window to the front, run it elsewhere, or anything else that works — without making the suite less trustworthy.

## 1. Why it happens (verified)

- `src/main/index.ts` creates the `BaseWindow` with `show: true`, then in test mode `setContentSize(w, h)` + `center()`. A newly shown top-level window on Windows is activated: the process was started by the foreground process (the terminal / Playwright), so it is allowed to take the foreground. Measured with a pid-checked `GetForegroundWindow` probe: **baseline launch → the test Electron owns the foreground.**
- After launch, three code paths actively re-grab focus: `notifier.ts` (`show()` + `focus()` on notification click / open-PR, exercised by `notifications.spec`), `shortcuts.ts focusVisibleContents()` (`webContents.focus()`), and the `focus` test hook in `testHooks.ts` (which already carries the comment "on a background CI desktop the OS 'focus' event may never fire" — i.e. the suite is already written to pass without OS focus).
- Nothing in the suite needs the window to be *seen*: screenshots go through CDP (`page.screenshot`), keyboard input through CDP or `webContents.sendInputEvent`, clipboard through the main-process `clipboard` module, and DOM focus (`document.activeElement`) works without OS activation.

## 2. Options considered (with measurements)

| Option | Result | Verdict |
|---|---|---|
| **A. Show without activating + invisible on screen**: `show: false` → `showInactive()`, `setOpacity(0)`, `setSkipTaskbar(true)`, plus `--disable-features=CalculateNativeWinOcclusion` and `--disable-renderer-backgrounding` so Chromium doesn't throttle a window it considers occluded | Full suite under the spike: **143/144** (the 1 failure is the known `claudeDeferrals` fork load-flake, also seen on `main` the same morning). Foreground probe sampled every 0.5 s for the whole run: test app held the foreground in **24 of 1616 samples (≈ 12 s of 13.5 min)**, vs. continuously in baseline. The residue is the explicit `focus()`/`show()` calls in §1. | **Chosen**, plus gating those calls |
| B. Park the window off-screen (`setPosition(-32000,-32000)` or just below the primary display) | Window invisible, but **2 geometry specs fail** (`shell.spec` pane toggle: content width 1415 ≠ 1400; `cloudSessions` narrow-window collapse never fires): Windows reports/clamps bounds differently for windows not on a display, so resize-driven layout math breaks. | Rejected |
| C. `focusable: false` on the window | Also stops the steal, but it is not needed once A is in place (measured A without it: no steal), and it changes focus semantics for the input specs. | Not used |
| D. Second virtual desktop | No public Win32 API; needs the undocumented `IVirtualDesktopManagerInternal` COM interfaces (third-party PowerShell module, breaks across Windows builds), Windows-only, and still activates on creation before the move. | Rejected |
| E. Minimised / `show: false` for the whole run | Hidden/minimised windows are occluded → Chromium throttles timers and rAF, `page.screenshot` of a hidden `WebContentsView` returns blank/throws; `visibilitychange` would flip the shell's hidden-tab logic. | Rejected |
| F. Headless/offscreen rendering (`webPreferences.offscreen`) | Not available for `BaseWindow` + `WebContentsView` composition; would require a different rendering path only in tests. | Rejected |

## 3. Design

- **A test-only "quiet" mode, on by default for every test launch.** `DEVIN_WORKSPACES_TEST_QUIET` (`'1'` default when `DEVIN_WORKSPACES_TEST=1`; `'0'` to watch a run). `tests/e2e/helpers.ts launchApp` and `tests/smoke/installed.spec.ts` set nothing extra (default on); `npm run test:e2e:headed` (new script) passes `DEVIN_WORKSPACES_TEST_QUIET=0` for debugging. CI keeps the default (quiet) — the CI desktop never cared, but it removes one source of focus-related nondeterminism.
- **Window creation (`index.ts`)**: in quiet mode `show: false`; after the existing `setContentSize`/`center()` block: `setOpacity(0)`, `setSkipTaskbar(true)`, `showInactive()`. Command-line switches appended before `app.whenReady`: `disable-features=CalculateNativeWinOcclusion`, `disable-renderer-backgrounding`. Log `window-quiet { opacity: 0, skipTaskbar: true }` once so a run's event log shows which mode it used. Nothing changes outside test mode.
- **Focus/activation calls go through one helper** — `src/main/window.ts`: `export function activateWindow(reason: string): void` = `restore()` if minimised, then `quiet ? showInactive() : (show(), focus())`, logged `window-activate { reason, quiet }`; and `export function focusContents(contents, reason)` = no-op on the OS level in quiet mode but still calls `contents.focus()` (DOM focus; measured harmless) — actually `webContents.focus()` *can* activate the HWND, so in quiet mode route it through `contents.focus()` only after the window is already foreground, else skip and set `state.lastFocused` (the test hook already does this). Callers: `notifier.ts` (3 sites), `shortcuts.ts` (2), `testHooks.ts focus`, `claude/sessions.ts`/`local` if any `focus()` turns up in the audit (grep is the first task).
- **Shell side**: nothing — `document.activeElement`-based specs already pass (terminal.spec 6/6 under the spike).
- **Placement tracking**: `attachPlacementTracking` persists bounds/maximised; `placementEnabled()` is already off in test mode (`windowPlacement.ts:41`) — verify quiet mode doesn't change that (opacity/skipTaskbar are not persisted anyway).
- **Not touching**: the window-size fail-fast (`window-size` log + 1400 check) — it reads `getContentBounds()`, unaffected by opacity; `smoke-install.ps1` process handling (it finds the app by install dir, not by window).

## 4. Work (one PR, small; serial — no parallel streams needed)

1. `index.ts` quiet-mode creation + switches + log; `window.ts` `activateWindow`/`focusContents`; migrate the call sites found by `git grep -n "\.focus()\|\.show()" src/main`.
2. `tests/e2e/helpers.ts`: document the default; `package.json` `test:e2e:headed`; README "Running the tests" note + AGENTS env-table row for `DEVIN_WORKSPACES_TEST_QUIET` and the two switches.
3. Specs: `notifications.spec` cases that click a notification and assert the window came forward must assert `window-activate { reason }` in the log instead of `isFocused()` (check what they assert today — if they only check the view/surface, nothing changes). New `tests/e2e/quiet.spec.ts`: launches with the default and asserts `window-quiet` is logged, `getOpacity() === 0`, the window is not focused (`BaseWindow.isFocused()` false via `app.evaluate`), and — the real guard — a `page.screenshot` is non-blank and `setWindowSize` round-trips exactly (the two things options B/E broke). A second case with `DEVIN_WORKSPACES_TEST_QUIET=0` asserts opacity 1 (so the headed path keeps working).
4. Gate: typecheck · lint · unit · build · **full e2e twice** (once quiet default, once `test:e2e:headed`) · `smoke:install` (its spec sets `DEVIN_WORKSPACES_TEST=1`, so quiet applies to the installed app too — confirm the CDP-driven smoke spec still screenshots/interacts), plus the foreground probe from the spike run alongside the quiet suite: target **0 stolen samples** (the 24 residual ones are the §1 call sites).

## 5. Open questions

- **Q1 — Default on for CI too?** Recommendation: yes (one code path, and it removes focus nondeterminism). The only reason to keep CI headed would be if an occluded-window issue shows up only on the runner's display — the full-suite spike on this desktop says it doesn't.
- **Q2 — macOS**: `showInactive()` + opacity 0 work the same on macOS; `setSkipTaskbar` is a no-op there (Dock icon stays — `app.dock.hide()` in quiet mode if you want the icon gone too; it's one line, off by default in the plan). CI's macOS job doesn't run e2e, so this is only for local Mac runs.
