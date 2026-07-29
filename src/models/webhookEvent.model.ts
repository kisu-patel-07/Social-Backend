import { Schema, model, Document, Types } from 'mongoose';

/**
 * One received webhook delivery (Meta or Razorpay), kept for debugging: what
 * arrived, whether we accepted it, and how processing went. The raw payload is
 * stored (bounded by the request-size limits upstream) so an admin can inspect
 * it and re-run processing — all handlers are idempotent, which makes
 * reprocessing safe.
 *
 * Auto-expires after 14 days via a TTL index; this is an operational debug
 * trail, not an archive.
 */
export interface IWebhookEvent extends Document {
  _id: Types.ObjectId;
  source: 'meta' | 'razorpay';
  /** Razorpay event name, or a Meta summary like "2 comments, 1 message". */
  event: string;
  outcome: 'processed' | 'failed' | 'rejected' | 'ignored';
  /** Present when outcome is failed/rejected. */
  error?: string;
  payload?: unknown;
  /** Set when an admin re-ran this delivery. */
  reprocessedAt?: Date;
  reprocessedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    source: { type: String, enum: ['meta', 'razorpay'], required: true, index: true },
    event: { type: String, required: true, maxlength: 200 },
    outcome: {
      type: String,
      enum: ['processed', 'failed', 'rejected', 'ignored'],
      required: true,
      index: true,
    },
    error: { type: String, maxlength: 1000 },
    payload: { type: Schema.Types.Mixed },
    reprocessedAt: { type: Date },
    reprocessedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

webhookEventSchema.index({ createdAt: -1 });
webhookEventSchema.index({ source: 1, outcome: 1, createdAt: -1 });
// Debug trail only — drop entries automatically after 14 days.
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

export const WebhookEventModel = model<IWebhookEvent>('WebhookEvent', webhookEventSchema);
