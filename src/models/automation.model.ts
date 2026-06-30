import { Schema, model, Document, Types } from 'mongoose';
import { AutomationStatus, Platform } from '../constants';

export interface IAutomation extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  /** The connected social account this automation listens on. */
  socialAccount: Types.ObjectId;
  platform: Platform;
  name: string;
  /** Optional: restrict to a specific post/media; empty = all posts. */
  targetPostId?: string;
  publicReply: string;
  privateMessage: string;
  status: AutomationStatus;
  /** Denormalized keyword strings (lowercased) for fast matching at webhook time. */
  keywords: string[];
  /** Lifetime trigger counter for analytics/sorting. */
  triggerCount: number;
  lastTriggeredAt?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const automationSchema = new Schema<IAutomation>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    socialAccount: {
      type: Schema.Types.ObjectId,
      ref: 'SocialAccount',
      required: true,
      index: true,
    },
    platform: { type: String, enum: Object.values(Platform), required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    targetPostId: { type: String, trim: true },
    publicReply: { type: String, required: true, maxlength: 2000 },
    privateMessage: { type: String, required: true, maxlength: 2000 },
    status: {
      type: String,
      enum: Object.values(AutomationStatus),
      default: AutomationStatus.ACTIVE,
      index: true,
    },
    keywords: { type: [String], default: [], index: true },
    triggerCount: { type: Number, default: 0 },
    lastTriggeredAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

automationSchema.index({ workspace: 1, status: 1, createdAt: -1 });
automationSchema.index({ name: 'text' });

export const AutomationModel = model<IAutomation>('Automation', automationSchema);
