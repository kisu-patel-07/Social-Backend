import { Schema, model, Document, Types } from 'mongoose';
import { ConversationStatus, Platform } from '../constants';

/**
 * A conversation groups all messages exchanged with a single external
 * participant on a given social account — the unit shown in the unified inbox.
 */
export interface IConversation extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  socialAccount: Types.ObjectId;
  platform: Platform;
  /** External participant (PSID / IGSID). */
  participantId: string;
  participantUsername?: string;
  participantName?: string;
  participantAvatarUrl?: string;
  status: ConversationStatus;
  lastMessageAt: Date;
  lastMessagePreview?: string;
  unreadCount: number;
  /** Optional link to the lead generated from this conversation. */
  lead?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    socialAccount: {
      type: Schema.Types.ObjectId,
      ref: 'SocialAccount',
      required: true,
      index: true,
    },
    platform: { type: String, enum: Object.values(Platform), required: true },
    participantId: { type: String, required: true, index: true },
    participantUsername: { type: String, trim: true },
    participantName: { type: String, trim: true },
    participantAvatarUrl: { type: String },
    status: {
      type: String,
      enum: Object.values(ConversationStatus),
      default: ConversationStatus.UNREAD,
      index: true,
    },
    lastMessageAt: { type: Date, default: () => new Date(), index: true },
    lastMessagePreview: { type: String, maxlength: 280 },
    unreadCount: { type: Number, default: 0 },
    lead: { type: Schema.Types.ObjectId, ref: 'Lead' },
  },
  { timestamps: true }
);

// One conversation per participant per social account.
conversationSchema.index({ socialAccount: 1, participantId: 1 }, { unique: true });
conversationSchema.index({ workspace: 1, status: 1, lastMessageAt: -1 });

export const ConversationModel = model<IConversation>('Conversation', conversationSchema);
