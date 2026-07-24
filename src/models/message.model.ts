import { Schema, model, Document, Types } from 'mongoose';
import { MessageDirection, MessageStatus, MessageType, Platform } from '../constants';

export interface IMessage extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  socialAccount: Types.ObjectId;
  conversation?: Types.ObjectId;
  platform: Platform;
  direction: MessageDirection;
  type: MessageType;
  status: MessageStatus;
  /** Sender/recipient external IDs. */
  fromId?: string;
  /** Sender's username/display name (for showing comments in the UI). */
  fromUsername?: string;
  toId?: string;
  text: string;
  /** External Meta object id (comment id / message id) for idempotency. */
  externalId?: string;
  /**
   * Idempotency key for an automated OUTBOUND send, e.g.
   * `cdm:<account>:<comment>:<automation>`. A webhook retry reuses the same
   * record instead of sending a duplicate. Unique (sparse).
   */
  dedupeKey?: string;
  /**
   * Set on an INBOUND event once its automation processing has fully completed.
   * A record that exists without this marker is a crashed-mid-flight attempt and
   * is safe to reprocess (sends are idempotent via dedupeKey).
   */
  automationHandledAt?: Date;
  /** For comments: the post/media the comment belongs to. */
  postId?: string;
  /** If sent by an automation, which one. */
  automation?: Types.ObjectId;
  /** Whether this message was produced by automation vs. a human agent. */
  isAutomated: boolean;
  /** True when the text was written by the AI assistant (unmatched-DM fallback). */
  aiGenerated?: boolean;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    socialAccount: {
      type: Schema.Types.ObjectId,
      ref: 'SocialAccount',
      required: true,
      index: true,
    },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', index: true },
    platform: { type: String, enum: Object.values(Platform), required: true },
    direction: { type: String, enum: Object.values(MessageDirection), required: true },
    type: { type: String, enum: Object.values(MessageType), required: true },
    status: {
      type: String,
      enum: Object.values(MessageStatus),
      default: MessageStatus.PENDING,
    },
    fromId: { type: String },
    fromUsername: { type: String },
    toId: { type: String },
    text: { type: String, default: '' },
    externalId: { type: String, index: true, sparse: true },
    dedupeKey: { type: String },
    automationHandledAt: { type: Date },
    postId: { type: String },
    automation: { type: Schema.Types.ObjectId, ref: 'Automation' },
    isAutomated: { type: Boolean, default: false },
    aiGenerated: { type: Boolean, default: false },
    error: { type: String },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index({ workspace: 1, type: 1, createdAt: -1 });
// Prevent processing the same external event twice.
messageSchema.index(
  { socialAccount: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $exists: true } } }
);
// One automated send per idempotency key (comment/DM reply) — a webhook retry
// re-uses the existing record instead of sending a duplicate.
messageSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } }
);

export const MessageModel = model<IMessage>('Message', messageSchema);
