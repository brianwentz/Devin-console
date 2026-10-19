// Claude sidebar IPC: setupClaude() builds the store/registry/controller and
// registers the claude:* channels. Mutation channels are fire-and-forget
// guardedOn sends (failures surface as claude.lastError, same as cloud:*);
// claude:contextMenu is the one invoke.
import type { ZodType } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { guardedHandle, guardedOn, handleResult } from '../ipcGuard';
import {
  ClaudeAgentStopArg,
  ClaudeCancelArg,
  ClaudeContextMenuArg,
  ClaudeForkArg,
  ClaudeLoadHistoryArg,
  ClaudeNewSessionArg,
  ClaudeOpenArg,
  ClaudeOpenSubagentArg,
  ClaudeRecheckEnvArg,
  ClaudeSubagentsArg,
  HostsRefreshArg,
  HostsSetEnabledArg,
  ClaudePermissionArg,
  ClaudePromptArg,
  ClaudeRenameArg,
  ClaudeRevealTranscriptArg,
  ClaudeSessionArchiveArg,
  ClaudeSessionDeleteTranscriptArg,
  ClaudeWorkspaceAddArg,
  ClaudeSessionPinArg,
  LocalWorkspaceArg,
  WorkspaceRenameSchema,
  WorkspaceReorderSchema,
  ClaudeSessionRemoveArg,
  ClaudeSetModelArg,
  ClaudeSetPermissionModeArg,
  ClaudeShowArchivedArg,
  IpcChannels,
} from '../../shared/ipc';
import { setupClaudeSessions, type ClaudeSessions } from './sessions';
import { claudeHost } from './host';
import { publicChatState } from './chatState';
import { hosts } from '../hosts';

export function setupClaude(): ClaudeSessions {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const sessions = setupClaudeSessions({ configDir, userData: app.getPath('userData') });
  sessions.start();

  const on = <Arg>(
    channel: string,
    schema: ZodType<Arg>,
    run: (arg: Arg) => Promise<void> | void,
  ): void =>
    guardedOn(channel, (_event, payload: unknown) => {
      const parsed = schema.safeParse(payload);
      if (parsed.success) void run(parsed.data);
    });

  on(IpcChannels.claudeOpen, ClaudeOpenArg, ({ sessionId }) => sessions.open(sessionId));
  guardedOn(IpcChannels.claudeRefresh, () => {
    void sessions.refresh('shell');
  });
  on(IpcChannels.claudeRename, ClaudeRenameArg, ({ sessionId, title }) =>
    sessions.rename(sessionId, title),
  );
  on(IpcChannels.claudeFork, ClaudeForkArg, ({ sessionId }) => sessions.fork(sessionId));
  on(IpcChannels.claudeSessionPin, ClaudeSessionPinArg, ({ sessionId, pinned }) =>
    sessions.sessionPin(sessionId, pinned),
  );
  on(IpcChannels.claudeSessionArchive, ClaudeSessionArchiveArg, ({ sessionId, archive }) =>
    sessions.sessionArchive(sessionId, archive),
  );
  on(IpcChannels.claudeSessionRemove, ClaudeSessionRemoveArg, ({ sessionId }) =>
    sessions.sessionRemove(sessionId),
  );
  on(IpcChannels.claudeSessionDeleteTranscript, ClaudeSessionDeleteTranscriptArg, ({ sessionId }) =>
    sessions.sessionDeleteTranscript(sessionId),
  );
  on(IpcChannels.claudeRevealTranscript, ClaudeRevealTranscriptArg, ({ sessionId }) =>
    sessions.revealTranscript(sessionId),
  );
  // Invoke-style: preload uses ipcRenderer.invoke → LocalResult<null>.
  handleResult(IpcChannels.claudeWorkspaceAdd, ClaudeWorkspaceAddArg, ({ path }) =>
    sessions.workspaceAdd(path),
  );
  handleResult(IpcChannels.claudeWorkspaceReorder, WorkspaceReorderSchema, ({ paths }) =>
    sessions.workspaceReorder(paths),
  );
  handleResult(IpcChannels.claudeWorkspaceRename, WorkspaceRenameSchema, ({ path, label }) =>
    sessions.workspaceRename(path, label),
  );
  handleResult(IpcChannels.claudeWorkspaceRemove, LocalWorkspaceArg, ({ path }) =>
    sessions.workspaceRemove(path),
  );
  on(IpcChannels.claudeShowArchived, ClaudeShowArchivedArg, ({ value }) =>
    sessions.setShowArchived(value),
  );
  guardedHandle(IpcChannels.claudeContextMenu, (_event, payload: unknown) => {
    const parsed = ClaudeContextMenuArg.safeParse(payload);
    if (!parsed.success) return { action: null };
    return sessions.contextMenu(parsed.data);
  });

  // Chat channels — invoke → LocalResult via handleResult.
  guardedHandle(IpcChannels.claudeChatState, () => publicChatState());
  handleResult(IpcChannels.claudeNewSession, ClaudeNewSessionArg, ({ cwd }) =>
    sessions.newSession(cwd),
  );
  handleResult(IpcChannels.claudePrompt, ClaudePromptArg, ({ sessionId, text }) =>
    claudeHost().prompt(sessionId, text),
  );
  handleResult(IpcChannels.claudeCancel, ClaudeCancelArg, ({ sessionId }) =>
    claudeHost().cancel(sessionId),
  );
  handleResult(IpcChannels.claudePermission, ClaudePermissionArg, (arg) => {
    claudeHost().respondPermission(arg.sessionId, arg.requestId, arg.optionId);
  });
  handleResult(IpcChannels.claudeSetPermissionMode, ClaudeSetPermissionModeArg, (arg) =>
    claudeHost().setPermissionMode(arg.sessionId, arg.mode),
  );
  handleResult(IpcChannels.claudeSetModel, ClaudeSetModelArg, (arg) =>
    claudeHost().setModel(arg.sessionId, arg.model),
  );
  handleResult(IpcChannels.claudeLoadHistory, ClaudeLoadHistoryArg, ({ sessionId }) =>
    claudeHost().loadHistory(sessionId),
  );
  // Subagent transcripts.
  handleResult(IpcChannels.claudeSubagents, ClaudeSubagentsArg, ({ sessionId }) =>
    sessions.loadSubagents(sessionId),
  );
  handleResult(IpcChannels.claudeOpenSubagent, ClaudeOpenSubagentArg, (arg) =>
    sessions.openSubagent(arg.sessionId, arg.agentId),
  );
  // Background agents.
  handleResult(IpcChannels.claudeAgentStop, ClaudeAgentStopArg, ({ agentId }) =>
    sessions.agentStop(agentId),
  );
  guardedOn(IpcChannels.claudeAgentsRefresh, () => {
    void sessions.refreshAgents();
  });
  // Re-capture the §1.4 shell environment for the session's host.
  on(IpcChannels.claudeRecheckEnv, ClaudeRecheckEnvArg, ({ sessionId }) =>
    sessions.recheckEnv(sessionId),
  );

  // Execution hosts.
  guardedHandle(IpcChannels.hostsRefresh, (_event, payload: unknown) => {
    const parsed = HostsRefreshArg.safeParse(payload ?? {});
    if (parsed.success) void hosts().refresh(parsed.data.id);
  });
  guardedHandle(IpcChannels.hostsSetEnabled, (_event, payload: unknown) => {
    const parsed = HostsSetEnabledArg.safeParse(payload);
    if (parsed.success) hosts().setEnabled(parsed.data.id, parsed.data.enabled);
  });

  return sessions;
}
