// Persisted shape of a notification-center entry (notifications.json). Pure so
// it is unit-testable; zod strips unknown keys, so every field must be listed.
import { z } from 'zod';
import { NotificationSourceSchema, UsageMetricSchema } from './providers';

export const AppNotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(['waiting', 'approval', 'blocked', 'finished', 'pr-opened', 'pr-completed', 'update', 'identity', 'auth', 'usage', 'review']),
  sessionId: z.string().nullable(),
  ownerUserId: z.string().nullable().optional(),
  source: NotificationSourceSchema.optional(),
  sessionTitle: z.string(),
  metric: UsageMetricSchema.optional(),
  accountKey: z.string().optional(),
  prUrl: z.string().optional(),
  prState: z.string().optional(),
  reviewVerdict: z.enum(['approved', 'changes', 'discussion']).optional(),
  scope: z.string().optional(),
  version: z.string().optional(),
  title: z.string(),
  body: z.string(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
});
