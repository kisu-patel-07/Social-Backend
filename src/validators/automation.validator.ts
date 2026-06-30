import { z } from 'zod';
import { AutomationStatus, KeywordMatchType, Platform } from '../constants';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

const keywordsSchema = z
  .array(z.string().trim().min(1).max(60).toLowerCase())
  .min(1, 'At least one keyword is required')
  .max(50, 'Too many keywords')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'Duplicate keywords are not allowed',
  });

export const createAutomationSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    socialAccountId: objectIdSchema,
    platform: z.nativeEnum(Platform),
    targetPostId: z.string().trim().max(200).optional(),
    keywords: keywordsSchema,
    matchType: z.nativeEnum(KeywordMatchType).optional(),
    publicReply: z.string().trim().min(1).max(2000),
    privateMessage: z.string().trim().min(1).max(2000),
    status: z.nativeEnum(AutomationStatus).optional(),
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
