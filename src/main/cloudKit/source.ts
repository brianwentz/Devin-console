// A REST-poll cloud session source (e.g. OpenHands Cloud) as the generic
// CloudSessionsController (./sessionsController.ts) drives it. Push/socket
// sources such as Devin Cloud (src/main/cloudSessions.ts) keep their own
// controller. Electron-free: sources get their transport injected.

import type { CloudSourceCapabilities } from '../../core/cloudKit/capabilities';
import type { CloudListData } from '../../core/sessionTree';

// One per-session mutation. `capabilities.rename` / `.delete` gate them — the
// controller refuses a mutation the source does not advertise.
export type CloudMutation = { op: 'rename'; id: string; title: string } | { op: 'delete'; id: string };

// Log sink: ids/counts/durations/codes only — never titles, paths, tokens or
// response text (see AGENTS.md "Conventions").
export type CloudSessionsLog = (event: string, detail: Record<string, unknown>) => void;

export interface CloudSessionSource {
  /** Provider registry id (src/core/providers.ts), e.g. 'openhands'. */
  providerId: string;
  capabilities: CloudSourceCapabilities;
  /** Begin any source-owned polling/watching; call `onChange` when the list
   * may have changed (the controller then refreshes, coalesced). */
  start(onChange: () => void): void;
  stop(): void;
  /** One full list. Rejects on transport/auth failure (the message is
   * sanitised by the controller before it reaches state). */
  list(): Promise<CloudListData>;
  /** Absent = read-only source. Resolves `ok:false` for a non-2xx answer. */
  mutate?(op: CloudMutation): Promise<{ ok: boolean; status: number }>;
  /** Credentials for side services (usage etc.) — not used by the controller. */
  readIdentity(): Promise<{ identity: unknown } | { reason: string }>;
}
