import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Centralized, validated environment configuration.
 * The app fails fast at boot if required variables are missing or malformed.
 */
const envSchema = z
  .object({
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
    BREVO_SENDER_NAME: z.string().default('SocialDM'),
    /** Optional: where user replies go (defaults to the sender). Use a real inbox. */
    BREVO_REPLY_TO: z.string().email().optional().or(z.literal('')),
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

    /** Razorpay checkout. Payments stay disabled (request-upgrade fallback) until both are set. */
    RAZORPAY_KEY_ID: z.string().default(''),
    RAZORPAY_KEY_SECRET: z.string().default(''),

    /** Public base of this API — used to build tracked short links (/r/:slug). */
    PUBLIC_API_URL: z.string().default('http://localhost:5000/api/v1'),

    /**
     * AI auto-reply (free-tier friendly). Any OpenAI-compatible chat endpoint
     * works; defaults target Google Gemini's free tier. Leave AI_API_KEY empty
     * to disable the feature globally. Swap to Groq with
     * AI_BASE_URL=https://api.groq.com/openai/v1 and AI_MODEL=llama-3.3-70b-versatile.
     */
    AI_API_KEY: z.string().default(''),
    AI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta/openai'),
    AI_MODEL: z.string().default('gemini-2.0-flash'),

    /** Shared secret for scheduled-job endpoints (Vercel Cron sends it as a Bearer token). */
    CRON_SECRET: z.string().default(''),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  })
  .superRefine((val, ctx) => {
    // Permissive defaults are fine for dev/test; production must not boot with
    // weak or placeholder secrets (all tokens are HS256 — a guessable secret is
    // forgeable access/refresh/email/OAuth-state tokens).
    if (val.NODE_ENV !== 'production') return;

    const jwtSecrets: [keyof typeof val, string][] = [
      ['JWT_ACCESS_SECRET', val.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', val.JWT_REFRESH_SECRET],
      ['JWT_EMAIL_SECRET', val.JWT_EMAIL_SECRET],
    ];
    for (const [name, value] of jwtSecrets) {
      if (value.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name as string],
          message: `${String(name)} must be at least 32 characters in production`,
        });
      }
    }
    if (new Set(jwtSecrets.map(([, v]) => v)).size < jwtSecrets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'The three JWT secrets must be distinct in production',
      });
    }
    if (
      val.META_WEBHOOK_VERIFY_TOKEN === 'change_me_verify_token' ||
      val.META_WEBHOOK_VERIFY_TOKEN.length < 16
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['META_WEBHOOK_VERIFY_TOKEN'],
        message: 'META_WEBHOOK_VERIFY_TOKEN must be a strong non-default value in production',
      });
    }
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
