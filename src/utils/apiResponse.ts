import { Response } from 'express';
import { HttpStatus } from '../constants/httpStatus';
import { PaginationMeta } from '../types/common.types';

/**
 * Send a standardized success response.
 * Every successful endpoint returns the same envelope shape.
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode: HttpStatus = HttpStatus.OK,
  meta?: PaginationMeta
): Response {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });
}

/** Send a standardized paginated success response. */
export function sendPaginated<T>(
  res: Response,
  items: T[],
  meta: PaginationMeta,
  message = 'Success'
): Response {
  return sendSuccess(res, items, message, HttpStatus.OK, meta);
}

/** Send a 201 Created response. */
export function sendCreated<T>(res: Response, data: T, message = 'Created'): Response {
  return sendSuccess(res, data, message, HttpStatus.CREATED);
}

/** Send a 204 No Content response. */
export function sendNoContent(res: Response): Response {
  return res.status(HttpStatus.NO_CONTENT).send();
}
