// Claude sidebar IPC: setupClaude() builds the store/registry/controller and
// registers the claude:* channels. Mutation channels are fire-and-forget
// guardedOn sends (failures surface as claude.lastError, same as cloud:*);
// claude:contextMenu is the one invoke.
import type { ZodType } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { guardedHandle, guardedOn } from '../ipcGuard';
import {
  ClaudeContextMenuArg,
  ClaudeFolderCreateArg,
  ClaudeFolderDeleteArg,
  ClaudeFolderRenameArg,
  ClaudeFolderReorderArg,
  ClaudeForkArg,
  ClaudeOpenArg,
  ClaudeRenameArg,
  ClaudeRevealTranscriptArg,
  ClaudeSessionArchiveArg,
  ClaudeSessionDeleteTranscriptArg,
  ClaudeSessionMoveArg,
  ClaudeSessionPinArg,
  ClaudeSessionRemoveArg,
  ClaudeShowArchivedArg,
  IpcChannels,
} from '../../shared/ipc';
import { setupClaudeSessions, type ClaudeSessions } from './sessions';

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
  on(IpcChannels.claudeSessionMove, ClaudeSessionMoveArg, ({ sessionId, folder }) =>
    sessions.sessionMove(sessionId, folder),
  );
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
  on(IpcChannels.claudeFolderCreate, ClaudeFolderCreateArg, ({ name }) =>
    sessions.folderCreate(name),
  );
  on(IpcChannels.claudeFolderRename, ClaudeFolderRenameArg, ({ oldName, newName }) =>
    sessions.folderRename(oldName, newName),
  );
  on(IpcChannels.claudeFolderDelete, ClaudeFolderDeleteArg, ({ name }) =>
    sessions.folderDelete(name),
  );
  on(IpcChannels.claudeFolderReorder, ClaudeFolderReorderArg, ({ names }) =>
    sessions.folderReorder(names),
  );
  on(IpcChannels.claudeShowArchived, ClaudeShowArchivedArg, ({ value }) =>
    sessions.setShowArchived(value),
  );
  guardedHandle(IpcChannels.claudeContextMenu, (_event, payload: unknown) => {
    const parsed = ClaudeContextMenuArg.safeParse(payload);
    if (!parsed.success) return { action: null };
    return sessions.contextMenu(parsed.data);
  });

  return sessions;
}
