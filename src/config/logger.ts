import winston from 'winston';
import { env, isProduction } from './env';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} ${level}: ${stack || message}${metaStr}`;
  })
);

const prodFormat = combine(timestamp(), errors({ stack: true }), json());

/**
 * Centralized application logger.
 * Use this everywhere instead of console.* so log output is consistent
 * and can be shipped to an aggregator in production.
 */
export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: isProduction ? prodFormat : devFormat,
  defaultMeta: { service: 'social-automation-backend' },
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

/** Stream adapter so morgan can pipe HTTP logs through winston. */
export const httpLogStream = {
  write: (message: string): void => {
    logger.http(message.trim());
  },
};
