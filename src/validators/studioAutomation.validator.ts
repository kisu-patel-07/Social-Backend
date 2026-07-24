import { z } from 'zod';
import { Platform, StudioAutomationStatus, StudioKeywordMode, StudioPostScope } from '../constants';
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

const repliesSchema = z
  .array(z.string().trim().min(1).max(2000))
  .max(5, 'Up to 5 reply variations');

/** Optional multi-step DM flow config (follow-gate, email, click-to-deliver, follow-up). */
const flowSchema = z.object({
  requireFollow: z.boolean().default(false),
  followMessage: z.string().trim().max(2000).optional(),
  askEmail: z.boolean().default(false),
  emailMessage: z.string().trim().max(2000).optional(),
  deliverOnClick: z.boolean().default(false),
  openingMessage: z.string().trim().max(2000).optional(),
  openingButtonLabel: z.string().trim().max(20).optional(),
  followUpEnabled: z.boolean().default(false),
  followUpDelayMinutes: z.coerce.number().int().min(1).max(10080).optional(),
  followUpMessage: z.string().trim().max(2000).optional(),
});

/** Cross-field rules shared by create and update payloads. */
function assertStudioRules(
  data: {
    triggerType?: string;
    postScope?: StudioPostScope;
    postIds?: string[];
    keywordMode?: StudioKeywordMode;
    keywords?: string[];
    publicReplyEnabled?: boolean;
    publicReplies?: string[];
    dmEnabled?: boolean;
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
  // Story mentions carry no text — keyword matching does not apply.
  if (
    data.triggerType !== 'story_mention' &&
    data.keywordMode !== StudioKeywordMode.ANY &&
    data.keywords &&
    !data.keywords.length
  ) {
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
  // A DM that's turned on needs a message. (When it's off this stays empty and
  // the automation is public-reply-only.) The "at least one action" rule is
  // enforced in the service, where the full merged document is known on update.
  const dmOn = data.dmEnabled ?? true;
  if (dmOn && data.dmMessage !== undefined && !data.dmMessage.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dmMessage'],
      message: 'Add a DM message, or turn the DM off',
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
    triggerType: z.enum(['comment', 'dm', 'story', 'story_mention']).default('comment'),
    postScope: z.nativeEnum(StudioPostScope).default(StudioPostScope.ALL),
    postIds: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    keywordMode: z.nativeEnum(StudioKeywordMode).default(StudioKeywordMode.CONTAINS),
    keywords: keywordListSchema.default([]),
    excludeKeywords: keywordListSchema.default([]),
    publicReplyEnabled: z.boolean().default(true),
    publicReplies: repliesSchema.default([]),
    dmEnabled: z.boolean().default(true),
    dmMessage: z.string().trim().max(2000).default(''),
    dmButtons: z.array(buttonSchema).max(3, 'Up to 3 buttons').default([]),
    flow: flowSchema.optional(),
    oncePerUser: z.boolean().default(false),
    templateKey: z.string().trim().max(60).optional(),
    status: z.nativeEnum(StudioAutomationStatus).optional(),
  })
  .superRefine(assertStudioRules);

export const createStudioAutomationSchema = z.object({ body: createBodySchema });

const updateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    triggerType: z.enum(['comment', 'dm', 'story', 'story_mention']).optional(),
    postScope: z.nativeEnum(StudioPostScope).optional(),
    postIds: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    keywordMode: z.nativeEnum(StudioKeywordMode).optional(),
    keywords: keywordListSchema.optional(),
    excludeKeywords: keywordListSchema.optional(),
    publicReplyEnabled: z.boolean().optional(),
    publicReplies: repliesSchema.optional(),
    dmEnabled: z.boolean().optional(),
    dmMessage: z.string().trim().max(2000).optional(),
    dmButtons: z.array(buttonSchema).max(3, 'Up to 3 buttons').optional(),
    flow: flowSchema.optional(),
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
