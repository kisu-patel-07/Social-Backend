import { NextFunction, Request, Response } from 'express';
import { UserRole } from '../constants';
import { userRepository } from '../repositories';
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
 * Restrict a route to platform super admins. Must run after `authenticate`.
 *
 * Deliberately re-checks the database (not the JWT) on every request so that
 * revoking the flag or suspending the account locks the panel out immediately,
 * with no stale-token window. Admin traffic is low; the lookup is cheap.
 */
export async function requireSuperAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const user = await userRepository.findById(req.user.id);
    if (!user || user.isSuspended || !user.isSuperAdmin) {
      throw new ForbiddenError('Admin access required');
    }
    next();
  } catch (err) {
    next(err);
  }
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
