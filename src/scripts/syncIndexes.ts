import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { logger } from '../config/logger';

// Import every model for its registration side effect so mongoose.modelNames()
// below includes all of them. The barrel covers all models except trackedLink,
// which is imported explicitly.
import '../models';
import '../models/trackedLink.model';

/**
 * Build (and prune) MongoDB indexes to match the Mongoose schemas.
 *
 * Production runs with autoIndex disabled (see config/database.ts) — building
 * indexes on every serverless cold start is expensive and unsafe — so the
 * unique/dedup indexes declared in the schemas (message dedup, conversation,
 * lead, subscription, trackedLink slug, …) are NOT created automatically there.
 * This script creates them. Run it once per deploy, and after adding/changing
 * any index:
 *
 *   npm run db:sync-indexes
 *
 * syncIndexes() also drops indexes that are no longer declared in a schema.
 * That is safe here because every index in this codebase is schema-defined.
 */
async function run(): Promise<void> {
  await connectDatabase();
  const names = mongoose.modelNames();
  logger.info(`Syncing indexes for ${names.length} models…`);

  for (const name of names) {
    try {
      await mongoose.model(name).syncIndexes();
      logger.info(`  ✓ ${name}`);
    } catch (error) {
      logger.error(`  ✗ ${name} — ${(error as Error).message}`);
      throw error;
    }
  }

  logger.info('Index sync complete.');
  await disconnectDatabase();
}

run().catch((error) => {
  logger.error('Index sync failed', { error });
  process.exit(1);
});
