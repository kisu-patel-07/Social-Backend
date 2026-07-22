import { Schema, model, Document, Types } from 'mongoose';

/**
 * One document per tracked-link click. TrackedLink keeps the cheap lifetime
 * counter; this event log is what makes clicks filterable by date range for
 * the per-automation funnel report.
 */
export interface ILinkClick extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  trackedLink: Types.ObjectId;
  /** Denormalized from the tracked link so funnel queries skip a join. */
  automation?: Types.ObjectId;
  studioAutomation?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const linkClickSchema = new Schema<ILinkClick>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    trackedLink: { type: Schema.Types.ObjectId, ref: 'TrackedLink', required: true },
    automation: { type: Schema.Types.ObjectId, ref: 'Automation' },
    studioAutomation: { type: Schema.Types.ObjectId, ref: 'StudioAutomation' },
  },
  { timestamps: true }
);

linkClickSchema.index({ workspace: 1, automation: 1, createdAt: -1 });
linkClickSchema.index({ workspace: 1, studioAutomation: 1, createdAt: -1 });

export const LinkClickModel = model<ILinkClick>('LinkClick', linkClickSchema);
