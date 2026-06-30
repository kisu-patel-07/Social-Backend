import { Request, Response, NextFunction } from 'express';
import { NotFoundError } from '../utils/AppError';

/** Catch-all for unmatched routes; forwards a 404 to the error handler. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
}
