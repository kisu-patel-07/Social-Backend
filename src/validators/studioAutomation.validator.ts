import { z } from 'zod';
import {
  Platform,
  StudioAutomationStatus,
  StudioKeywordMode,
  StudioPostScope,
} from '../constants';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

const keywordListSchema = z
  .array(z.string().trim().min(1).max(60).toLowerCase())
  .max(50, 'Too many keywords')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'Duplicate keywords are not allowed',
  });

const buttonSchema = z.object({
  title: z.string().trim().min(1, 'Button label is required').max(20),
  url: z.string().trim().url('Button link must be a valid URL').max(500),
});

const repliesSchema = z.array(z.string().trim().min(1).max(2000)).max(5, 'Up to 5 reply variations');

/** Cross-field rules shared by create and update payloads. */
function assertStudioRules(
  data: {
    postScope?: StudioPostScope;
    postIds?: string[];
    keywordMode?: StudioKeywordMode;
    keywords?: string[];
    publicReplyEnabled?: boolean;
    publicReplies?: string[];
    dmMessage?: string;
    dmButtons?: Array<{ title: string; url: string }>;
  },
  ctx: z.RefinementCtx
): void {
  if (data.postScope === StudioPostScope.SPECIFIC && !(data.postIds ?? []).length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['postIds'],
      message: 'Pick at least one post, or switch to "All posts"',
    });
  }
  if (data.keywordMode !== StudioKeywordMode.ANY && data.keywords && !data.keywords.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['keywords'],
      message: 'Add at least one keyword, or trigger on any comment',
    });
  }
  if (data.publicReplyEnabled && data.publicReplies && !data.publicReplies.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicReplies'],
      message: 'Add at least one public reply, or turn public replies off',
    });
  }
  // Meta's button template caps the accompanying text at 640 characters.
  if ((data.dmButtons ?? []).length && (data.dmMessage ?? '').length > 640) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dmMessage'],
      message: 'DMs with buttons are limited to 640 characters',
    });
  }
}

const createBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    socialAccountId: objectIdSchema,
    platform: z.nativeEnum(Platform),
    postScope: z.nativeEnum(StudioPostScope).default(StudioPostScope.ALL),
    postIds: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    keywordMode: z.nativeEnum(StudioKeywordMode).default(StudioKeywordMode.CONTAINS),
    keywords: keywordListSchema.default([]),
    excludeKeywords: keywordListSchema.default([]),
    publicReplyEnabled: z.boolean().default(true),
    publicReplies: repliesSchema.default([]),
    dmMessage: z.string().trim().min(1).max(2000),
    dmButtons: z.array(buttonSchema).max(3, 'Up to 3 buttons').default([]),
    oncePerUser: z.boolean().default(false),
    templateKey: z.string().trim().max(60).optional(),
    status: z.nativeEnum(StudioAutomationStatus).optional(),
  })
  .superRefine(assertStudioRules);

export const createStudioAutomationSchema = z.object({ body: createBodySchema });

const updateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    postScope: z.nativeEnum(StudioPostScope).optional(),
    postIds: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    keywordMode: z.nativeEnum(StudioKeywordMode).optional(),
    keywords: keywordListSchema.optional(),
    excludeKeywords: keywordListSchema.optional(),
    publicReplyEnabled: z.boolean().optional(),
    publicReplies: repliesSchema.optional(),
    dmMessage: z.string().trim().min(1).max(2000).optional(),
    dmButtons: z.array(buttonSchema).max(3, 'Up to 3 buttons').optional(),
    oncePerUser: z.boolean().optional(),
    status: z.nativeEnum(StudioAutomationStatus).optional(),
  })
  .superRefine(assertStudioRules);

export const updateStudioAutomationSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: updateBodySchema,
});

export const listStudioAutomationsSchema = z.object({
  query: paginationQuerySchema.extend({
    platform: z.nativeEnum(Platform).optional(),
    status: z.nativeEnum(StudioAutomationStatus).optional(),
    socialAccountId: objectIdSchema.optional(),
  }),
});

export const toggleStudioAutomationSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({ status: z.nativeEnum(StudioAutomationStatus) }),
});
