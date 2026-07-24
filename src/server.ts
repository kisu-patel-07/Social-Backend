import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { env, loadedEnvFile } from './config/env';
import { logger } from './config/logger';

async function bootstrap(): Promise<void> {
  logger.info(`▶ Booting SocialDM backend — environment: ${env.NODE_ENV} (config: ${loadedEnvFile})`);

  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 Server listening on port ${env.PORT} (${env.NODE_ENV})`);
    logger.info(`   API base: ${env.API_PREFIX}`);
  });

  /** Gracefully drain connections, then close the DB, on shutdown signals. */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Force-exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    process.exit(1);
  });
}

bootstrap().catch((error) => {
  logger.error('Fatal error during startup', { error });
  process.exit(1);
});
