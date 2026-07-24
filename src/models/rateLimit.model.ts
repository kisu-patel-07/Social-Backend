import { Schema, model, Document } from 'mongoose';

/**
 * A single fixed-window rate-limit counter, keyed by the limiter's client key
 * (usually IP). Backs MongoRateLimitStore so limits are shared across all
 * serverless instances instead of living in per-lambda memory.
 */
export interface IRateLimit extends Document {
  key: string;
  count: number;
  expiresAt: Date;
}

const rateLimitSchema = new Schema<IRateLimit>({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

// TTL: Mongo removes each counter shortly after its window elapses. Correctness
// does not depend on this (increment checks expiresAt explicitly) — it is just
// cleanup so the collection cannot grow unbounded.
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitModel = model<IRateLimit>('RateLimit', rateLimitSchema);
