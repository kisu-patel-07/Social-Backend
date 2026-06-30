import { PAGINATION } from '../constants';
import { PaginationMeta, PaginationOptions, PaginationQuery } from '../types/common.types';

/**
 * Normalize raw pagination query params into safe, bounded options
 * for the repository layer (page/limit/skip/sort).
 */
export function buildPaginationOptions(
  query: PaginationQuery,
  defaultSortField = 'createdAt'
): PaginationOptions {
  const page = Math.max(Number(query.page) || PAGINATION.DEFAULT_PAGE, 1);
  const rawLimit = Number(query.limit) || PAGINATION.DEFAULT_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), PAGINATION.MAX_LIMIT);
  const skip = (page - 1) * limit;

  const sortField = query.sortBy?.trim() || defaultSortField;
  const sortOrder: 1 | -1 = query.sortOrder === 'asc' ? 1 : -1;

  return {
    page,
    limit,
    skip,
    sort: { [sortField]: sortOrder },
  };
}

/** Build the pagination metadata returned to the client. */
export function buildPaginationMeta(
  total: number,
  options: Pick<PaginationOptions, 'page' | 'limit'>
): PaginationMeta {
  const totalPages = Math.max(Math.ceil(total / options.limit), 1);
  return {
    page: options.page,
    limit: options.limit,
    total,
    totalPages,
    hasNextPage: options.page < totalPages,
    hasPrevPage: options.page > 1,
  };
}
