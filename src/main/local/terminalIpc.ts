import { clipboard } from 'electron';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { guardedHandle, guardedOn } from '../ipcGuard';
import {
  ClipboardWriteArg,
  IpcChannels,
  TerminalActivateArg,
  TerminalCloseArg,
  TerminalInputArg,
  TerminalOpenArg,
  TerminalResizeArg,
  TerminalTitleArg,
} from '../../shared/ipc';
import { log } from '../log';
import { state } from '../state';
import { applyLayout, notifyShell } from '../window';
import { terminalHost } from './terminalHost';
import { getChatState } from '../claude/chatState';
import { claudeSessions } from '../claude/sessions';

// Handlers for the embedded terminal (P4b) and the F5 shell dock. Payloads are
// zod-validated; terminal content is never logged.
export function setupTerminalIpc(): void {
  guardedHandle(IpcChannels.terminalOpen, (_event, payload: unknown) => {
    const parsed = TerminalOpenArg.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'invalid payload' };
    if (parsed.data.kind === 'claude') {
      const arg = parsed.data;
      const chat = getChatState().sessions[arg.sessionId];
      // 'new' only for an in-memory session the host never started — anything
      // with a transcript resumes (claude -r <id>).
      const mode =
        arg.mode === 'attach' ? 'attach' : claudeSessions().terminalModeFor(arg.sessionId);
      return terminalHost.open({
        kind: 'claude',
        sessionId: arg.sessionId,
        mode,
        agentId: arg.agentId,
        cwd: chat?.cwd ?? null,
      });
    }
    return terminalHost.open(parsed.data);
  });
  guardedOn(IpcChannels.terminalInput, (_event, payload: unknown) => {
    const parsed = TerminalInputArg.safeParse(payload);
    if (!parsed.success) return;
    terminalHost.write(parsed.data.id, parsed.data.data);
  });
  guardedOn(IpcChannels.terminalResize, (_event, payload: unknown) => {
    const parsed = TerminalResizeArg.safeParse(payload);
    if (!parsed.success) return;
    terminalHost.resize(parsed.data.id, parsed.data.cols, parsed.data.rows);
  });
  guardedOn(IpcChannels.terminalClose, (_event, payload: unknown) => {
    const parsed = TerminalCloseArg.safeParse(payload);
    if (!parsed.success) return;
    terminalHost.close(parsed.data.id);
  });
  guardedHandle(IpcChannels.terminalList, () => terminalHost.list());
  guardedHandle(IpcChannels.terminalCwdOptions, () => terminalCwdOptions());
  guardedHandle(IpcChannels.terminalProfiles, () => terminalHost.profiles());
  guardedOn(IpcChannels.terminalTitle, (_event, payload: unknown) => {
    const parsed = TerminalTitleArg.safeParse(payload);
    if (!parsed.success) return;
    terminalHost.setTitle(parsed.data.id, parsed.data.title);
  });
  guardedOn(IpcChannels.terminalToggle, () => {
    state.terminalOpen = !state.terminalOpen;
    log('shell', 'terminal-toggle', { detail: { open: state.terminalOpen } });
    applyLayout();
  });
  guardedOn(IpcChannels.terminalActivate, (_event, payload: unknown) => {
    const parsed = TerminalActivateArg.safeParse(payload);
    if (!parsed.success) return;
    if (!terminalHost.list().some((entry) => entry.id === parsed.data.id)) return;
    state.activeTerminalId = parsed.data.id;
    notifyShell();
  });
  // Terminal copy/paste rides the OS clipboard; only op + length are logged.
  guardedHandle(IpcChannels.clipboardReadText, async () => {
    const text = (await clipboard.readText()).slice(0, 65536);
    log('shell', 'terminal-clipboard', { detail: { op: 'paste', length: text.length } });
    return text;
  });
  guardedOn(IpcChannels.clipboardWriteText, (_event, payload: unknown) => {
    const parsed = ClipboardWriteArg.safeParse(payload);
    if (!parsed.success) return;
    clipboard.writeText(parsed.data.text);
    log('shell', 'terminal-clipboard', { detail: { op: 'copy', length: parsed.data.text.length } });
  });
}

// Shared by the dock's "+" menu and the host's default cwd.
export function terminalCwdOptions(): string[] {
  return [...(state.settings?.current.workspaces ?? []).map((w) => resolve(w)), resolve(homedir())];
}
