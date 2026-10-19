# Thin splitters

Status: Done — PR pending.

Small visual PR. The three resize controls (sessions column ↔ main column, main column ↔ GitHub pane, main column ↔ terminal dock) are drawn as a solid 6 px bar (`#2c3949`) at all times. They should read as a hairline when idle and only grow into a visible grab bar while hovered or being dragged.

## 0. Constraints that shape the design

| Fact | Consequence |
|---|---|
| `SPLITTER_WIDTH = 6` in `src/core/layout.ts` is both the layout gutter and the pointer hit area. Hosted `WebContentsView`s (Cloud, GitHub pane, Analytics) sit on top of the shell view, so the shell cannot receive pointer events outside the gutter — a "wider hit area than the visible line" has to live *inside* the gutter. | Keep the gutter at 6 px (a 4 px grab target is noticeably harder to hit with a mouse and impossible with touch). Change only what is painted. |
| `computeBounds`, `leftChrome`, `paneToggleWindowWidth`, the drag session in main and the e2e geometry assertions (`shell.spec.ts` splitter drag, `terminal.spec.ts` dock height = `height + splitter`) all derive from `SPLITTER_WIDTH`. | No geometry change → no `src/core`, no `src/main`, no e2e rect math touched. |
| The shell view is painted `#111827` behind everything; the sidebar/Claude columns paint their own backgrounds, the hosted views cover theirs. The gutter currently shows only the splitter div. | A transparent gutter shows the `#111827` shell background — the same colour as the title bar, so the gutter visually merges with the chrome and the hairline is the only edge the eye sees. |
| `Splitter.tsx` is the single component (`axis: 'x' | 's' | 'y'`), ids `#splitter`, `#sessionsSplitter`, `#terminalSplitter`, `role="separator"`. Drag state is already tracked (`dragging` ref + `body.dragging`/`body.dragging-y` classes). | One file for the visual, one CSS block. |

## 1. Design

- The splitter `div` keeps its rect (the 6 px gutter) and all pointer handlers, but becomes transparent (`bg-transparent`).
- A child element (or `::after` via a `.splitter` class in `styles.css`) draws the visible line, centred in the gutter:
  - idle: 1 px wide (vertical axes) / 1 px tall (`y`), colour `#2c3949` (the current bar colour, now a hairline — matches the sidebar's `border-[#1e2a38]` family);
  - hover (`:hover` on the gutter) and active drag: grows to the full 6 px and takes the accent `#6e9bd0` used today on hover; `transition: width/height 120ms, background-color 120ms` so it "swells" rather than pops. No transition when `prefers-reduced-motion`.
  - active drag is signalled by a `data-dragging` attribute set from the existing `dragging` ref transitions (pointerdown → true, pointerup/cancel/escape/`onDragReset` → false) so the bar stays thick while the pointer is captured even if it leaves the gutter.
- `enabled={false}` (pane closed / sessions closed): hairline only, no hover swell, `cursor: default` (today it still shows `col-resize` on a splitter that does nothing).
- Keyboard: unchanged (there is no keyboard resize today; `role="separator"` + `aria-label` stay).

## 2. Changes

| File | Change |
|---|---|
| `src/shell/components/Splitter.tsx` | Replace `bg-[#2c3949] hover:bg-[#6e9bd0]` with `splitter` class + `data-axis` + `data-dragging` + `data-enabled` attributes; render the inner line element; set `cursor` from `enabled`. Set/clear `data-dragging` at the four places the `dragging` ref flips. |
| `src/shell/styles.css` | `.splitter` block: transparent gutter; `.splitter > .splitter-line` absolutely centred (`left: 50%; transform: translateX(-50%)` for `x`/`s`, `top: 50%; translateY(-50%)` for `y`); idle 1 px; `.splitter[data-enabled="true"]:hover > .splitter-line, .splitter[data-dragging="true"] > .splitter-line` → full thickness + accent; `@media (prefers-reduced-motion: reduce)` disables the transition. |
| `tests/e2e/shell.spec.ts` | Extend the existing "splitter drag live-resizes…" test (or add one case): `#splitter` bounding box width is still 6 (gutter unchanged); the inner `.splitter-line` is 1 px idle, 6 px after `hover()`, 6 px with the accent during a drag (`data-dragging="true"` after `mouse.down`), back to 1 px after `mouse.up`. Check `#terminalSplitter` height likewise in `terminal.spec.ts` (one assertion). |
| `README.md` | No change — nothing user-facing beyond the look. |

## 3. Out of scope / rejected

- Reducing `SPLITTER_WIDTH` (rejected: shrinks the only hit area; touches layout math, persisted fractions and e2e geometry for a visual gain the hairline already delivers).
- Overlay/pseudo-element hit areas wider than the gutter (impossible over hosted views).
- Changing the `body.dragging` cursor behaviour.

## 4. Gates

`npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test tests/e2e/shell.spec.ts tests/e2e/terminal.spec.ts` (the specs that drag a splitter; no spec drags `#sessionsSplitter` today — the new case covers it), plus a manual screenshot of the three splitters idle / hovered / dragging attached to the PR.
