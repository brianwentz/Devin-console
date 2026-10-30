// Tab Review IPC contract (re-exported from shared/ipc.ts). zod-only: this
// module must not import shared/ipc.ts (it is imported by it).
import { z } from 'zod';

export const ReviewChannels = {
  reviewClose: 'review:close',
  reviewShow: 'review:show',
} as const;

export const ReviewStatusSchema = z.enum(['reviewing', 'approved', 'changes', 'discussion', 'ended']);

export const ReviewTabArg = z.object({ tabId: z.string().min(1).max(128) });
export type ReviewTabArg = z.infer<typeof ReviewTabArg>;

export const ReviewCloseResultSchema = z.object({ ok: z.boolean() });
export type ReviewCloseResult = z.infer<typeof ReviewCloseResultSchema>;

// ShellState.reviewTerminal: the active tab's review strip (null = none shown).
export const ReviewTerminalSchema = z.object({
  tabId: z.string(),
  ptyId: z.string(),
  prLabel: z.string(),
  status: ReviewStatusSchema,
  hooksReachable: z.boolean(),
});
export type ReviewTerminalState = z.infer<typeof ReviewTerminalSchema>;
