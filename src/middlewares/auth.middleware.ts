import { NextFunction, Request, Response } from 'express';
import { UserRole } from '../constants';
import { userRepository } from '../repositories';
import { ForbiddenError, UnauthorizedError } from '../utils/AppError';
import { verifyAccessToken } from '../utils/jwt';

/**
 * Require a valid Bearer access token. Populates req.user on success.
 *
 * Beyond the signature/expiry check, the user row is re-read on every request
 * (indexed _id lookup — cheap) so that deletion, suspension, and tokenVersion
 * bumps revoke outstanding access tokens IMMEDIATELY instead of after the
 * token's multi-day lifetime. A 401 makes the client attempt a refresh, which
 * the auth service also refuses for suspended users — so the browser lands on
 * the login screen, where the specific suspension error is shown.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication token missing');
    }
    const token = header.slice(7).trim();
    const payload = verifyAccessToken(token);

    const user = await userRepository.findById(payload.sub, 'isSuspended tokenVersion');
    if (!user) {
      throw new UnauthorizedError('This account no longer exists');
    }
    if (user.isSuspended) {
      throw new UnauthorizedError('This account has been suspended');
    }
    // Tokens minted before a version bump (e.g. an un-suspension cycle) are
    // dead; tokens from before the tv field existed are allowed to age out.
    if (payload.tv !== undefined && payload.tv !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedError('Session revoked — please sign in again');
    }

    req.user = {
      id: payload.sub,
      workspaceId: payload.workspaceId,
      role: payload.role,
      email: payload.email,
      isImpersonation: payload.imp === true,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Refuse the request when the session is an admin impersonating a user.
 * Applied to destructive self-service routes (password change, account
 * deletion) so support sessions can look but not break.
 */
export function denyImpersonation(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.isImpersonation) {
    throw new ForbiddenError('This action is disabled during an impersonation session');
  }
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
