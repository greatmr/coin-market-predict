import { z } from 'zod';

import { isChatId } from '../../telegram/access.service.js';

import { UuidSchema } from './common.dto.js';

/** `GET /api/telegram/missing`: reports a recipient did not receive in the last N hours (default 6). */
export const MissingQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(48).default(6),
});
export type MissingQueryDto = z.infer<typeof MissingQuerySchema>;

/** `POST /api/telegram/retry`: requeue unsent deliveries (one run / one chat, or everything recent). */
export const RetryBodySchema = z.object({
  runId: UuidSchema.optional(),
  chatId: z.string().trim().max(64).optional(),
});
export type RetryBodyDto = z.infer<typeof RetryBodySchema>;

/** `POST /api/telegram/send`: a fresh copy of a run's report to chosen recipients (default: all). */
export const SendBodySchema = z.object({
  runId: UuidSchema.optional(),
  chatIds: z.array(z.string().trim().max(64)).max(50).optional(),
});
export type SendBodyDto = z.infer<typeof SendBodySchema>;

/** `POST /api/telegram/access/:action`. */
export const AccessActionSchema = z.enum(['approve', 'reject', 'remove']);
export type AccessAction = z.infer<typeof AccessActionSchema>;

export const AccessBodySchema = z.object({
  chatId: z.string().trim().refine(isChatId, 'chatId must be a numeric Telegram chat id'),
});
export type AccessBodyDto = z.infer<typeof AccessBodySchema>;
