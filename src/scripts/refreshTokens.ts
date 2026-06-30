import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';
import { metaService } from '../services/meta';

/**
 * Refresh Meta long-lived tokens nearing expiry.
 * Designed to be run on a schedule (e.g. a daily cron on Railway/Render) —
 * no Redis/queue is required per the MVP constraints.
 *
 * Run with: npx ts-node src/scripts/refreshTokens.ts
 */
async function run(): Promise<void> {
  await connectDatabase();
  const result = await metaService.refreshExpiringTokens();
  logger.info('Token refresh job complete', result);
  await disconnectDatabase();
}

run().catch((error) => {
  logger.error('Token refresh job failed', { error });
  process.exit(1);
});
