import { normalizeOrigin } from '../core/credentials';
import {
  AutofillPickerSchema,
  AutofillPickSchema,
  AutofillPromptResolveSchema,
  AutofillQuerySchema,
  AutofillSubmittedSchema,
  IpcChannels,
} from '../shared/ipc';
import { guardedOn, hostedHandle, hostedOn } from './ipcGuard';
import { cloudViews } from './cloudViews';
import { log } from './log';
import { fixtureOrigins, state, testMode } from './state';
import { applyLayout, lowerShell, notifyShell, overlayOpen, raiseShell } from './window';

// Test-only knobs (AGENT_WORKSPACE_TEST=1): PROMPT_MS shortens the show-delay
// fallback; DISMISS_MS shortens the 10 s auto-dismiss.
const testOverrideMs = (name: string): number | null => {
  const value = testMode ? Number(process.env[name]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};
const SHOW_FALLBACK_MS = () => testOverrideMs('AGENT_WORKSPACE_TEST_AUTOFILL_PROMPT_MS') ?? 1500;
const PROMPT_DISMISS_MS = () => testOverrideMs('AGENT_WORKSPACE_TEST_AUTOFILL_DISMISS_MS') ?? 10_000;
const PENDING_TTL_MS = 60_000;

// Navigation of the sender dismisses its picker; teardown dismisses both its
// picker and its prompt. Listeners are armed once per sender and only fire
// while that sender owns the overlay.
const armedSenders = new WeakSet<Electron.WebContents>();
function armSenderClose(sender: Electron.WebContents): void {
  if (armedSenders.has(sender)) return;
  armedSenders.add(sender);
  const closePicker = () => {
    if (state.autofillPicker?.sender === sender) closeAutofillPicker();
  };
  sender.on('did-start-navigation', closePicker);
  sender.on('destroyed', () => {
    closePicker();
    if (state.autofillPrompt?.sender === sender) closeAutofillPrompt();
  });
}

export function closeAutofillPicker(): void {
  if (!state.autofillPicker) return;
  state.autofillPicker = null;
  if (state.shuttingDown) return;
  if (!overlayOpen()) lowerShell();
  applyLayout();
}

// Pending captures outlive overlay churn: they're dropped only on resolve,
// replacement by a new submit from the same sender, sender destroy, or TTL —
// never by tab/scope/surface switches (the devin view's own navigation can
// trigger a scope switch while a pending capture is still arming).
function dropPending(): void {
  const pending = state.autofillPending;
  if (!pending) return;
  state.autofillPending = null;
  for (const timer of pending.timers) clearTimeout(timer);
  pending.unlisten();
}

// Closes a *shown* prompt only — a pending capture is untouched.
export function closeAutofillPrompt(): void {
  const prompt = state.autofillPrompt;
  if (!prompt) return;
  clearTimeout(prompt.dismissTimer);
  state.autofillPrompt = null;
  if (state.shuttingDown) return;
  if (!overlayOpen()) lowerShell();
  applyLayout();
}

// Dismisses every shown autofill overlay (surface switch).
export function closeAutofillOverlays(): void {
  closeAutofillPicker();
  closeAutofillPrompt();
}

// Called once shutdown starts: clears every overlay/pending timer and
// listener so nothing restacks views while webContents are being destroyed.
export function disposeAutofill(): void {
  if (state.autofillPrompt) clearTimeout(state.autofillPrompt.dismissTimer);
  state.autofillPrompt = null;
  state.autofillPicker = null;
  dropPending();
}

// Tab activate/close/scope switch: dismiss only overlays anchored to a tab
// view that is no longer the active tab. A devin-view-anchored overlay (e.g.
// a capture pending through an SSO redirect that flips the scope) survives.
export function closeAutofillOverlaysForInactiveTabs(): void {
  // Only the ACTIVE pooled Cloud view counts as live — overlays anchored to a
  // pooled background view are stale.
  const devin = state.devinView?.webContents ?? null;
  const active = state.tabManager?.activeWebContents ?? null;
  const stale = (sender: Electron.WebContents) => sender !== devin && sender !== active;
  if (state.autofillPicker && stale(state.autofillPicker.sender)) closeAutofillPicker();
  if (state.autofillPrompt && stale(state.autofillPrompt.sender)) closeAutofillPrompt();
}

function senderView(sender: Electron.WebContents): Electron.WebContentsView | null {
  const pooled = cloudViews()
    .views()
    .find((v) => v.webContents === sender);
  if (pooled) return pooled;
  return state.tabManager?.getViews().find((v) => v.webContents === sender) ?? null;
}

function showPrompt(pending: NonNullable<typeof state.autofillPending>): void {
  if (state.autofillPending !== pending || senderView(pending.sender) === null) {
    return;
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    dropPending();
    return;
  }
  pending.unlisten();
  for (const timer of pending.timers) clearTimeout(timer);
  pending.timers = [];
  armSenderClose(pending.sender);
  const view = senderView(pending.sender)!;
  // The prompt replaces any open picker.
  if (state.autofillPicker) {
    state.autofillPicker = null;
  }
  state.autofillPrompt = {
    sender: pending.sender,
    kind: pending.kind,
    origin: pending.origin,
    username: pending.username ?? '',
    anchor: view.getBounds(),
    dismissTimer: setTimeout(() => {
      log('shell', 'autofill-dismiss', {
        detail: { origin: pending.origin, kind: pending.kind, reason: 'timeout' },
      });
      closeAutofillPrompt();
    }, PROMPT_DISMISS_MS()),
  };
  raiseShell();
  notifyShell();
  log('shell', 'autofill-prompt', {
    detail: { origin: pending.origin, kind: pending.kind },
  });
}

export function setupAutofillIpc(): void {
  // Never return or log usernames/hints — the response carries {id, username}
  // pairs only, and the log event carries counts + the origin.
  hostedHandle(IpcChannels.autofillQuery, async (event, payload: unknown) => {
    const parsed = AutofillQuerySchema.safeParse(payload);
    if (!parsed.success || !state.credentials) return undefined;
    const origin = normalizeOrigin(event.senderFrame?.url ?? '', fixtureOrigins);
    if (!origin) return undefined;
    const accounts = state.credentials.forOrigin(origin);
    const hint = parsed.data.hint;
    const candidates = hint ? accounts.filter((entry) => entry.username === hint) : accounts;
    const pool = candidates.length ? candidates : accounts;
    let fill: { id: string; username: string; password: string | null } | null = null;
    if (pool.length === 1) {
      const entry = pool[0]!;
      const password = parsed.data.hasPassword
        ? await state.credentials.reveal(entry.id)
        : null;
      fill = { id: entry.id, username: entry.username, password };
      if (password !== null) state.credentials.touch(entry.id);
    }
    log('shell', 'autofill-query', {
      detail: {
        origin,
        accounts: accounts.length,
        filled: fill !== null,
        password: parsed.data.hasPassword && fill !== null,
      },
    });
    return {
      accounts: accounts.map((entry) => ({ id: entry.id, username: entry.username })),
      fill,
    };
  });

  hostedOn(IpcChannels.autofillPicker, (event, payload: unknown) => {
    const parsed = AutofillPickerSchema.safeParse(payload);
    if (!parsed.success || !state.credentials || !state.windowRef) return;
    const sender = event.sender;
    const origin = normalizeOrigin(event.senderFrame?.url ?? '', fixtureOrigins);
    if (!origin) return;
    const accounts = state.credentials.forOrigin(origin);
    if (accounts.length < 2) return;
    const view = senderView(sender);
    if (!view) return;
    const bounds = view.getBounds();
    const zoom = sender.getZoomFactor();
    const rect = parsed.data.rect;
    state.autofillPicker = {
      sender,
      accounts: accounts.map((entry) => ({ id: entry.id, username: entry.username })),
      anchor: {
        x: Math.round(bounds.x + rect.x * zoom),
        y: Math.round(bounds.y + rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      },
    };
    armSenderClose(sender);
    raiseShell();
    notifyShell();
    log('shell', 'autofill-picker', { detail: { origin, accounts: accounts.length } });
  });

  hostedOn(IpcChannels.autofillSubmitted, (event, payload: unknown) => {
    const parsed = AutofillSubmittedSchema.safeParse(payload);
    if (!parsed.success || !state.credentials) return;
    const sender = event.sender;
    const origin = normalizeOrigin(event.senderFrame?.url ?? '', fixtureOrigins);
    if (!origin) return;
    const { username, password } = parsed.data;
    void (async () => {
      const credentials = state.credentials!;
      const accounts = credentials.forOrigin(origin);
      const existing = username
        ? accounts.find((entry) => entry.username === username)
        : accounts.length === 1
          ? accounts[0]
          : undefined;
      if (existing) {
        const current = await credentials.reveal(existing.id);
        if (sender.isDestroyed()) return;
        if (current === password) {
          log('shell', 'autofill-capture', {
            detail: { origin, result: 'unchanged' },
          });
          return;
        }
      }
      if (state.autofillPending?.sender === sender) dropPending();
      const pending = {
        sender,
        origin,
        username,
        password,
        kind: (existing ? 'update' : 'save') as 'save' | 'update',
        createdAt: Date.now(),
        timers: [] as NodeJS.Timeout[],
        unlisten: () => {
          sender.off('did-navigate', show);
          sender.off('did-navigate-in-page', show);
          sender.off('did-finish-load', show);
          sender.off('destroyed', drop);
        },
      };
      const show = () => showPrompt(pending);
      const drop = () => {
        if (state.autofillPending === pending) {
          state.autofillPending = null;
          pending.unlisten();
          for (const timer of pending.timers) clearTimeout(timer);
        }
      };
      sender.on('did-navigate', show);
      sender.on('did-navigate-in-page', show);
      sender.on('did-finish-load', show);
      sender.once('destroyed', drop);
      pending.timers.push(setTimeout(show, SHOW_FALLBACK_MS()));
      state.autofillPending = pending;
      log('shell', 'autofill-capture', { detail: { origin, result: pending.kind } });
    })();
  });

  guardedOn(IpcChannels.autofillPick, (_event, payload: unknown) => {
    const parsed = AutofillPickSchema.safeParse(payload);
    const picker = state.autofillPicker;
    if (!parsed.success || !picker || picker.sender.isDestroyed() || !state.credentials) {
      return;
    }
    const account = picker.accounts.find((entry) => entry.id === parsed.data.id);
    if (!account) return;
    const sender = picker.sender;
    void state.credentials.reveal(account.id).then((password) => {
      if (password === null || sender.isDestroyed()) return;
      sender.send(IpcChannels.autofillFill, {
        id: account.id,
        username: account.username,
        password,
      });
      state.credentials?.touch(account.id);
    });
    closeAutofillPicker();
  });

  guardedOn(IpcChannels.autofillPickerClose, () => closeAutofillPicker());

  guardedOn(IpcChannels.autofillPromptResolve, (_event, payload: unknown) => {
    const parsed = AutofillPromptResolveSchema.safeParse(payload);
    const pending = state.autofillPending;
    const prompt = state.autofillPrompt;
    if (!parsed.success || !pending || !prompt || !state.credentials) return;
    if (parsed.data.action === 'save') {
      const { origin, username, password, kind } = pending;
      void state.credentials
        .add({ origin, username: username ?? '', password })
        .then(() => notifyShell())
        .catch((error: unknown) => {
          log('shell', 'autofill-save-failed', {
            detail: { origin, message: error instanceof Error ? error.message : String(error) },
          });
        });
      log('shell', 'autofill-save', { detail: { origin, kind } });
    } else {
      log('shell', 'autofill-dismiss', {
        detail: { origin: pending.origin, kind: pending.kind },
      });
    }
    closeAutofillPrompt();
    dropPending();
  });
}
