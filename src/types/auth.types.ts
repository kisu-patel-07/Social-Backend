import { UserRole } from '../constants';

/** Decoded payload stored inside access/refresh JWTs. */
export interface JwtPayload {
  sub: string; // user id
  workspaceId: string;
  role: UserRole;
  email: string;
  /** Present (true) on impersonation tokens issued from the admin panel. */
  imp?: boolean;
  /** The impersonating admin's user id (audit trail). */
  actor?: string;
  /**
   * The user's tokenVersion at issue time. Bumped on suspension (and any
   * future "log out everywhere") so outstanding tokens die immediately.
   * Optional so tokens issued before this field shipped stay valid.
   */
  tv?: number;
}

/** The authenticated principal attached to req.user after auth middleware. */
export interface AuthUser {
  id: string;
  workspaceId: string;
  role: UserRole;
  email: string;
  /** True when this session is an admin impersonating the user. */
  isImpersonation?: boolean;
}

/** Tokens returned to the client after successful authentication. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
