import { z } from 'zod';
import { ConversationStatus, Platform } from '../constants';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

export const listConversationsSchema = z.object({
  query: paginationQuerySchema.extend({
    platform: z.nativeEnum(Platform).optional(),
    status: z.nativeEnum(ConversationStatus).optional(),
    socialAccountId: objectIdSchema.optional(),
  }),
});

export const replyMessageSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    text: z.string().trim().min(1).max(2000),
  }),
});

export const updateConversationStatusSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    status: z.nativeEnum(ConversationStatus),
  }),
});
