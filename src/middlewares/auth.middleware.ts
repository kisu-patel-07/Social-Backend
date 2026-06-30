import { NextFunction, Request, Response } from 'express';
import { UserRole } from '../constants';
import { ForbiddenError, UnauthorizedError } from '../utils/AppError';
import { verifyAccessToken } from '../utils/jwt';

/**
 * Require a valid Bearer access token. Populates req.user on success.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('Authentication token missing');
  }
  const token = header.slice(7).trim();
  const payload = verifyAccessToken(token);
  req.user = {
    id: payload.sub,
    workspaceId: payload.workspaceId,
    role: payload.role,
    email: payload.email,
  };
  next();
}

/**
 * Restrict a route to specific roles. Must run after `authenticate`.
 */
export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    if (roles.length && !roles.includes(req.user.role)) {
      throw new ForbiddenError('You do not have permission to perform this action');
    }
    next();
  };
}
