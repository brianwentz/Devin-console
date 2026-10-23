// OpenHands Cloud IPC contract (re-exported from shared/ipc.ts). zod-only: this
// module must not import shared/ipc.ts (it is imported by it).
import { z } from 'zod';

export const OpenHandsChannels = {
  // Explicit Settings actions; replies are `{ ok }` only — the key never leaves main.
  openhandsApiKeySet: 'openhands:apiKeySet',
  openhandsApiKeyClear: 'openhands:apiKeyClear',
} as const;

// openhands:apiKeySet payload. Never logged or echoed back.
export const OpenHandsApiKeySetArg = z.object({ value: z.string().trim().min(1).max(4096) });
export type OpenHandsApiKeySet = z.infer<typeof OpenHandsApiKeySetArg>;

export const OpenHandsApiKeyResultSchema = z.object({ ok: z.boolean() });
export type OpenHandsApiKeyResult = z.infer<typeof OpenHandsApiKeyResultSchema>;

// How the OpenHands source authenticates (Settings `#openhandsConnectionStatus[data-status]`).
export const OPENHANDS_CONNECTIONS = [
  'idle',
  'api-key',
  'api-key-rejected',
  'api-key-required',
  'web-session',
  'login-required',
  'error',
] as const;
export const OpenHandsConnectionSchema = z.enum(OPENHANDS_CONNECTIONS);
export type OpenHandsConnection = z.infer<typeof OpenHandsConnectionSchema>;

export const OpenHandsStatusSchema = z.enum(['idle', 'connecting', 'ready', 'error']);
export type OpenHandsStatus = z.infer<typeof OpenHandsStatusSchema>;

// Sidebar -> main (all shell-only, guarded). Ids are conversation ids (never logged with titles).
export const OpenHandsSidebarChannels = {
  openhandsOpen: 'openhands:open',
  openhandsNewSession: 'openhands:newSession',
  openhandsOpenHome: 'openhands:openHome',
  openhandsRefresh: 'openhands:refresh',
  openhandsRename: 'openhands:rename',
  openhandsSessionReorder: 'openhands:sessionReorder',
  openhandsContextMenu: 'openhands:contextMenu',
} as const;

const OpenHandsSessionId = z.string().min(1).max(128);
export const OpenHandsOpenArg = z.object({ id: OpenHandsSessionId });
export const OpenHandsRenameArg = z.object({
  id: OpenHandsSessionId,
  title: z.string().trim().min(1).max(200),
});
export const OpenHandsSessionReorderArg = z.object({
  section: z.string().min(1).max(256),
  ids: z.array(z.string().max(128)).max(500),
});
export const OpenHandsContextMenuArg = z.object({
  kind: z.enum(['session', 'header']),
  sessionId: OpenHandsSessionId.optional(),
  x: z.number().finite(),
  y: z.number().finite(),
});
export type OpenHandsContextMenuRequest = {
  kind: 'session' | 'header';
  sessionId?: string;
  x: number;
  y: number;
};
// `rename` is completed in the shell (inline input); everything else runs in main.
export type OpenHandsContextMenuResult = { action: 'rename' | null };
