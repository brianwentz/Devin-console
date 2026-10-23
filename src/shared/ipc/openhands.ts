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
