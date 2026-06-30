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
