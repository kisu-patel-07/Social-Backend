import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { HttpStatus } from '../constants/httpStatus';

/** General API limiter applied to all routes. */
export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
    errorCode: 'RATE_LIMITED',
  },
  statusCode: HttpStatus.TOO_MANY_REQUESTS,
  // Never throttle Meta webhook deliveries. They arrive from a small pool of
  // Meta IPs, so a viral post can burst past the per-IP limit; a 429 to Meta
  // triggers escalating retries and, if sustained, disables the app's webhook
  // subscription — which would break automations for every workspace. The
  // endpoint is already authenticated by X-Hub-Signature-256.
  skip: (req) => req.originalUrl.includes('/webhooks/meta'),
});

/** Stricter limiter for sensitive auth endpoints (login, register, reset). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts, please try again later.',
    errorCode: 'RATE_LIMITED',
  },
  statusCode: HttpStatus.TOO_MANY_REQUESTS,
});
