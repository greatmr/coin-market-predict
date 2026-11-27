import { z } from 'zod';

import {
  CHAT_EFFORTS,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_MODEL_IDS,
} from '../../agent/chat/chat.constants.js';

import { UuidSchema } from './common.dto.js';

export const ChatSendSchema = z.object({
  /** Absent = start a new conversation. */
  conversationId: UuidSchema.optional(),
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  model: z.enum(CHAT_MODEL_IDS),
  effort: z.enum(CHAT_EFFORTS),
});
export type ChatSendDto = z.infer<typeof ChatSendSchema>;
