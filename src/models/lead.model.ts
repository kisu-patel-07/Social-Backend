import { Schema, model, Document, Types } from 'mongoose';
import { LeadStatus, Platform } from '../constants';

export interface ILead extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  socialAccount: Types.ObjectId;
  platform: Platform;
  /** External participant id (PSID / IGSID). */
  externalUserId: string;
  username?: string;
  name?: string;
  /** The post/media that the triggering comment was on. */
  postId?: string;
  /** Text of the comment that created the lead. */
  comment?: string;
  /** Conversation generated/linked from the automation. */
  conversation?: Types.ObjectId;
  /** Automation that generated this lead. */
  automation?: Types.ObjectId;
  /** Keyword that matched. */
  matchedKeyword?: string;
  status: LeadStatus;
  notes?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const leadSchema = new Schema<ILead>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    socialAccount: {
      type: Schema.Types.ObjectId,
      ref: 'SocialAccount',
      required: true,
      index: true,
    },
    platform: { type: String, enum: Object.values(Platform), required: true },
    externalUserId: { type: String, required: true, index: true },
    username: { type: String, trim: true },
    name: { type: String, trim: true },
    postId: { type: String },
    comment: { type: String, maxlength: 2000 },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    automation: { type: Schema.Types.ObjectId, ref: 'Automation' },
    matchedKeyword: { type: String },
    status: {
      type: String,
      enum: Object.values(LeadStatus),
      default: LeadStatus.NEW,
      index: true,
    },
    notes: { type: String, maxlength: 5000 },
    tags: { type: [String], default: [], index: true },
  },
  { timestamps: true }
);

// One lead per external user per social account (re-triggers update the same lead).
leadSchema.index({ socialAccount: 1, externalUserId: 1 }, { unique: true });
leadSchema.index({ workspace: 1, status: 1, createdAt: -1 });
leadSchema.index({ username: 'text', name: 'text', comment: 'text' });

export const LeadModel = model<ILead>('Lead', leadSchema);
