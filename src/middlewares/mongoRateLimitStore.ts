import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import { logger } from '../config/logger';
import { RateLimitModel } from '../models/rateLimit.model';

/**
 * A MongoDB-backed express-rate-limit store. The default MemoryStore keeps
 * counters in per-process memory, which is useless on Vercel serverless — every
 * cold start or concurrent lambda has its own memory, so an attacker spreading
 * requests across instances resets the window and defeats brute-force limits.
 * This store shares counters through the app's existing Mongo connection (no
 * extra infrastructure), so the limit actually holds cluster-wide.
 */
export class MongoRateLimitStore implements Store {
  private windowMs = 60_000;
  /** Namespacing so multiple limiters can share the collection safely. */
  prefix = 'rl:';

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private bump(
    fullKey: string,
    now: Date,
    resetTime: Date
  ): Promise<{ count: number; expiresAt: Date } | null> {
    // Atomic fixed-window counter in a single document op: if the window is
    // still live, increment; otherwise start a fresh one. No lost-update race.
    return RateLimitModel.findOneAndUpdate(
      { key: fullKey },
      [
        {
          $set: {
            count: { $cond: [{ $gt: ['$expiresAt', now] }, { $add: ['$count', 1] }, 1] },
            expiresAt: { $cond: [{ $gt: ['$expiresAt', now] }, '$expiresAt', resetTime] },
          },
        },
      ],
      { new: true, upsert: true }
    )
      .lean<{ count: number; expiresAt: Date }>()
      .exec();
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const fullKey = this.prefix + key;
    const now = new Date();
    const resetTime = new Date(now.getTime() + this.windowMs);
    try {
      const doc = await this.bump(fullKey, now, resetTime);
      return { totalHits: doc?.count ?? 1, resetTime: doc?.expiresAt ?? resetTime };
    } catch (err) {
      // Two concurrent first-inserts race on the unique key; the loser retries
      // and simply increments the now-existing document.
      if ((err as { code?: number }).code === 11000) {
        try {
          const doc = await this.bump(fullKey, now, resetTime);
          return { totalHits: doc?.count ?? 1, resetTime: doc?.expiresAt ?? resetTime };
        } catch {
          /* fall through to fail-open */
        }
      }
      // Fail open: a rate-limiter storage error must not take auth down. Mongo
      // being unavailable already blocks the credential check downstream.
      logger.warn('Rate-limit store error — allowing request', {
        error: (err as Error).message,
      });
      return { totalHits: 1, resetTime };
    }
  }

  async decrement(key: string): Promise<void> {
    await RateLimitModel.updateOne(
      { key: this.prefix + key, expiresAt: { $gt: new Date() } },
      { $inc: { count: -1 } }
    ).exec();
  }

  async resetKey(key: string): Promise<void> {
    await RateLimitModel.deleteOne({ key: this.prefix + key }).exec();
  }
}
