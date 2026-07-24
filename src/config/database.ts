import mongoose from 'mongoose';
import { env, isProduction } from './env';
import { logger } from './logger';

mongoose.set('strictQuery', true);

if (!isProduction) {
  mongoose.set('debug', false);
}

/**
 * Establish the MongoDB connection. Called once at server boot.
 * Throws on failure so the caller can abort startup.
 */
export async function connectDatabase(): Promise<typeof mongoose> {
  try {
    const conn = await mongoose.connect(env.MONGODB_URI, {
      autoIndex: !isProduction, // build indexes automatically outside production
      serverSelectionTimeoutMS: 10000,
    });
    logger.info(
      `✅ MongoDB connected [${env.NODE_ENV}]: ${conn.connection.host}/${conn.connection.name}`
    );
    return conn;
  } catch (error) {
    logger.error('❌ MongoDB connection error', { error });
    throw error;
  }
}

let connectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Serverless-safe connect (Vercel/Lambda): reuses an established or in-flight
 * connection across warm invocations instead of reconnecting on every request.
 */
export async function ensureDatabaseConnection(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!connectionPromise) {
    connectionPromise = connectDatabase().catch((error) => {
      connectionPromise = null; // allow retry on the next invocation
      throw error;
    });
  }
  return connectionPromise;
}

/** Gracefully close the MongoDB connection (used on shutdown). */
export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (error) => {
  logger.error('MongoDB runtime error', { error });
});
