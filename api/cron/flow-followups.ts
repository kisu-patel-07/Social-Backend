import type { IncomingMessage, ServerResponse } from 'http';
import { ensureDatabaseConnection } from '../../src/config/database';
import { env } from '../../src/config/env';
import { logger } from '../../src/config/logger';
import { flowEngineService } from '../../src/services/flowEngine.service';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Sends follow-up DMs for Studio flow links that went unclicked past their
 * delay. Scheduled via the `crons` entry in vercel.json. Authenticated by the
 * `Authorization: Bearer ${CRON_SECRET}` header Vercel Cron sends.
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
    const result = await flowEngineService.runFollowUps();
    logger.info('Flow follow-up job complete', result);
    send(res, 200, { success: true, data: result });
  } catch (error) {
    logger.error('Flow follow-up job failed', { error });
    send(res, 500, { success: false, message: 'Flow follow-up job failed' });
  }
}
