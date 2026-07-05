import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Centralized, validated environment configuration.
 * The app fails fast at boot if required variables are missing or malformed.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_PREFIX: z.string().default('/api/v1'),
  CLIENT_URL: z.string().default('http://localhost:3000'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_EMAIL_SECRET: z.string().min(1, 'JWT_EMAIL_SECRET is required'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  EMAIL_TOKEN_EXPIRES_IN: z.string().default('1d'),
  PASSWORD_RESET_EXPIRES_IN: z.string().default('1h'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  BREVO_API_KEY: z.string().default(''),
  BREVO_SENDER_EMAIL: z.string().default('no-reply@example.com'),
  BREVO_SENDER_NAME: z.string().default('Social Automation'),
  EMAIL_DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_GRAPH_VERSION: z.string().default('v21.0'),
  META_GRAPH_BASE_URL: z.string().default('https://graph.facebook.com'),
  META_OAUTH_REDIRECT_URI: z
    .string()
    .default('http://localhost:5000/api/v1/accounts/oauth/callback'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default('change_me_verify_token'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  /** Shared secret for scheduled-job endpoints (Vercel Cron sends it as a Bearer token). */
  CRON_SECRET: z.string().default(''),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Cannot use the winston logger here because it depends on env.
  // eslint-disable-next-line no-console
  console.error(
    '❌ Invalid environment configuration:',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/** Allowed CORS origins, derived from CLIENT_URL (comma separated). */
export const allowedOrigins = env.CLIENT_URL.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
