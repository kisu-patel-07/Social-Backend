import { z } from 'zod';
import { Types } from 'mongoose';

/** Reusable Zod schema for a Mongo ObjectId string. */
export const objectIdSchema = z
  .string()
  .refine((val) => Types.ObjectId.isValid(val), { message: 'Invalid id' });

/** Shared pagination/search/sort query schema for list endpoints. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  search: z.string().trim().max(200).optional(),
  sortBy: z.string().trim().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

/** A single path param `:id` that must be a valid ObjectId. */
export const idParamSchema = z.object({
  id: objectIdSchema,
});
