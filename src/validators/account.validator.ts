import { z } from 'zod';
import { Platform } from '../constants';
import { objectIdSchema } from './common.validator';

/** Begin the Meta OAuth flow (returns an authorization URL). */
export const startOAuthSchema = z.object({
  query: z.object({
    platform: z.nativeEnum(Platform).optional(),
  }),
});

/** OAuth callback from Meta with an authorization code. */
export const oauthCallbackSchema = z.object({
  query: z.object({
    code: z.string().min(1).optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
});

/**
 * Connect a specific Page / IG business account selected by the user after
 * the OAuth handshake (the frontend posts the chosen entity).
 */
export const connectAccountSchema = z.object({
  body: z.object({
    platform: z.nativeEnum(Platform),
    pageId: z.string().min(1).optional(),
    instagramBusinessId: z.string().min(1).optional(),
    name: z.string().trim().min(1),
    username: z.string().trim().optional(),
    accessToken: z.string().min(1),
  }),
});

export const accountIdParamSchema = z.object({
  params: z.object({ id: objectIdSchema }),
});

/** Fetch posts/reels for a connected Instagram account (cursor-paginated). */
export const listMediaSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  query: z.object({
    type: z.enum(['posts', 'reels']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: z.string().min(1).optional(),
    insights: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),
});
