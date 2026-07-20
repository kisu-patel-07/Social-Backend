import { z } from 'zod';
import { AutomationStatus, AutomationTrigger, KeywordMatchType, Platform } from '../constants';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

const keywordsSchema = z
  .array(z.string().trim().min(1).max(60).toLowerCase())
  .min(1, 'At least one keyword is required')
  .max(50, 'Too many keywords')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'Duplicate keywords are not allowed',
  });

export const createAutomationSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(120),
      socialAccountId: objectIdSchema,
      platform: z.nativeEnum(Platform),
      triggerType: z.nativeEnum(AutomationTrigger).optional(),
      targetPostId: z.string().trim().max(200).optional(),
      keywords: z
        .array(z.string().trim().min(1).max(60).toLowerCase())
        .max(50, 'Too many keywords')
        .default([])
        .refine((arr) => new Set(arr).size === arr.length, {
          message: 'Duplicate keywords are not allowed',
        }),
      matchType: z.nativeEnum(KeywordMatchType).optional(),
      // Optional for DM-triggered automations (no comment to reply to).
      publicReply: z.string().trim().max(2000).optional(),
      privateMessage: z.string().trim().min(1).max(2000),
      status: z.nativeEnum(AutomationStatus).optional(),
    })
    .refine(
      (b) =>
        b.triggerType === AutomationTrigger.DM ||
        b.triggerType === AutomationTrigger.STORY ||
        Boolean(b.publicReply?.trim()),
      { message: 'publicReply is required for comment-triggered automations' }
    )
    // Only story automations may run keyword-less ("reply to every story reply").
    .refine((b) => b.triggerType === AutomationTrigger.STORY || b.keywords.length > 0, {
      message: 'At least one keyword is required',
    }),
});

export const updateAutomationSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    targetPostId: z.string().trim().max(200).optional(),
    keywords: keywordsSchema.optional(),
    matchType: z.nativeEnum(KeywordMatchType).optional(),
    publicReply: z.string().trim().min(1).max(2000).optional(),
    privateMessage: z.string().trim().min(1).max(2000).optional(),
    status: z.nativeEnum(AutomationStatus).optional(),
  }),
});

export const listAutomationsSchema = z.object({
  query: paginationQuerySchema.extend({
    platform: z.nativeEnum(Platform).optional(),
    status: z.nativeEnum(AutomationStatus).optional(),
    socialAccountId: objectIdSchema.optional(),
  }),
});

export const toggleAutomationSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({ status: z.nativeEnum(AutomationStatus) }),
});
