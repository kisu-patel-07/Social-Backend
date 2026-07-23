import { z } from 'zod';
import { isSafePublicUrlSync } from '../utils/ssrf';

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().max(60).optional(),
    avatarUrl: z.string().url().optional(),
  }),
});

export const updateWorkspaceSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().max(60).optional(),
    aiAssistant: z
      .object({
        enabled: z.boolean().optional(),
        businessContext: z.string().trim().max(4000).optional(),
        dailyLimit: z.coerce.number().int().min(1).max(1000).optional(),
        // BYOK: empty string clears the field (falls back to platform default).
        apiKey: z.string().trim().max(300).optional(),
        baseUrl: z
          .string()
          .trim()
          .url()
          .max(300)
          .refine(isSafePublicUrlSync, 'AI base URL must be an https URL to a public host')
          .or(z.literal(''))
          .optional(),
        model: z.string().trim().max(120).optional(),
      })
      .optional(),
  }),
});

export const notificationPrefsSchema = z.object({
  body: z.object({
    newLead: z.boolean().optional(),
    weeklyReport: z.boolean().optional(),
    product: z.boolean().optional(),
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: z
      .string()
      .min(8)
      .max(128)
      .regex(/[a-z]/, 'Password must contain a lowercase letter')
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[0-9]/, 'Password must contain a number'),
  }),
});

export const deleteAccountSchema = z.object({
  body: z.object({
    confirm: z.literal(true, {
      errorMap: () => ({ message: 'You must confirm account deletion' }),
    }),
    password: z.string().optional(),
  }),
});
