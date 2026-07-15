import jwt, { SignOptions, JwtPayload as BaseJwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';
import { TokenType } from '../constants';
import { JwtPayload } from '../types/auth.types';
import { UnauthorizedError } from './AppError';

type SignableExpiry = SignOptions['expiresIn'];

/** Sign a short-lived access token. */
export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignableExpiry,
  });
}

/** Sign a long-lived refresh token. */
export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignableExpiry,
  });
}

/** Verify an access token and return its payload. */
export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
}

/** Verify a refresh token and return its payload. */
export function verifyRefreshToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }
}

/** Email-scoped token payload (verification & password reset). */
export interface EmailTokenPayload extends BaseJwtPayload {
  sub: string;
  type: TokenType.EMAIL_VERIFICATION | TokenType.PASSWORD_RESET;
}

/** Sign an email verification or password reset token. */
export function signEmailToken(
  userId: string,
  type: EmailTokenPayload['type'],
  expiresIn: string | number
): string {
  return jwt.sign({ sub: userId, type }, env.JWT_EMAIL_SECRET, {
    expiresIn: expiresIn as SignableExpiry,
  });
}

/** Verify an email-scoped token, asserting the expected token type. */
export function verifyEmailToken(
  token: string,
  expectedType: EmailTokenPayload['type']
): EmailTokenPayload {
  let decoded: EmailTokenPayload;
  try {
    decoded = jwt.verify(token, env.JWT_EMAIL_SECRET) as EmailTokenPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
  if (decoded.type !== expectedType) {
    throw new UnauthorizedError('Token type mismatch');
  }
  return decoded;
}

/**
 * TOTP login challenge. Issued after a correct password when 2FA is enabled;
 * the client exchanges it (plus a valid authenticator code) for real tokens.
 */
interface TotpChallengePayload extends BaseJwtPayload {
  sub: string; // userId
  type: 'totp_challenge';
}

export function signTotpChallengeToken(userId: string): string {
  return jwt.sign({ sub: userId, type: 'totp_challenge' }, env.JWT_EMAIL_SECRET, {
    expiresIn: '5m',
  });
}

export function verifyTotpChallengeToken(token: string): { userId: string } {
  let decoded: TotpChallengePayload;
  try {
    decoded = jwt.verify(token, env.JWT_EMAIL_SECRET) as TotpChallengePayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired 2FA challenge — sign in again');
  }
  if (decoded.type !== 'totp_challenge') {
    throw new UnauthorizedError('Invalid 2FA challenge');
  }
  return { userId: decoded.sub };
}

/**
 * OAuth `state` token. The Meta callback is a top-level browser redirect with
 * no Authorization header, so we carry the initiating user's identity in a
 * short-lived signed state value and verify it on the callback.
 */
interface StateTokenPayload extends BaseJwtPayload {
  sub: string; // userId
  ws: string; // workspaceId
  type: 'oauth_state';
}

export function signStateToken(userId: string, workspaceId: string): string {
  return jwt.sign({ sub: userId, ws: workspaceId, type: 'oauth_state' }, env.JWT_EMAIL_SECRET, {
    expiresIn: '15m',
  });
}

export function verifyStateToken(token: string): { userId: string; workspaceId: string } {
  let decoded: StateTokenPayload;
  try {
    decoded = jwt.verify(token, env.JWT_EMAIL_SECRET) as StateTokenPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired OAuth state');
  }
  if (decoded.type !== 'oauth_state') {
    throw new UnauthorizedError('Invalid OAuth state');
  }
  return { userId: decoded.sub, workspaceId: decoded.ws };
}
