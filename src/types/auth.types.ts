import { UserRole } from '../constants';

/** Decoded payload stored inside access/refresh JWTs. */
export interface JwtPayload {
  sub: string; // user id
  workspaceId: string;
  role: UserRole;
  email: string;
}

/** The authenticated principal attached to req.user after auth middleware. */
export interface AuthUser {
  id: string;
  workspaceId: string;
  role: UserRole;
  email: string;
}

/** Tokens returned to the client after successful authentication. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
