import { z } from 'zod';
import {
  BillingInterval,
  DemoRequestStatus,
  PaymentStatus,
  SubscriptionStatus,
} from '../constants';
import { idParamSchema, objectIdSchema, paginationQuerySchema } from './common.validator';

/** GET /admin/users query. */
export const adminListUsersSchema = z.object({
  query: paginationQuerySchema.extend({
    verified: z.enum(['true', 'false']).optional(),
    suspended: z.enum(['true', 'false']).optional(),
  }),
});

/** PATCH /admin/users/:id/suspend */
export const adminSuspendUserSchema = z.object({
  params: idParamSchema,
  body: z.object({
    suspended: z.boolean(),
  }),
});

/** GET /admin/subscriptions query. */
export const adminListSubscriptionsSchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.nativeEnum(SubscriptionStatus).optional(),
  }),
});

/** PATCH /admin/subscriptions/:id */
export const adminUpdateSubscriptionSchema = z.object({
  params: idParamSchema,
  body: z
    .object({
      planId: objectIdSchema.optional(),
      status: z.nativeEnum(SubscriptionStatus).optional(),
      extendDays: z.coerce.number().int().min(1).max(365).optional(),
    })
    .refine((b) => b.planId || b.status || b.extendDays, {
      message: 'Provide at least one of planId, status or extendDays',
    }),
});

const planLimitsSchema = z.object({
  connectedAccounts: z.coerce.number().int().min(-1),
  automations: z.coerce.number().int().min(-1),
  monthlyMessages: z.coerce.number().int().min(-1),
  teamMembers: z.coerce.number().int().min(-1),
});

const planBodyBase = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/i, 'Use letters, numbers, dashes or underscores'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  priceAmount: z.coerce.number().int().min(0),
  currency: z.string().trim().length(3).optional(),
  interval: z.nativeEnum(BillingInterval).optional(),
  durationDays: z.coerce.number().int().min(1).max(365).optional(),
  limits: planLimitsSchema.partial().optional(),
  entitlements: z
    .object({
      studio: z.boolean().optional(),
      csvExport: z.boolean().optional(),
    })
    .optional(),
  features: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

const requireDurationForDayPacks = (b: { interval?: BillingInterval; durationDays?: number }) =>
  b.interval !== BillingInterval.DAYS || Boolean(b.durationDays);

/** POST /admin/plans */
export const adminCreatePlanSchema = z.object({
  body: planBodyBase.refine(requireDurationForDayPacks, {
    message: 'durationDays is required for day-wise plans',
  }),
});

/** PUT /admin/plans/:id — everything optional. */
export const adminUpdatePlanSchema = z.object({
  params: idParamSchema,
  body: planBodyBase.partial().refine(requireDurationForDayPacks, {
    message: 'durationDays is required for day-wise plans',
  }),
});

/** GET /admin/activity query. */
export const adminListActivitySchema = z.object({
  query: paginationQuerySchema.extend({
    action: z.string().trim().max(60).optional(),
    workspaceId: objectIdSchema.optional(),
  }),
});

/** GET /admin/automations query. */
export const adminListAutomationsSchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.enum(['active', 'paused', 'draft']).optional(),
    kind: z.enum(['classic', 'studio']).optional(),
  }),
});

/** PATCH /admin/automations/:id/status */
export const adminAutomationStatusSchema = z.object({
  params: idParamSchema,
  body: z.object({
    kind: z.enum(['classic', 'studio']),
    status: z.enum(['active', 'paused']),
  }),
});

/** PATCH /admin/subscriptions/:id/bonus */
export const adminGrantBonusSchema = z.object({
  params: idParamSchema,
  body: z.object({
    monthlyMessages: z.coerce.number().int().min(0).max(1000000).optional(),
    automations: z.coerce.number().int().min(0).max(1000).optional(),
    connectedAccounts: z.coerce.number().int().min(0).max(100).optional(),
    note: z.string().trim().max(200).optional(),
  }),
});

/** GET /admin/payments query. */
export const adminListPaymentsSchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.nativeEnum(PaymentStatus).optional(),
  }),
});

/** PATCH /admin/features/:key */
export const adminUpdateFeatureSchema = z.object({
  params: z.object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9_-]+$/i),
  }),
  body: z.object({
    mode: z.enum(['on', 'off', 'allowlist']).optional(),
    description: z.string().trim().max(300).optional(),
    workspaces: z.array(objectIdSchema).max(200).optional(),
  }),
});

/** GET /admin/demo-requests query. */
export const adminListDemoRequestsSchema = z.object({
  query: paginationQuerySchema.extend({
    status: z.nativeEnum(DemoRequestStatus).optional(),
  }),
});

/** PATCH /admin/demo-requests/:id */
export const adminUpdateDemoRequestSchema = z.object({
  params: idParamSchema,
  body: z
    .object({
      status: z.nativeEnum(DemoRequestStatus).optional(),
      scheduledAt: z.string().datetime({ offset: true }).or(z.literal('')).optional(),
      adminNote: z.string().trim().max(2000).optional(),
    })
    .refine((b) => b.status || b.scheduledAt !== undefined || b.adminNote !== undefined, {
      message: 'Provide at least one of status, scheduledAt or adminNote',
    }),
});

/** GET /admin/workspaces query (allowlist picker). */
export const adminSearchWorkspacesSchema = z.object({
  query: z.object({
    search: z.string().trim().max(120).optional(),
  }),
});

/** PATCH /admin/users/:id/notes */
export const adminUserNotesSchema = z.object({
  params: idParamSchema,
  body: z.object({
    notes: z.string().max(5000),
  }),
});

/** GET /admin/workspaces-directory query. */
export const adminListWorkspacesSchema = z.object({
  query: paginationQuerySchema,
});

/** PUT /admin/banner */
export const adminBannerSchema = z.object({
  body: z.object({
    enabled: z.boolean(),
    message: z.string().trim().max(200),
    level: z.enum(['info', 'warning', 'critical']),
  }),
});

/** POST /admin/2fa/enable and /disable */
export const adminTotpCodeSchema = z.object({
  body: z.object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Code must be 6 digits'),
  }),
});

/** POST /admin/broadcast */
export const adminBroadcastSchema = z.object({
  body: z.object({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(3).max(500),
    link: z
      .string()
      .trim()
      .max(300)
      .regex(/^\//, 'Link must be an in-app path starting with /')
      .optional(),
    audience: z.enum(['all', 'verified']),
    planId: objectIdSchema.optional(),
  }),
});
