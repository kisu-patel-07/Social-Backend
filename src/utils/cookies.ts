import { Response } from 'express';
import { isProduction } from '../config/env';
import { REFRESH_TOKEN_COOKIE } from '../constants';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Set the httpOnly refresh-token cookie on the response. */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: THIRTY_DAYS_MS,
    path: '/',
  });
}

/** Clear the refresh-token cookie (logout). */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
}
