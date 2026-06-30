import { z } from 'zod';

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
