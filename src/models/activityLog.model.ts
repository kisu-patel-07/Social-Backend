import { Schema, model, Document, Types } from 'mongoose';
import { ActivityAction } from '../constants';

/** Append-only audit trail of meaningful actions within a workspace. */
export interface IActivityLog extends Document {
  _id: Types.ObjectId;
  workspace: Types.ObjectId;
  /** Acting user; absent for system/webhook-driven events. */
  user?: Types.ObjectId;
  action: ActivityAction;
  /** Affected entity type + id, for filtering ("Lead", "Automation", ...). */
  entityType?: string;
  entityId?: Types.ObjectId;
  description: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    workspace: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, enum: Object.values(ActivityAction), required: true },
    entityType: { type: String },
    entityId: { type: Schema.Types.ObjectId },
    description: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: true }
);

activityLogSchema.index({ workspace: 1, createdAt: -1 });

export const ActivityLogModel = model<IActivityLog>('ActivityLog', activityLogSchema);
