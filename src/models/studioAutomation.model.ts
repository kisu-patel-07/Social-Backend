import { Schema, model, Document, Types } from 'mongoose';
import { Platform, StudioAutomationStatus, StudioKeywordMode, StudioPostScope } from '../constants';

/** A call-to-action link button attached to the automated DM. */
export interface IStudioButton {
  title: string;
  url: string;
}

/**
 * Automation Studio (v2 trial) automation. Lives alongside the classic
 * Automation model without touching it. Differences vs. v1:
 *  - draft status (build now, launch later)
 *  - multiple target posts, explicit "all posts" scope
 *  - keyword mode: any comment / contains / exact word, plus exclude list
 *  - several public reply variations, rotated randomly per trigger
 *  - DM with up to 3 link buttons
 *  - optional "only DM each person once" guard
 */
export interface IStudioAutomation extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  socialAccount: Types.ObjectId;
  platform: Platform;
  name: string;
  status: StudioAutomationStatus;
  postScope: StudioPostScope;
  /** External post/media ids; only used when postScope = SPECIFIC. */
  postIds: string[];
  keywordMode: StudioKeywordMode;
  /** Lowercased keywords; required unless keywordMode = ANY. */
  keywords: string[];
  /** If a comment contains any of these, it never triggers. */
  excludeKeywords: string[];
  publicReplyEnabled: boolean;
  /** Reply variations — one is picked at random per trigger. */
  publicReplies: string[];
  dmMessage: string;
  dmButtons: IStudioButton[];
  /** Don't DM the same person twice from this automation. */
  oncePerUser: boolean;
  /** Template key this automation was created from (for analytics). */
  templateKey?: string;
  triggerCount: number;
  dmSentCount: number;
  lastTriggeredAt?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const studioButtonSchema = new Schema<IStudioButton>(
  {
    title: { type: String, required: true, trim: true, maxlength: 20 },
    url: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const studioAutomationSchema = new Schema<IStudioAutomation>(
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
    status: {
      type: String,
      enum: Object.values(StudioAutomationStatus),
      default: StudioAutomationStatus.DRAFT,
      index: true,
    },
    postScope: {
      type: String,
      enum: Object.values(StudioPostScope),
      default: StudioPostScope.ALL,
    },
    postIds: { type: [String], default: [] },
    keywordMode: {
      type: String,
      enum: Object.values(StudioKeywordMode),
      default: StudioKeywordMode.CONTAINS,
    },
    keywords: { type: [String], default: [], index: true },
    excludeKeywords: { type: [String], default: [] },
    publicReplyEnabled: { type: Boolean, default: true },
    publicReplies: { type: [String], default: [] },
    dmMessage: { type: String, required: true, maxlength: 2000 },
    dmButtons: { type: [studioButtonSchema], default: [] },
    oncePerUser: { type: Boolean, default: false },
    templateKey: { type: String, trim: true },
    triggerCount: { type: Number, default: 0 },
    dmSentCount: { type: Number, default: 0 },
    lastTriggeredAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

studioAutomationSchema.index({ workspace: 1, status: 1, createdAt: -1 });
studioAutomationSchema.index({ name: 'text' });

export const StudioAutomationModel = model<IStudioAutomation>(
  'StudioAutomation',
  studioAutomationSchema
);
