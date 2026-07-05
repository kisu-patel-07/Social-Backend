import type { IncomingMessage, ServerResponse } from 'http';
import { ensureDatabaseConnection } from '../../src/config/database';
import { env } from '../../src/config/env';
import { logger } from '../../src/config/logger';
import { metaService } from '../../src/services/meta';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Serverless replacement for `npm run job:refresh-tokens` (scripts/refreshTokens.ts),
 * scheduled via the `crons` entry in vercel.json.
 *
 * Vercel Cron authenticates by sending `Authorization: Bearer ${CRON_SECRET}`
 * when the CRON_SECRET env var is set on the project — so the secret is required
 * here; without it the endpoint refuses to run.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authorized =
    env.CRON_SECRET !== '' && req.headers.authorization === `Bearer ${env.CRON_SECRET}`;
  if (!authorized) {
    send(res, 401, { success: false, message: 'Unauthorized' });
    return;
  }

  try {
    await ensureDatabaseConnection();
    const result = await metaService.refreshExpiringTokens();
    logger.info('Token refresh job complete', result);
    send(res, 200, { success: true, data: result });
  } catch (error) {
    logger.error('Token refresh job failed', { error });
    send(res, 500, { success: false, message: 'Token refresh job failed' });
  }
}
