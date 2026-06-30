import { Types } from 'mongoose';

/** Convenience alias for Mongoose ObjectId values. */
export type ObjectId = Types.ObjectId;

/** Standard query parameters parsed for any paginated list endpoint. */
export interface PaginationQuery {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/** Normalized pagination options passed into the repository layer. */
export interface PaginationOptions {
  page: number;
  limit: number;
  skip: number;
  sort: Record<string, 1 | -1>;
}

/** Metadata returned alongside every paginated result set. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/** A paginated payload: the items plus pagination metadata. */
export interface PaginatedResult<T> {
  items: T[];
  meta: PaginationMeta;
}

/** Shape of a successful API envelope. */
export interface ApiSuccessBody<T> {
  success: true;
  message: string;
  data: T;
  meta?: PaginationMeta;
}

/** Shape of an error API envelope. */
export interface ApiErrorBody {
  success: false;
  message: string;
  errorCode?: string;
  errors?: unknown;
  stack?: string;
}
