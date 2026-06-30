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
