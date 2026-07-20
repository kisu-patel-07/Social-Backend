import { Schema, model, Document, Types } from 'mongoose';

/**
 * A short redirect link injected into automated DMs so automations can report
 * clicks (ROI), not just sends. One doc per (workspace, source, originalUrl).
 */
export interface ITrackedLink extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  /** Which automation produced the link (one of the two, or neither). */
  automation?: Types.ObjectId;
  studioAutomation?: Types.ObjectId;
  originalUrl: string;
  /** Short public code used in /r/:slug. */
  slug: string;
  clicks: number;
  lastClickedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const trackedLinkSchema = new Schema<ITrackedLink>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    automation: { type: Schema.Types.ObjectId, ref: 'Automation', index: true },
    studioAutomation: { type: Schema.Types.ObjectId, ref: 'StudioAutomation', index: true },
    originalUrl: { type: String, required: true, maxlength: 2000 },
    slug: { type: String, required: true, unique: true },
    clicks: { type: Number, default: 0 },
    lastClickedAt: { type: Date },
  },
  { timestamps: true }
);

trackedLinkSchema.index({ workspace: 1, automation: 1, originalUrl: 1 });
trackedLinkSchema.index({ workspace: 1, studioAutomation: 1, originalUrl: 1 });

export const TrackedLinkModel = model<ITrackedLink>('TrackedLink', trackedLinkSchema);
