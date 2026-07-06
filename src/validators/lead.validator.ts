import { z } from 'zod';
import { LeadSource, LeadStatus, Platform } from '../constants';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

export const listLeadsSchema = z.object({
  query: paginationQuerySchema.extend({
    platform: z.nativeEnum(Platform).optional(),
    status: z.nativeEnum(LeadStatus).optional(),
    source: z.nativeEnum(LeadSource).optional(),
    socialAccountId: objectIdSchema.optional(),
    tag: z.string().trim().max(60).optional(),
  }),
});

export const updateLeadSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    status: z.nativeEnum(LeadStatus).optional(),
    notes: z.string().trim().max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    name: z.string().trim().max(120).optional(),
  }),
});

export const bulkUpdateLeadsSchema = z.object({
  body: z
    .object({
      ids: z.array(objectIdSchema).min(1).max(200),
      status: z.nativeEnum(LeadStatus).optional(),
      addTags: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    })
    .refine((b) => b.status !== undefined || (b.addTags?.length ?? 0) > 0, {
      message: 'Provide a status or at least one tag to apply',
    }),
});

export const bulkDeleteLeadsSchema = z.object({
  body: z.object({ ids: z.array(objectIdSchema).min(1).max(200) }),
});

export const exportLeadsSchema = z.object({
  query: z.object({
    platform: z.nativeEnum(Platform).optional(),
    status: z.nativeEnum(LeadStatus).optional(),
    socialAccountId: objectIdSchema.optional(),
    search: z.string().trim().max(200).optional(),
  }),
});
