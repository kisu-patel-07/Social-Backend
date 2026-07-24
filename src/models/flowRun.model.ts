import { Schema, model, Document, Types } from 'mongoose';
import { FlowStep, Platform } from '../constants';

/**
 * Per-user state for a multi-step Studio DM flow. One document tracks a single
 * person's journey through an automation's flow (follow-gate → email → link →
 * optional follow-up). Advanced by button-click (postback) and text-reply
 * webhooks, and swept by the follow-up cron.
 */
export interface IFlowRun extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  socialAccount: Types.ObjectId;
  studioAutomation: Types.ObjectId;
  conversation?: Types.ObjectId;
  lead?: Types.ObjectId;
  platform: Platform;
  /** External id (PSID / IGSID) of the person moving through the flow. */
  participantId: string;
  step: FlowStep;
  /** Captured during the ask-email step. */
  email?: string;
  /** Per-run tracked-link slug, so this exact user's click can be attributed. */
  linkTrackingSlug?: string;
  linkSentAt?: Date;
  linkClicked: boolean;
  followUpSentAt?: Date;
  /** TTL — abandoned flows are cleaned up automatically. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const flowRunSchema = new Schema<IFlowRun>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    socialAccount: { type: Schema.Types.ObjectId, ref: 'SocialAccount', required: true },
    studioAutomation: { type: Schema.Types.ObjectId, ref: 'StudioAutomation', required: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    lead: { type: Schema.Types.ObjectId, ref: 'Lead' },
    platform: { type: String, enum: Object.values(Platform), required: true },
    participantId: { type: String, required: true },
    step: { type: String, enum: Object.values(FlowStep), required: true },
    email: { type: String },
    linkTrackingSlug: { type: String, index: true },
    linkSentAt: { type: Date },
    linkClicked: { type: Boolean, default: false },
    followUpSentAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One live flow per person per automation (re-triggering resets the same run).
flowRunSchema.index({ studioAutomation: 1, participantId: 1 }, { unique: true });
// Follow-up sweep: link-sent, unclicked, no-follow-up-yet, past the delay.
flowRunSchema.index({ step: 1, linkClicked: 1, followUpSentAt: 1, linkSentAt: 1 });
// TTL cleanup of abandoned flows (expiresAt in the past).
flowRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const FlowRunModel = model<IFlowRun>('FlowRun', flowRunSchema);
